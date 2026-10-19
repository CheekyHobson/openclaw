import { randomUUID } from "node:crypto";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionAccessScope,
} from "../config/sessions/session-accessor.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "../config/sessions/session-entry-lineage.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { preserveCreationStamp } from "../config/sessions/session-entry-provenance.js";
import {
  readSessionEntryByIdReadOnlyInWorker,
  readSessionEntryReadOnlyInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  runWithSessionSourceScope,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionWorkStartBlock } from "../config/sessions/session-work-start.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginSessionOwnershipError } from "../gateway/session-plugin-ownership.js";
import { resolveSessionStoreIdentity } from "../gateway/session-store-key.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { isSubagentSessionKey } from "../routing/session-key.js";

/** Replace an automation-owned archived subagent incarnation, retaining its transcript lineage. */
export async function replaceArchivedSubagentSession(params: {
  sessionKey: string;
  getConfig: () => OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const cfg = params.getConfig();
  const { agentId, canonicalKey: sessionKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: params.sessionKey,
  });
  if (!isSubagentSessionKey(sessionKey)) {
    throw new Error("Only automation-owned subagent sessions can be replaced after archival.");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent], (assertSources) => {
    assertSources();
    if (params.getConfig() !== cfg) {
      throw new Error("Session configuration changed before archived worker replacement. Retry.");
    }
  });
  assertCurrent();
  const entry = await readSessionEntryReadOnlyInWorker({ agentId, sessionKey, storePath });
  assertCurrent();
  if (entry?.archivedAt === undefined) {
    return false;
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId = scope?.pluginId?.trim();
  if (!pluginId) {
    throw new Error("Archived worker replacement requires an active plugin request identity.");
  }
  const { runWithInProcessGatewaySessionMutation } =
    await import("../gateway/server-plugin-in-process-dispatch.js");
  return await runWithInProcessGatewaySessionMutation(
    "agent",
    { sessionKey, agentId },
    async (assertAuthorized) => {
      const authority = composeSessionSourceAssertion([assertCurrent, assertAuthorized]);
      let replaced = false;
      await applySessionEntryLifecycleMutation({
        agentId,
        storePath,
        activeSessionKey: sessionKey,
        skipMaintenance: true,
        withCommit: (run) =>
          runWithSessionSourceScope(authority, () => run(authority), { checkAfter: false }),
        upserts: [
          {
            sessionKey,
            buildEntry: ({ currentEntry }) => {
              authority();
              if (currentEntry?.archivedAt === undefined) {
                return undefined;
              }
              const ownershipError = resolvePluginSessionOwnershipError({
                action: "reset",
                entry: currentEntry,
                key: sessionKey,
                pluginOwnerId: pluginId,
              });
              if (ownershipError) {
                throw new Error(ownershipError.message);
              }
              const block = resolveSessionWorkStartBlock(sessionKey, currentEntry);
              if (block?.reason !== "archived" || currentEntry.modelSelectionLocked) {
                throw block ?? new Error("Archived worker session cannot be replaced.");
              }
              const now = Date.now();
              replaced = true;
              return preserveCreationStamp(
                preserveSqliteSameKeySessionRolloverLineage({
                  sessionKey,
                  previous: currentEntry,
                  next: {
                    sessionId: randomUUID(),
                    lifecycleRevision: randomUUID(),
                    updatedAt: now,
                    sessionStartedAt: now,
                    pluginOwnerId: currentEntry.pluginOwnerId,
                  },
                }),
                currentEntry,
              );
            },
          },
        ],
      });
      return replaced;
    },
    {
      pluginRuntimeOwnerId: pluginId,
      ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    },
  );
}

export type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

export type SessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Loads the complete public entry through the selected asynchronous read owner. */
export async function getSessionEntryAsync(
  params: SessionStoreReadParams,
): Promise<SessionEntry | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker(toSessionAccessScope(params));
  // The public read owns its mutable result; internal actor readers borrow committed facts.
  return entry ? structuredClone(projectPluginSessionEntry(entry)) : undefined;
}

/** Looks up a visible current session ID in one selected store. */
export async function getSessionEntryByIdAsync(
  params: Omit<SessionStoreReadParams, "sessionKey"> & {
    sessionId: string;
    /** Newest normalized-ID match; omitted preserves exact-ID-first listing order. */
    orderBy?: "updatedAt";
  },
): Promise<SessionStoreEntrySummary | undefined> {
  const selected = await readSessionEntryByIdReadOnlyInWorker({
    ...toSessionAccessScope({ ...params, sessionKey: "" }),
    sessionId: params.sessionId,
    orderBy: params.orderBy,
  });
  return selected
    ? { sessionKey: selected.sessionKey, entry: projectPluginSessionEntry(selected.entry) }
    : undefined;
}

export function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Keep plugin-facing options separate from internal accessor-only controls.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

export function projectPluginSessionEntry(entry: InternalSessionEntry): SessionEntry {
  const publicEntry = projectPublicSessionEntry(entry);
  return {
    ...publicEntry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
  };
}

export { projectPublicSessionEntryPatch as projectPluginSessionEntryPatch } from "../config/sessions/session-entry-projection.js";
