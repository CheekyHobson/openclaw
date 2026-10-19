import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as dynamicToolExecution from "./dynamic-tool-execution.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { isJsonObject, type CodexTurn, type RpcMessage } from "./protocol.js";
import {
  createRuntimeDynamicTool,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { createClientHarness } from "./test-support.js";

setupRunAttemptTestHooks();

function installRemoteTurn() {
  const accepted = createDeferred<void>();
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  const resumed = createDeferred<void>();
  const resultAccepted = createDeferred<void>();
  const toolAborted = createDeferred<void>();
  let toolWasAborted = false;
  let toolExecutionSignal: AbortSignal | undefined;
  const params = createTestParams();
  // The real worker-backed harness takes about 7.5s to prepare cold. Keep real
  // absolute execution/RPC deadlines while allowing that setup within this run.
  params.timeoutMs = 20_000;
  const fixtureStartedAt = performance.now();
  const timeline: string[] = [];
  const trace = (event: string) =>
    timeline.push(`${Math.round(performance.now() - fixtureStartedAt)}ms:${event}`);
  params.onExecutionPhase = (event) => {
    trace(`phase:${event.phase}`);
    if (event.phase === "turn_accepted") {
      accepted.resolve();
    }
  };
  const faults = {
    unavailable: false,
    restarted: false,
    revoked: false,
    holdRead: false,
    dropStartAck: false,
    closeAfterResume: false,
    suppressFirstTool: false,
    dropToolResult: false,
  };
  const readRequested = createDeferred<void>();
  const cancel = new AbortController();
  const cancellations = [cancel];
  params.abortSignal = cancel.signal;
  let releaseRead = () => {};
  params.hostCapabilities = createCodexTestHostCapabilities({
    assertActive: () => {
      if (faults.revoked) {
        throw new Error("fixture host authority revoked");
      }
    },
  });
  const execute = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
    toolExecutionSignal = signal;
    const abort = () => {
      toolWasAborted = true;
      toolAborted.resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    started.resolve();
    await Promise.race([finish.promise, toolAborted.promise]);
    signal?.removeEventListener("abort", abort);
    signal?.throwIfAborted();
    return { content: [{ type: "text" as const, text: "effect completed once" }], details: {} };
  });
  setCodexTestToolFactory(params, () => [{ ...createRuntimeDynamicTool("write_once"), execute }]);
  setCodexTestModelSupportsTools(params, true);
  const wires: ReturnType<typeof createClientHarness>[] = [];
  const wireAt = (index: number) => {
    const wire = wires[index];
    if (!wire) {
      throw new Error(`Missing Codex fixture connection ${index}`);
    }
    return wire;
  };
  let currentTurn: CodexTurn = turnStartResult().turn;
  let threadId = "thread-1";
  let starts = 0;
  let threadStarts = 0;
  const native = () => ({
    ...threadStartResult(threadId),
    thread: {
      ...threadStartResult(threadId).thread,
      status: {
        activeFlags: [],
        type: faults.restarted
          ? "notLoaded"
          : currentTurn.status === "inProgress"
            ? "active"
            : "idle",
      },
      turns: [currentTurn],
    },
  });
  const toolRequest = {
    id: "pending-tool",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "write-once",
      namespace: null,
      tool: "write_once",
      arguments: {},
    },
  };
  setCodexAppServerClientFactoryForTest(async () => {
    if (faults.unavailable) {
      throw new Error("fixture remote app-server unavailable");
    }
    const existing = wires.at(-1);
    if (existing && !existing.client.getCloseError()) {
      return existing.client;
    }
    const wire = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as RpcMessage;
        trace("method" in message ? message.method : `response:${message.id}`);
        if (!("method" in message)) {
          if (message.id === toolRequest.id) {
            expect("result" in message && message.result).toMatchObject({ success: true });
            if (faults.dropToolResult && wires.length === 1) {
              wire.process.emit("error", new Error("WebSocket closed before result delivery"));
              return;
            }
            resultAccepted.resolve();
            currentTurn = turnStartResult("turn-1", "completed").turn;
            send({ method: "turn/completed", params: { threadId, turn: currentTurn } });
          }
          return;
        }
        let result: unknown = {};
        if (message.method === "initialize") {
          result = { userAgent: "codex-cli/0.153.4" };
        } else if (message.method === "config/read") {
          result = { config: {}, origins: {}, layers: [] };
        } else if (message.method === "configRequirements/read") {
          result = { requirements: null };
        } else if (message.method === "thread/start") {
          threadStarts += 1;
          threadId = `thread-${threadStarts}`;
          result = threadStartResult(threadId);
        } else if (message.method === "thread/read") {
          result = { thread: native().thread };
          if (faults.holdRead) {
            releaseRead = () => send({ id: message.id, result });
            readRequested.resolve();
            return;
          }
        } else if (message.method === "thread/resume") {
          result = native();
          if (currentTurn.status === "inProgress") {
            expect(message.params).toEqual({ threadId: "thread-1" });
            // Native 0.153.4 responds before replaying pending server requests.
            send({ id: message.id, result });
            if (faults.closeAfterResume) {
              wire.process.emit("error", new Error("WebSocket closed during recovery"));
              return;
            }
            send(toolRequest);
            resumed.resolve();
            return;
          }
        } else if (message.method === "turn/start") {
          starts += 1;
          currentTurn = turnStartResult(`turn-${starts}`).turn;
          if (faults.dropStartAck && starts === 1) {
            wire.process.emit("error", new Error("WebSocket closed with code 1006"));
            return;
          }
          send({ id: message.id, result: { turn: currentTurn } });
          if (starts === 1) {
            if (!faults.suppressFirstTool) {
              send(toolRequest);
            }
          } else {
            currentTurn = turnStartResult(`turn-${starts}`, "completed").turn;
            send({ method: "turn/completed", params: { threadId, turn: currentTurn } });
          }
          return;
        } else if (message.method === "thread/backgroundTerminals/list") {
          result = { data: [], nextCursor: null };
        } else if (message.method === "thread/unsubscribe") {
          result = { status: "unsubscribed" };
        }
        if (message.id !== undefined) {
          send({ id: message.id, result });
        }
      },
    });
    wires.push(wire);
    await wire.client.initialize();
    return wire.client;
  });
  onTestFinished(async () => {
    vi.useRealTimers();
    for (const controller of cancellations) {
      controller.abort("test cleanup");
    }
    finish.resolve();
    await Promise.all(wires.map(({ client }) => client.closeAndWait()));
  });
  const options = {
    pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:19400" } },
  };
  const observe = <T>(promise: Promise<T>, phase: string) =>
    promise.catch((cause: unknown) => {
      throw new Error(`${phase}: ${String(cause)}; timeline=${timeline.join(",")}`, { cause });
    });
  const run = observe(runCodexAppServerAttempt(params, options), "original attempt");
  return {
    params,
    faults,
    cancel,
    readRequested,
    releaseRead: () => releaseRead(),
    run,
    accepted,
    started,
    finish,
    resumed,
    resultAccepted,
    toolAborted,
    wireAt,
    execute,
    counts: () => ({ starts, threadStarts }),
    wasToolAborted: () => toolWasAborted,
    isToolSignalAborted: () => toolExecutionSignal?.aborted,
    stopNative: () => {
      currentTurn = turnStartResult("turn-1", "interrupted").turn;
      currentTurn.items = [
        {
          id: "write-once",
          type: "dynamicToolCall",
          tool: "write_once",
          status: "failed",
          success: false,
          contentItems: [],
          title: null,
          name: null,
          server: null,
          command: null,
          cwd: null,
          query: null,
          aggregatedOutput: null,
          text: "",
          changes: [],
        },
      ];
    },
    disconnect: () => wireAt(0).process.emit("error", new Error("WebSocket closed with code 1006")),
    next: () => {
      trace("new request");
      const nextCancellation = new AbortController();
      cancellations.push(nextCancellation);
      return observe(
        runCodexAppServerAttempt(
          {
            ...params,
            runId: "run-next",
            prompt: "new request",
            abortSignal: nextCancellation.signal,
          },
          options,
        ),
        "new request",
      );
    },
    methods: () =>
      wires
        .flatMap(({ writes }) => writes.map((line) => JSON.parse(line) as unknown))
        .filter(isJsonObject)
        .map((message) => message.method)
        .filter((method): method is string => typeof method === "string"),
  };
}

async function waitForCheckpoint(
  fixture: ReturnType<typeof installRemoteTurn>,
  checkpoint: Promise<void>,
  phase: string,
) {
  await Promise.race([
    checkpoint,
    fixture.run.then((result) => {
      throw new Error(
        `${phase}: attempt ended (${String(readAttemptTerminal(result).promptError)}); methods=${fixture.methods().join(",")}`,
      );
    }),
  ]);
}

const reachTool = (fixture: ReturnType<typeof installRemoteTurn>) =>
  waitForCheckpoint(fixture, fixture.started.promise, "tool execution");
const reachRecovery = (fixture: ReturnType<typeof installRemoteTurn>) =>
  waitForCheckpoint(fixture, fixture.resumed.promise, "active turn recovery");

describe("Codex active remote turn recovery", () => {
  it("rejoins its original turn without repeating the tool effect, then accepts a new request", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    expect(fixture.wasToolAborted()).toBe(false);
    fixture.finish.resolve();
    await waitForCheckpoint(fixture, fixture.resultAccepted.promise, "replayed result acceptance");
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts()).toEqual({ starts: 1, threadStarts: 1 });
    expect(fixture.wasToolAborted()).toBe(false);
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 1 });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.methods()).not.toContain("turn/interrupt");
  });

  it.each(["unavailable", "restarted", "closeAfterResume"] as const)(
    "isolates %s native work and permits a new user request",
    async (fault) => {
      const fixture = installRemoteTurn();
      await reachTool(fixture);
      fixture.faults[fault] = true;
      fixture.disconnect();
      const result = await fixture.run;
      const failed = readAttemptTerminal(result);
      expect(failed.promptError).toBeDefined();
      expect(result.replayMetadata).toMatchObject({
        hadPotentialSideEffects: true,
        replaySafe: false,
      });
      expect(result.codexAppServerFailure).toMatchObject({
        kind: "client_closed_before_turn_completed",
        replaySafe: false,
      });
      expect(failed.timedOut).toBe(false);
      expect(fixture.wasToolAborted()).toBe(true);
      expect(fixture.methods().filter((method) => method === "thread/resume")).toHaveLength(
        fault === "closeAfterResume" ? 1 : 0,
      );
      expect(fixture.counts().starts).toBe(1);
      fixture.faults[fault] = false;
      expect(readAttemptTerminal(await fixture.next())).toMatchObject({
        aborted: false,
        timedOut: false,
      });
      expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 2 });
      expect(fixture.execute).toHaveBeenCalledOnce();
    },
  );

  it("does not replay an accepted turn whose native effects could not be observed", async () => {
    const fixture = installRemoteTurn();
    fixture.faults.suppressFirstTool = true;
    await waitForCheckpoint(fixture, fixture.accepted.promise, "accepted native turn");
    fixture.faults.unavailable = true;
    fixture.disconnect();
    const result = await fixture.run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    expect(result.toolMetas).toHaveLength(0);
    expect(result.replayMetadata).toMatchObject({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(result.codexAppServerFailure).toMatchObject({
      kind: "client_closed_before_turn_completed",
      replaySafe: false,
      replayBlockedReason: "potential_side_effect",
    });
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(fixture.counts().starts).toBe(1);
    fixture.faults.unavailable = false;
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 2 });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("cancels pending work when the recovered terminal snapshot lost its resolution notification", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    fixture.stopNative();
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(fixture.wasToolAborted()).toBe(true);
    expect(fixture.isToolSignalAborted()).toBe(true);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
    expect(fixture.methods().filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not cancel a completed execution when its lost result is resolved on replay", async () => {
    const executions = vi.spyOn(dynamicToolExecution, "handleDynamicToolCallWithTimeout");
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.dropToolResult = true;
    fixture.finish.resolve();
    await reachRecovery(fixture);
    // The tool-facing child signal closes normally after result release. Check
    // the retained execution owner instead, without replacing actual execution.
    const executionSignal = executions.mock.calls[0]?.[0].signal;
    expect(executionSignal?.aborted).toBe(false);
    fixture.wireAt(1).send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "pending-tool" },
    });
    fixture.wireAt(1).send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turnStartResult("turn-1", "completed").turn },
    });
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(executionSignal?.aborted).toBe(false);
    expect(executions).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("propagates native resolution of a replay to the original in-flight tool", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    // Resolve immediately after native resume, before the asynchronous binding
    // admission barrier can deliver the replay to its attempt handler.
    fixture.wireAt(1).send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "pending-tool" },
    });
    await waitForCheckpoint(fixture, fixture.toolAborted.promise, "native tool cancellation");
    fixture.wireAt(1).send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: turnStartResult("turn-1", "completed").turn },
    });
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({ timedOut: false });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
  });

  it("ignores resolutions for another thread or unknown request during recovery", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.disconnect();
    await reachRecovery(fixture);
    for (const params of [
      { threadId: "sibling-thread", requestId: "pending-tool" },
      { threadId: "thread-1", requestId: "unknown-request" },
    ]) {
      fixture.wireAt(1).send({ method: "serverRequest/resolved", params });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(fixture.wasToolAborted()).toBe(false);
    fixture.finish.resolve();
    expect(readAttemptTerminal(await fixture.run)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("cancels while reconnecting without replaying work or blocking the next request", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.holdRead = true;
    fixture.disconnect();
    await waitForCheckpoint(fixture, fixture.readRequested.promise, "replacement read");
    fixture.cancel.abort("user cancelled");
    await expect(fixture.run).rejects.toThrow(
      "Codex cancellation could not confirm the turn stopped",
    );
    expect(fixture.wasToolAborted()).toBe(true);
    expect(fixture.methods()).not.toContain("thread/resume");
    fixture.faults.holdRead = false;
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 2 });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not replay an unacknowledged turn start and permits a later new request", async () => {
    const fixture = installRemoteTurn();
    fixture.faults.dropStartAck = true;
    const result = await fixture.run;
    expect(readAttemptTerminal(result).promptError).toBeDefined();
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(result.codexAppServerFailure).toMatchObject({ replaySafe: false });
    expect(fixture.counts()).toEqual({ starts: 1, threadStarts: 1 });
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(readAttemptTerminal(await fixture.next())).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(fixture.counts()).toEqual({ starts: 2, threadStarts: 2 });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not resume or execute again after its host authority is revoked", async () => {
    const fixture = installRemoteTurn();
    await reachTool(fixture);
    fixture.faults.holdRead = true;
    fixture.disconnect();
    await waitForCheckpoint(fixture, fixture.readRequested.promise, "replacement read");
    fixture.faults.revoked = true;
    fixture.releaseRead();
    await fixture.run.catch(() => undefined);
    fixture.faults.revoked = false;
    expect(fixture.methods()).not.toContain("thread/resume");
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.counts().starts).toBe(1);
  });
});
