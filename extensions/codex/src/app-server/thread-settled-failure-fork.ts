import { isDeepStrictEqual } from "node:util";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import { closeCodexStartupClientBestEffort } from "./attempt-client-cleanup.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { isCodexAppServerOverloadError } from "./client.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThreadForkParams, CodexThreadStartParams, CodexTurn } from "./protocol.js";
import { CodexAppServerScopedRequestRejectedError } from "./rpc-error.js";
import { assertCodexBindingMayBeReplaced } from "./session-binding-record.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  buildCodexThreadBindingPolicy,
  resolveCodexThreadAgentDir,
} from "./thread-lifecycle-preflight.js";
import type {
  CodexStartOrResumeThreadParams,
  CodexStartThreadContext,
  CodexThreadFinalConfigPatchResult,
} from "./thread-lifecycle-types.js";
import { refreshCodexThreadPolicy } from "./thread-policy.js";
import { listCodexUpstreamTurns } from "./upstream-fork-boundary.js";

/** Fork only a managed, settled failure whose inherited tool authority is still current. */
export async function prepareCodexSettledFailureFork(
  params: CodexStartOrResumeThreadParams,
  context: CodexStartThreadContext,
  source: CodexAppServerThreadBinding,
  start: CodexThreadStartParams,
  plugin: CodexPluginThreadConfig | undefined,
  finalConfig: CodexThreadFinalConfigPatchResult,
  assertCurrent: () => void,
): Promise<CodexTurn[]> {
  assertCurrent();
  assertCodexBindingMayBeReplaced(
    source,
    "forking a settled failed thread",
    params.params.expectedSessionRuntimeOwnership,
  );
  if (
    params.appServer.start.transport !== "websocket" ||
    start.ephemeral ||
    source.preserveNativeModel ||
    source.pendingResumeConfiguration ||
    source.contextEngine ||
    context.contextEngineBinding ||
    context.ringZeroActive ||
    source.ringZeroClientInstanceId ||
    source.ringZeroConfigFingerprint ||
    context.ringZeroClientInstanceId ||
    context.ringZeroConfigFingerprint ||
    (await params.bindingStore.hasOtherThreadOwner(source.threadId, context.bindingIdentity)) ||
    !(await params.bindingStore.managedThreads?.has(
      codexCatalogHomeId(
        resolveCodexAppServerLocalHomeDir(
          params.appServer.start,
          resolveCodexThreadAgentDir(params),
        ),
      ),
      source.threadId,
    ))
  ) {
    throw new Error(
      "Cannot safely fork an unowned or protected failed Codex thread; its binding was preserved",
    );
  }
  // Fork inherits native tools and environments. Current config still goes through
  // normal creation and attestation; none of these durable authority checks can be skipped.
  const expected: Partial<CodexAppServerThreadBinding> = {
    ...buildCodexThreadBindingPolicy(params, context),
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
    mcpServersFingerprint: params.mcpServersFingerprintEvaluated
      ? params.mcpServersFingerprint
      : undefined,
    nativeHookRelayGeneration: finalConfig.nativeHookRelayGeneration,
    pluginAppsFingerprint: plugin?.fingerprint,
    pluginAppsInputFingerprint: plugin?.inputFingerprint,
    pluginAppPolicyContext: plugin?.policyContext,
    webSearchThreadConfigFingerprint: context.webSearchThreadConfigFingerprint,
    nativeToolPolicyRestricted: context.restrictedToolSurface ? true : undefined,
  };
  // SAFETY: This local object contains only the typed binding-policy fields constructed above.
  for (const key of Object.keys(expected) as (keyof CodexAppServerThreadBinding)[]) {
    if (!isDeepStrictEqual(source[key], expected[key])) {
      throw new Error(
        `Cannot fork a failed Codex thread after ${key} changed; its binding was preserved`,
      );
    }
  }
  const turns = await readCodexForkHistory(params, source.threadId, assertCurrent);
  if (
    turns.at(-1)?.status !== "failed" ||
    turns.some(
      (turn) =>
        !["completed", "failed", "interrupted"].includes(turn.status ?? "") ||
        turn.items.some((item) => item.status === "inProgress"),
    )
  ) {
    throw new Error(
      "Cannot fork Codex history without a settled terminal failure; its binding was preserved",
    );
  }
  return turns;
}

async function readCodexForkHistory(
  params: CodexStartOrResumeThreadParams,
  threadId: string,
  assertCurrent: () => void,
): Promise<CodexTurn[]> {
  const turns = await listCodexUpstreamTurns(
    {
      listTurnPage: (request) =>
        params.client.request("thread/turns/list", request, {
          signal: params.signal,
          assertCurrent,
          withCurrent: params.authority?.withCurrent,
        }),
    },
    threadId,
  );
  assertCurrent();
  return turns;
}

function assertCodexForkHistoryPreserved(source: CodexTurn[], fork: CodexTurn[]): void {
  const history = (turns: CodexTurn[]) =>
    turns.map(({ id, status, error, items }) => ({ id, status, error, items }));
  if (!isDeepStrictEqual(history(source), history(fork))) {
    throw new Error("Codex failed-thread fork did not preserve the complete recorded history");
  }
}

/** Native restores the old context baseline, so changed configuration alone is not model-visible. */
export async function completeCodexSettledFailureFork(
  params: CodexStartOrResumeThreadParams,
  sourceHistory: CodexTurn[] | undefined,
  threadId: string,
  developerInstructions: string,
  assertCurrent: () => void,
): Promise<void> {
  if (!sourceHistory) {
    return;
  }
  assertCodexForkHistoryPreserved(
    sourceHistory,
    await readCodexForkHistory(params, threadId, assertCurrent),
  );
  // Match ordinary resume/canonical fork: replace inherited generic instructions
  // explicitly before any new turn or binding commit, including removed sections.
  await refreshCodexThreadPolicy({
    client: params.client,
    threadId,
    developerInstructions,
    timeoutMs: params.appServer.requestTimeoutMs,
    signal: params.signal,
    assertCurrent,
    withCurrent: params.authority?.withCurrent,
  });
}

function buildCodexSettledFailureForkParams(
  threadId: string,
  start: CodexThreadStartParams,
): CodexThreadForkParams {
  // Explicitly select native fork fields: no rollback boundary, tool replacement,
  // or old turn input. Native inherits the entire recorded history and tool results.
  return {
    threadId,
    ...(start.model !== undefined ? { model: start.model } : {}),
    ...(start.modelProvider !== undefined ? { modelProvider: start.modelProvider } : {}),
    ...(start.serviceTier !== undefined ? { serviceTier: start.serviceTier } : {}),
    ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
    ...(start.runtimeWorkspaceRoots !== undefined
      ? { runtimeWorkspaceRoots: start.runtimeWorkspaceRoots }
      : {}),
    ...(start.approvalPolicy !== undefined ? { approvalPolicy: start.approvalPolicy } : {}),
    ...(start.approvalsReviewer !== undefined
      ? { approvalsReviewer: start.approvalsReviewer }
      : {}),
    ...(start.sandbox !== undefined ? { sandbox: start.sandbox } : {}),
    config: { ...start.config, ...(start.personality ? { personality: start.personality } : {}) },
    ...(typeof start.permissions === "string" ? { permissions: start.permissions } : {}),
    ...(typeof start.baseInstructions === "string"
      ? { baseInstructions: start.baseInstructions }
      : {}),
    ...(start.developerInstructions !== undefined
      ? { developerInstructions: start.developerInstructions }
      : {}),
    ...(start.threadSource !== undefined ? { threadSource: start.threadSource } : {}),
    excludeTurns: true,
    deferGoalContinuation: true,
  };
}

/** A fork can be created before native metadata/read-back fails, including an RPC error. */
export async function requestCodexSettledFailureFork(
  params: CodexStartOrResumeThreadParams,
  sourceThreadId: string,
  start: CodexThreadStartParams,
  assertCurrent: () => void,
) {
  try {
    assertCurrent();
    const response = assertCodexThreadForkResponse(
      await params.client.request(
        "thread/fork",
        buildCodexSettledFailureForkParams(sourceThreadId, start),
        {
          signal: params.signal,
          assertCurrent,
          withCurrent: params.authority?.withCurrent,
        },
      ),
    );
    if (response.thread.id === sourceThreadId) {
      throw new Error("Codex failed-thread fork reused its source identity");
    }
    return response;
  } catch (error) {
    if (isCodexAppServerOverloadError(error)) {
      throw error;
    }
    if (!(error instanceof CodexAppServerScopedRequestRejectedError)) {
      // Without a confirmed distinct identity there is nothing safe to delete.
      // Retirement detaches future acquisitions while existing sibling leases drain.
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
    }
    throw new Error(
      `Codex failed-thread fork was not confirmed: ${error instanceof Error ? error.message : String(error)}; its binding was preserved`,
      { cause: error },
    );
  }
}
