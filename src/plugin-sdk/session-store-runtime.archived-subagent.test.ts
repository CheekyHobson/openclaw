import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionRead from "../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getSessionEntryAsync,
  replaceArchivedSubagentSession,
  resolveStorePath,
} from "./session-store-runtime.js";

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
