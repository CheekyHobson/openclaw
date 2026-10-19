import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestPluginApi } from "./plugin-test-api.js";
import {
  applySessionEntryPatch,
  getSessionEntryAsync,
  loadTranscriptEvents,
  resolveStorePath,
  upsertSessionEntry,
} from "./session-store-runtime.js";
import { appendSessionTranscriptMessageByIdentity } from "./session-transcript-runtime.js";
import { createPluginRuntimeMock } from "./test-helpers/plugin-runtime-mock.js";

// Admission is a host fixture; dispatch, session rollover, and both stores remain real.
vi.mock("../gateway/server-plugin-in-process-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../gateway/server-plugin-in-process-dispatch.js")>();
  return {
    ...actual,
    runWithInProcessGatewaySessionMutation: async <T>(
      _method: "agent" | "sessions.send",
      _params: { sessionKey: string; agentId?: string },
      run: (assertCurrent: () => void) => Promise<T> | T,
    ): Promise<T> => await run(() => {}),
  };
});

type WorkboardStore = {
  create(input: {
    title: string;
    status: "ready";
    agentId?: string;
    workspaceAccess: { unrestricted: true };
    maxRetries: number;
    metadata: { failureCount: number };
  }): Promise<WorkboardCard>;
  get(id: string): Promise<WorkboardCard | undefined>;
  close(): Promise<void>;
};

// Keep the plugin implementation out of core's type graph, as in database conformance tests.
const { WorkboardStore, registerWorkboardGatewayMethods } = await vi.importActual<{
  WorkboardStore: { openSqlite(workerModuleUrl: URL): WorkboardStore };
  registerWorkboardGatewayMethods: (params: {
    api: OpenClawPluginApi;
    store: WorkboardStore;
  }) => void;
}>("../../extensions/workboard/runtime-api.js");

it.each([true, false])(
  "dispatches an archived worker fresh without spending retries (assigned: %s)",
  async (assigned) => {
    await withOpenClawTestState({ label: "workboard-archived-worker" }, async () => {
      const config = { agents: { entries: { worker: {} } } };
      const store = WorkboardStore.openSqlite(
        new URL(
          `../../extensions/workboard/src/sqlite-store.worker${path.extname(new URL(import.meta.url).pathname)}`,
          import.meta.url,
        ),
      );
      try {
        const card = await store.create({
          title: "Retry archived worker",
          status: "ready",
          ...(assigned ? { agentId: "worker" } : {}),
          workspaceAccess: { unrestricted: true },
          maxRetries: 1,
          metadata: { failureCount: 1 },
        });
        const sessionKey = `agent:worker:subagent:workboard-default-${card.id}`;
        const scope = {
          agentId: "worker",
          storePath: resolveStorePath(undefined, { agentId: "worker" }),
          sessionKey,
        };
        const sessionId = "archived-worker";
        await upsertSessionEntry({
          ...scope,
          entry: {
            sessionId,
            lifecycleRevision: "old-worker-revision",
            updatedAt: Date.now(),
            pluginOwnerId: "workboard",
            modelOverride: "old-model",
            modelOverrideSource: "auto",
          },
        });
        await appendSessionTranscriptMessageByIdentity({
          ...scope,
          sessionId,
          config,
          message: { role: "user", content: "Previous worker attempt" },
        });
        const previousTranscript = await loadTranscriptEvents({ ...scope, sessionId });
        expect(previousTranscript.length).toBeGreaterThan(0);
        await applySessionEntryPatch({ ...scope, patch: { archivedAt: Date.now() } });
        const run = vi.fn().mockImplementation(async () => {
          const entry = await getSessionEntryAsync(scope);
          expect(entry?.archivedAt).toBeUndefined();
          expect(entry?.sessionId).not.toBe(sessionId);
          expect(entry?.lifecycleRevision).not.toBe("old-worker-revision");
          expect(entry?.modelOverride).toBeUndefined();
          expect(entry).toMatchObject({ previousSessionId: sessionId, pluginOwnerId: "workboard" });
          return { runId: "fresh-worker-run", sessionKey };
        });
        const handlers = new Map<
          string,
          Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
        >();
        const instance = new PluginInstance("workboard");
        registerWorkboardGatewayMethods({
          store,
          api: createTestPluginApi({
            runtime: createPluginRuntimeMock({ subagent: { run } }),
            registerGatewayMethod: (method, handler) => {
              handlers.set(method, (options) =>
                instance.run(() =>
                  withPluginRuntimeGatewayRequestScope(
                    {
                      pluginId: "workboard",
                      context: options.context,
                      client: options.client,
                      isWebchatConnect: options.isWebchatConnect,
                    },
                    () => handler(options),
                  ),
                ),
              );
            },
          }),
        });
        const dispatch = handlers.get("workboard.cards.dispatchWithOptions");
        expect(dispatch).toBeDefined();
        const respond = vi.fn();
        const params = { maxStarts: 1 };
        await dispatch!({
          req: {
            type: "req",
            id: "archived-worker-dispatch",
            method: "workboard.cards.dispatchWithOptions",
            params,
          },
          params,
          respond,
          client: {
            connect: { scopes: ["operator.admin"] },
          } as GatewayRequestHandlerOptions["client"],
          context: createContext([], () => config),
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            startFailures: [],
            started: [expect.objectContaining({ cardId: card.id, sessionKey })],
          }),
        );
        expect(run).toHaveBeenCalledOnce();
        const current = await store.get(card.id);
        expect(current?.metadata?.failureCount).toBe(1);
        expect(current?.metadata?.workerLogs).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining("archived worker session") }),
        );
        await expect(loadTranscriptEvents({ ...scope, sessionId })).resolves.toEqual(
          previousTranscript,
        );
      } finally {
        await store.close();
      }
    });
  },
);
