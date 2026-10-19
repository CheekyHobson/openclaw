// Synthetic persisted chat history through the real compressed Control UI WebSocket path.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    entry: { type: "string", default: "openclaw.mjs" },
    port: { type: "string", default: "19653" },
    samples: { type: "string", default: "11" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
const sessionId = "chat-history-measure-820";
const sessionKey = `agent:main:${sessionId}`;
const fixtureFormat = "openclaw-chat-history-measure-v1";
const fixtureEpoch = 1_792_281_600_000;
const token = "synthetic-chat-history-measure-token";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function syntheticText(message: number, size: number): string {
  let result = `Synthetic transcript message ${message}.\n`;
  for (let index = 0; result.length < size; index++) {
    result += `${digest(`${message}:${index}`)}\n`;
  }
  return result.slice(0, size);
}

function fixtureMessages() {
  return Array.from({ length: 820 }, (_, index) => {
    const toolCallId = `synthetic-tool-${Math.floor(index / 4)}`;
    const common = { timestamp: fixtureEpoch + index * 1000 };
    const message =
      index % 4 === 0
        ? { ...common, role: "user", content: [{ type: "text", text: syntheticText(index, 4800) }] }
        : index % 4 === 1
          ? {
              ...common,
              role: "assistant",
              content: [
                { type: "text", text: syntheticText(index, 2500) },
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "read",
                  arguments: {
                    path: `synthetic-${index}.txt`,
                    context: syntheticText(index, 1000),
                  },
                },
              ],
              stopReason: "toolUse",
            }
          : index % 4 === 2
            ? {
                ...common,
                role: "toolResult",
                toolCallId,
                toolName: "read",
                content: [{ type: "text", text: syntheticText(index, 6000) }],
                isError: false,
              }
            : {
                ...common,
                role: "assistant",
                content: [{ type: "text", text: syntheticText(index, 1600) }],
                stopReason: "stop",
              };
    return { eventId: `synthetic-message-${index}`, now: common.timestamp, message };
  });
}

function configFor(root: string, port: number): OpenClawConfig {
  const workspace = path.join(root, "workspace");
  return {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      ownership: "explicit",
      defaults: { workspace, systemAgent: { agentId: "main" } },
      entries: { main: { workspace, identity: { name: "Synthetic history assistant" } } },
    },
    cron: { enabled: false },
    plugins: { enabled: false },
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      port,
      auth: { mode: "token", token },
      controlUi: {
        enabled: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
        dangerouslyDisableDeviceAuth: true,
      },
    },
  };
}

async function seed(root: string, port: number) {
  mkdirSync(root);
  for (const directory of ["home", "tmp", "workspace"]) {
    mkdirSync(path.join(root, directory));
  }
  const config = configFor(root, port);
  writeFileSync(path.join(root, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
  const env = fixtureEnv(root);
  const previousEnv = process.env;
  process.env = env;
  try {
    const { createSessionEntryWithTranscript, appendTranscriptMessages } =
      await import("../../src/config/sessions/session-accessor.ts");
    const { drainGlobalSingletonLifecycleState } =
      await import("../../src/shared/global-singleton.ts");
    try {
      const { captureRuntimeConfigAsyncReader } = await import("../../src/config/io.runtime.ts");
      await captureRuntimeConfigAsyncReader()();
      const scope = { agentId: "main", sessionKey, sessionId, env };
      const created = await createSessionEntryWithTranscript(scope, () => ({
        ok: true,
        entry: {
          sessionId,
          createdAt: fixtureEpoch,
          updatedAt: fixtureEpoch,
          createdVia: "operator",
          lifecycleRevision: "synthetic-history-v1",
          visibility: "shared",
          label: "Synthetic tool-heavy history",
        },
      }));
      assert.ok(created.ok, "Synthetic session creation failed");
      const messages = fixtureMessages();
      await appendTranscriptMessages(scope, { config, messages });
      const summary = {
        format: fixtureFormat,
        sessionId,
        sessionKey,
        messages: messages.length,
        sourceMessageBytes: Buffer.byteLength(JSON.stringify(messages.map((item) => item.message))),
      };
      writeFileSync(
        path.join(root, "chat-history-fixture.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      console.log(JSON.stringify(summary));
    } finally {
      await drainGlobalSingletonLifecycleState();
    }
  } finally {
    process.env = previousEnv;
  }
}

function fixtureEnv(root: string): NodeJS.ProcessEnv {
  return createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_PROFILE: "chat-history-measure",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-chat-history-measure",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.chat-history-measure",
      OPENCLAW_SKIP_CHANNELS: "1",
      TMPDIR: path.join(root, "tmp"),
    },
  });
}

const variants = [
  {
    name: "older-offset-0",
    method: "chat.history",
    params: { offset: 0, limit: 1000, maxBytes: 2 * 1024 * 1024 },
  },
  {
    name: "older-offset-661",
    method: "chat.history",
    params: { offset: 661, limit: 1000, maxBytes: 2 * 1024 * 1024 },
  },
  { name: "startup", method: "chat.startup", params: { limit: 80, maxBytes: 256 * 1024 } },
  {
    name: "history-startup-sized",
    method: "chat.history",
    params: { limit: 80, maxBytes: 256 * 1024 },
  },
] as const;

type RequestMeasurement = {
  sample: number;
  variant: string;
  method: string;
  params: object;
  elapsedMs: number;
  responseBytes: number;
  payloadBytes: number;
  payloadHash: string;
  semanticHash: string;
  frameHashWithoutRequestId: string;
  messages: number;
};

function readJsonLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(isRecord(value), `Invalid diagnostic row in ${file}`);
      return value;
    });
}

async function measure(root: string, port: number, samples: number) {
  const fixture: unknown = JSON.parse(
    readFileSync(path.join(root, "chat-history-fixture.json"), "utf8"),
  );
  assert.ok(
    isRecord(fixture) && fixture.format === fixtureFormat,
    "Expected an owned synthetic fixture; run --seed first",
  );
  const entry = path.resolve(values.entry);
  assert.ok(existsSync(entry), `Missing Gateway entry: ${entry}; build on the benchmark host`);
  if (path.basename(entry) === "openclaw.mjs") {
    assert.ok(
      existsSync(path.join(path.dirname(entry), "dist/entry.js")),
      "Gateway runtime is not built; prepare it on the benchmark host",
    );
  }
  const output = path.resolve(values.output ?? path.join(root, `measurement-${Date.now()}`));
  mkdirSync(output);
  const timelinePath = path.join(output, "timeline.jsonl");
  const rpcPath = path.join(output, "rpc.jsonl");
  const preloadPath = path.join(output, "diagnostics-preload.mjs");
  const runtimeConfigPath = path.join(output, "openclaw.json");
  writeFileSync(runtimeConfigPath, `${JSON.stringify(configFor(root, port), null, 2)}\n`);
  writeFileSync(rpcPath, "");
  writeFileSync(
    preloadPath,
    `import { appendFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { onInternalDiagnosticEvent } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/diagnostic-events.ts")).href)};
if (isMainThread) onInternalDiagnosticEvent(event => {
  if (event.type === 'gateway.rpc' && (event.method === 'chat.history' || event.method === 'chat.startup')) {
    const { method, phase, durationMs, admissionMs, responseBytes, outcome, ts } = event;
    appendFileSync(${JSON.stringify(rpcPath)}, JSON.stringify({ method, phase, durationMs, admissionMs, responseBytes, outcome, ts }) + '\\n');
  }
}, { include: ['gateway.rpc'] });
`,
  );
  const log = createWriteStream(path.join(output, "gateway.log"));
  let gateway: ChildProcess | undefined;
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      client?.close();
      if (gateway) await stopChild(gateway, { teardownGraceMs: 15_000, killGraceMs: 2_000 });
      await new Promise<void>((resolve) => log.end(resolve));
    })());
  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const records: RequestMeasurement[] = [];
  try {
    gateway = spawn(
      process.execPath,
      [
        "--cpu-prof",
        `--cpu-prof-dir=${output}`,
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--import",
        preloadPath,
        entry,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--auth",
        "token",
        "--token",
        token,
        "--allow-unconfigured",
      ],
      {
        env: {
          ...fixtureEnv(root),
          OPENCLAW_CONFIG_PATH: runtimeConfigPath,
          OPENCLAW_DIAGNOSTICS: "timeline",
          OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    gateway.stdout?.pipe(log, { end: false });
    gateway.stderr?.pipe(log, { end: false });
    let startup = "";
    gateway.stdout?.on("data", (chunk: Buffer) => {
      startup = (startup + chunk.toString()).slice(-8192);
    });
    gateway.stderr?.on("data", (chunk: Buffer) => {
      startup = (startup + chunk.toString()).slice(-8192);
    });
    const deadline = Date.now() + 180_000;
    while (true) {
      assert.ok(
        gateway.exitCode === null && gateway.signalCode === null && Date.now() < deadline,
        `Gateway startup failed; inspect ${output}`,
      );
      if (
        startup.includes("http server listening (") &&
        (await fetch(`http://127.0.0.1:${port}/readyz`).then(
          (response) => response.ok,
          () => false,
        ))
      )
        break;
      await delay(250);
    }
    client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });
    const rawResponses = new Map<string, string>();
    client.ws.on("message", (data) => {
      const raw = data.toString();
      const frame: unknown = JSON.parse(raw);
      if (isRecord(frame) && frame.type === "res" && typeof frame.id === "string")
        rawResponses.set(frame.id, raw);
    });
    await client.waitOpen();
    assert.ok(
      client.ws.extensions.includes("permessage-deflate"),
      "Compression was not negotiated",
    );
    const connected = await client.request(
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "openclaw-control-ui",
          version: "synthetic-benchmark",
          platform: "web",
          mode: "ui",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: [],
        auth: { token },
      },
      60_000,
    );
    assert.ok(connected.ok, `Synthetic connect rejected: ${JSON.stringify(connected.error)}`);
    rawResponses.clear();
    for (let sample = -1; sample < samples; sample++) {
      for (const variant of variants) {
        const params = { sessionKey, agentId: "main", toolResultMaxChars: 2000, ...variant.params };
        const started = performance.now();
        const response = await client.request(variant.method, params, 60_000);
        const elapsedMs = performance.now() - started;
        assert.ok(
          response.ok && isRecord(response.payload),
          `History request failed: ${JSON.stringify(response.error)}`,
        );
        const payload = response.payload;
        assert.ok(
          Array.isArray(payload.messages) && payload.messages.length > 0,
          "History fixture returned no messages",
        );
        const raw = rawResponses.get(response.id);
        assert.ok(raw, "Missing raw response frame");
        rawResponses.delete(response.id);
        const payloadJson = JSON.stringify(payload);
        const semantic = { ...payload };
        if (isRecord(payload.sessionInfo)) {
          const { snapshotAt: _snapshotAt, ...sessionInfo } = payload.sessionInfo;
          semantic.sessionInfo = sessionInfo;
        }
        records.push({
          sample,
          variant: variant.name,
          method: variant.method,
          params,
          elapsedMs,
          responseBytes: Buffer.byteLength(raw),
          payloadBytes: Buffer.byteLength(payloadJson),
          payloadHash: digest(payloadJson),
          semanticHash: digest(JSON.stringify(semantic)),
          frameHashWithoutRequestId: digest(
            raw.replace(`"id":${JSON.stringify(response.id)}`, '"id":"request"'),
          ),
          messages: payload.messages.length,
        });
      }
    }
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const rpc = readJsonLines(rpcPath).filter((row) => row.phase === "handler");
  assert.equal(rpc.length, records.length, "Missing or unexpected Gateway handler diagnostics");
  const timeline = readJsonLines(timelinePath);
  const groups: Array<{ method: string; spans: Record<string, number> }> = [];
  for (const event of timeline) {
    if (typeof event.name !== "string") continue;
    const entry = /^gateway\.(chat\.(?:history|startup))\.session_entry$/.exec(event.name);
    if (entry && event.type === "span.start") groups.push({ method: entry[1]!, spans: {} });
    const current = groups.at(-1);
    if (
      current &&
      event.type === "span.end" &&
      event.name.startsWith(`gateway.${current.method}.`) &&
      typeof event.durationMs === "number"
    ) {
      const phase = event.name.slice(`gateway.${current.method}.`.length);
      current.spans[phase] = (current.spans[phase] ?? 0) + event.durationMs;
    }
  }
  assert.equal(
    groups.length,
    records.length,
    "Missing or unexpected history timeline request groups",
  );
  const results = records.map((record, index) => {
    const handler = rpc[index]!;
    const group = groups[index]!;
    assert.equal(handler.method, record.method);
    assert.equal(group.method, record.method);
    return {
      ...record,
      handlerMs: handler.durationMs,
      admissionMs: handler.admissionMs,
      phases: group.spans,
    };
  });
  const report = {
    format: fixtureFormat,
    fixture,
    node: process.version,
    platform: process.platform,
    extensions: "permessage-deflate",
    entry,
    port,
    samples,
    output,
    cpuProfiles: readdirSync(output).filter((name) => name.endsWith(".cpuprofile")),
    warmup: results.filter((record) => record.sample === -1),
    results: results.filter((record) => record.sample !== -1),
  };
  assert.ok(report.cpuProfiles.length > 0, "Gateway did not write its CPU profile");
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/perf/chat-history-measure.ts --state-dir <new-fixture> --seed\nThen repeat without --seed [--entry openclaw.mjs] [--port 19653] [--samples 11] [--output <new-directory>]. All state is synthetic; build the Gateway on the benchmark host first.",
  );
} else {
  assert.ok(values["state-dir"], "--state-dir is required");
  const port = parseStrictIntegerOption({
    raw: values.port,
    label: "--port",
    min: 19600,
    fallback: 19653,
  });
  assert.ok(port <= 19699, "--port must be in 19600–19699");
  const samples = parseStrictIntegerOption({
    raw: values.samples,
    label: "--samples",
    min: 1,
    fallback: 11,
  });
  const root = path.resolve(values["state-dir"]);
  if (values.seed) await seed(root, port);
  else await measure(root, port, samples);
}
