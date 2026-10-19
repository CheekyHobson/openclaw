import type { SessionEntry } from "./types.js";

/** A new incarnation retains the logical session's execution restrictions and placement. */
export function preserveSessionExecutionContext(entry: SessionEntry | undefined) {
  return {
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
