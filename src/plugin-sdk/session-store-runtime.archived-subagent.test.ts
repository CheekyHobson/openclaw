import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionRead from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getSessionEntryAsync,
  replaceArchivedSubagentSession,
  resolveStorePath,
} from "./session-store-runtime.js";

it.each([
  { label: "system owner", scoped: false, pluginOwnerId: "workboard" },
  { label: "limited operator", scoped: true, pluginOwnerId: "workboard" },
  { label: "foreign plugin", scoped: false, pluginOwnerId: "another-plugin" },
  { label: "unowned session", scoped: false, pluginOwnerId: undefined },
])(
  "preserves plugin replacement authority with roles ($label)",
  async ({ scoped, pluginOwnerId }) => {
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
        pluginOwnerId,
      };
      await replaceSessionEntry(scope, entry);
      const operation = withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "workboard",
          context: createContext([], () => config),
          isWebchatConnect: () => false,
          ...(scoped
            ? {
                client: createOperatorClient({
                  profileName: "limited-worker",
                  scopes: ["operator.write"],
                }),
              }
            : {}),
        },
        () =>
          replaceArchivedSubagentSession({ sessionKey: scope.sessionKey, getConfig: () => config }),
      );
      if (scoped || pluginOwnerId !== "workboard") {
        await expect(operation).rejects.toThrow(/role|scope|allowed|access|did not create/i);
        await expect(getSessionEntryAsync(scope)).resolves.toMatchObject(entry);
      } else {
        await expect(operation).resolves.toBe(true);
        const fresh = await getSessionEntryAsync(scope);
        expect(fresh?.sessionId).not.toBe(entry.sessionId);
        expect(fresh?.archivedAt).toBeUndefined();
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
