import { expect, it, vi } from "vitest";
import { resolveInheritedToolPolicyForSession } from "../agents/agent-tools.policy.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolvePersistedSubagentToolPolicyEnvelope } from "../agents/subagents/spawn/subagent-capabilities.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionRead from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveSessionCommunicationPolicy } from "../sessions/communication-policy.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getSessionEntryAsync,
  replaceArchivedSubagentSession,
  resolveStorePath,
} from "./session-store-runtime.js";

it.each([
  { label: "system owner", caller: "system", pluginOwnerId: "workboard" },
  { label: "limited operator", caller: "operator", pluginOwnerId: "workboard" },
  { label: "foreign plugin", caller: "system", pluginOwnerId: "another-plugin" },
  { label: "unowned session", caller: "system", pluginOwnerId: undefined },
  { label: "unscoped caller", caller: "unscoped", pluginOwnerId: "workboard" },
  { label: "missing plugin identity", caller: "unidentified", pluginOwnerId: "workboard" },
  {
    label: "pending worktree",
    caller: "system",
    pluginOwnerId: "workboard",
    pending: { pendingWorktree: { titleSource: "Pending worker checkout" } },
  },
  {
    label: "pending project checkout",
    caller: "system",
    pluginOwnerId: "workboard",
    pending: { pendingProjectGitUrl: "https://example.invalid/worker.git" },
  },
])(
  "preserves plugin replacement authority and execution limits ($label)",
  async ({ caller, pluginOwnerId, pending }) => {
    await withOpenClawTestState({ label: "archived-worker-roles" }, async () => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "limited",
            definitions: {
              limited: { agents: [], scopes: ["operator.read"], sessions: { others: "none" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:automation-worker",
        storePath: resolveStorePath(undefined, { agentId: "main" }),
      };
      const entry = {
        sessionId: "archived-worker",
        updatedAt: Date.now(),
        archivedAt: 1,
        visibility: "draft" as const,
        label: "Private worker",
        color: "purple",
        permissionMode: "read-only" as const,
        sessionRoot: "/workspace",
        spawnedWorkspaceDir: "/workspace",
        spawnedCwd: "/workspace/task",
        worktree: { id: "task-tree", branch: "task", repoRoot: "/workspace" },
        elevatedLevel: "off",
        sendPolicy: "deny" as const,
        communication: { send: "never", receive: "never" } as const,
        spawnedBy: "agent:requester:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1 as const,
        inheritedToolAllow: ["read", "exec"],
        inheritedToolDeny: ["exec"],
        delegatedToolPolicy: {
          requesterSessionKey: "agent:requester:main",
          targetAgentId: "main",
          deny: ["exec"],
          requesterDeny: ["exec"],
        },
        ...pending,
        ...(pluginOwnerId !== undefined ? { pluginOwnerId } : {}),
      };
      await replaceSessionEntry(scope, entry);
      const replace = () =>
        replaceArchivedSubagentSession({ sessionKey: scope.sessionKey, getConfig: () => config });
      const operation =
        caller === "unscoped"
          ? replace()
          : new PluginInstance("workboard").run(() =>
              withPluginRuntimeGatewayRequestScope(
                {
                  ...(caller === "unidentified" ? {} : { pluginId: "workboard" }),
                  context: createContext([], () => config),
                  isWebchatConnect: () => false,
                  ...(caller === "operator"
                    ? {
                        client: createOperatorClient({
                          profileName: "limited-worker",
                          scopes: ["operator.write"],
                        }),
                      }
                    : {}),
                },
                replace,
              ),
            );
      if (caller !== "system" || pluginOwnerId !== "workboard" || pending) {
        await expect(operation).rejects.toThrow(
          pending
            ? "workspace is not ready"
            : caller === "unscoped" || caller === "unidentified"
              ? "requires an active plugin request identity"
              : /role|scope|allowed|access|did not create/i,
        );
        await expect(sessionRead.readSessionEntryReadOnlyInWorker(scope)).resolves.toMatchObject(
          entry,
        );
      } else {
        await expect(operation).resolves.toBe(true);
        const fresh = await getSessionEntryAsync(scope);
        expect(fresh?.sessionId).not.toBe(entry.sessionId);
        expect(fresh?.archivedAt).toBeUndefined();
        expect(fresh).toMatchObject({
          visibility: "draft",
          label: "Private worker",
          color: "purple",
          sessionRoot: "/workspace",
          spawnedWorkspaceDir: "/workspace",
          spawnedCwd: "/workspace/task",
          worktree: { id: "task-tree", branch: "task", repoRoot: "/workspace" },
          elevatedLevel: "off",
          sendPolicy: "deny",
        });
        expect(
          resolveSessionPermissionCoreToolPolicy({ mode: fresh?.permissionMode ?? "full" }),
        ).toMatchObject({ readOnly: true, workspaceOnly: true, execMode: "deny" });
        expect(resolveSessionCommunicationPolicy({ config, entry: fresh })).toEqual({
          send: "never",
          receive: "never",
        });
        const store = { [scope.sessionKey]: fresh ?? {} };
        const policy = resolveInheritedToolPolicyForSession(config, scope.sessionKey, { store });
        expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
        expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
        expect(
          resolvePersistedSubagentToolPolicyEnvelope(scope.sessionKey, { store }),
        ).toMatchObject({
          spawnedBy: "agent:requester:main",
          delegatedToolPolicy: {
            requesterSessionKey: "agent:requester:main",
            targetAgentId: "main",
            deny: ["exec"],
            requesterDeny: ["exec"],
          },
        });
      }
    });
  },
);

it.each(["authority", "config"] as const)(
  "does not replace an archived worker after %s changes during preparation",
  async (change) => {
    await withOpenClawTestState({ label: "archived-worker-authority" }, async () => {
      let config = { agents: { entries: { main: {} } } };
      let current = true;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:automation-worker",
        storePath: resolveStorePath(undefined, { agentId: "main" }),
      };
      const entry = { sessionId: "archived-worker", updatedAt: Date.now(), archivedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const read = sessionRead.readSessionEntryReadOnlyInWorker;
      using pendingRead = vi
        .spyOn(sessionRead, "readSessionEntryReadOnlyInWorker")
        .mockImplementationOnce(async (params) => {
          const result = await read(params);
          if (change === "authority") {
            current = false;
          } else {
            config = { agents: { entries: { main: {} } } };
          }
          return result;
        });
      await expect(
        replaceArchivedSubagentSession({
          sessionKey: scope.sessionKey,
          getConfig: () => config,
          assertCurrent: () => {
            if (!current) {
              throw new Error("dispatch owner closed");
            }
          },
        }),
      ).rejects.toThrow(change === "authority" ? "dispatch owner closed" : "configuration changed");
      expect(pendingRead).toHaveBeenCalled();
      await expect(getSessionEntryAsync(scope)).resolves.toMatchObject(entry);
    });
  },
);

it.each(["settled", "retired", "aborted"] as const)(
  "does not replace an archived worker after its plugin invocation is %s",
  async (lifetime) => {
    await withOpenClawTestState({ label: "archived-worker-lifetime" }, async () => {
      const config = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:automation-worker",
        storePath: resolveStorePath(undefined, { agentId: "main" }),
      };
      const entry = {
        sessionId: "archived-worker",
        updatedAt: Date.now(),
        archivedAt: 1,
        pluginOwnerId: "workboard",
      };
      await replaceSessionEntry(scope, entry);
      const instance = new PluginInstance("workboard");
      const controller = new AbortController();
      const apply = sessionAccessor.applySessionEntryLifecycleMutation;
      // Retire or cancel after admission, at the real lifecycle commit boundary.
      using mutation = vi
        .spyOn(sessionAccessor, "applySessionEntryLifecycleMutation")
        .mockImplementationOnce((params) =>
          apply({
            ...params,
            withCommit: (run) => {
              if (lifetime === "retired") {
                instance.quiesce();
              } else {
                controller.abort(new Error("plugin request cancelled"));
              }
              return params.withCommit!(run);
            },
          }),
        );
      const release = createDeferredCore();
      let operation: Promise<boolean> | undefined;
      const invocation = instance.run(() =>
        withPluginRuntimeGatewayRequestScope(
          {
            pluginId: "workboard",
            context: createContext([], () => config),
            isWebchatConnect: () => false,
            signal: controller.signal,
          },
          () => {
            operation = release.promise.then(() =>
              replaceArchivedSubagentSession({
                sessionKey: scope.sessionKey,
                getConfig: () => config,
              }),
            );
            // A detached callback retains async context, but its token has expired.
            return lifetime === "settled" ? undefined : operation;
          },
        ),
      );
      release.resolve();
      await expect(invocation ?? operation).rejects.toThrow(
        lifetime === "aborted"
          ? "plugin request cancelled"
          : "requires an active plugin invocation",
      );
      expect(mutation).toHaveBeenCalledTimes(lifetime === "settled" ? 0 : 1);
      await expect(getSessionEntryAsync(scope)).resolves.toMatchObject(entry);
    });
  },
);
