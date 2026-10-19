import type { SessionEntry } from "./types.js";

/** A new incarnation retains the logical session's execution choices and placement. */
export function preserveSessionExecutionContext(entry: SessionEntry | undefined) {
  return {
    chatType: entry?.chatType,
    contextWindow: entry?.contextWindow,
    thinkingLevel: entry?.thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    ttsAuto: entry?.ttsAuto,
    responseUsage: entry?.responseUsage,
    queueMode: entry?.queueMode,
    queueDebounceMs: entry?.queueDebounceMs,
    queueCap: entry?.queueCap,
    queueDrop: entry?.queueDrop,
    completionOwnerSessionKey: entry?.completionOwnerSessionKey,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    sessionRoot: entry?.sessionRoot,
    permissionMode: entry?.permissionMode,
    sandboxMode: entry?.sandboxMode,
    worktree: entry?.worktree,
    projectId: entry?.projectId,
    repositoryWorkspaceId: entry?.repositoryWorkspaceId,
    deviceFolder: entry?.deviceFolder ? { ...entry.deviceFolder } : undefined,
    toolOverrides: entry?.toolOverrides,
    elevatedLevel: entry?.elevatedLevel,
    execHost: entry?.execHost,
    execNode: entry?.execNode,
    execCwd: entry?.execCwd,
    sendPolicy: entry?.sendPolicy,
  };
}
