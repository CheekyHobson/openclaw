import { afterEach, describe, expect, it } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(() => resetAgentRunRegistryForTest());

const initial = {
  developerInstructions: "Admitted request instructions.",
  refreshableInstructions: "Admitted persona and skills.",
};
const updated = {
  developerInstructions: "Instructions prepared after a retry.",
  refreshableInstructions: "Persona and skills changed during the request.",
};

describe("harness request instruction snapshots", () => {
  it("retains admitted instructions across attempt capabilities and refreshes explicit scopes", async () => {
    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      const first = await createAdmittedHostCapabilityTestFixture({ runId: "prompt-retry" });
      const retry = createAgentHarnessHostCapabilities({
        attempt: { runId: "prompt-retry", admittedRunContext: first.admittedRunContext },
        pluginId: "codex",
      });
      const sibling = createAgentHarnessHostCapabilities({
        attempt: { runId: "prompt-retry", admittedRunContext: first.admittedRunContext },
        pluginId: "another-harness",
      });
      try {
        expect(
          await first.hostCapabilities.preparePromptInstructions?.({
            scope: "original",
            ...initial,
          }),
        ).toEqual(initial);
        first.closeHost();
        expect(
          await retry.capabilities.preparePromptInstructions?.({ scope: "original", ...updated }),
        ).toEqual(initial);
        expect(
          await retry.capabilities.preparePromptInstructions?.({
            scope: "changed-policy",
            ...updated,
          }),
        ).toEqual(updated);
        expect(
          await sibling.capabilities.preparePromptInstructions?.({ scope: "original", ...updated }),
        ).toEqual(updated);
      } finally {
        sibling.close();
        retry.close();
        first.closeHost();
        first.closeAdmission();
      }
    });
  });

  it("refreshes a new admission even when its public run id and surrounding execution scope are reused", async () => {
    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      for (const instructions of [initial, updated]) {
        const host = await createAdmittedHostCapabilityTestFixture({ runId: "reused-public-id" });
        try {
          expect(
            await host.hostCapabilities.preparePromptInstructions?.({
              scope: "same-scope",
              ...instructions,
            }),
          ).toEqual(instructions);
        } finally {
          host.closeHost();
          host.closeAdmission();
        }
      }
    });
  });

  it.each(["host", "admission", "source"] as const)(
    "rejects a prepared snapshot when the %s closes while preparation is pending",
    async (closedOwner) => {
      await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
        let sourceRetired = false;
        const host = await createAdmittedHostCapabilityTestFixture(
          { runId: "prompt-close" },
          {
            operatorAuthority: createAdmittedRunOperatorAuthority({
              profileId: "synthetic-prompt-owner",
              scopes: ["operator.write"],
              assertCurrent: () => {
                if (sourceRetired) {
                  throw new Error("source retired");
                }
              },
            }),
          },
        );
        try {
          const pending = host.hostCapabilities.preparePromptInstructions?.({
            scope: "same-scope",
            ...initial,
          });
          if (closedOwner === "host") {
            host.closeHost();
          } else if (closedOwner === "admission") {
            host.closeAdmission();
          } else {
            sourceRetired = true;
          }
          await expect(pending).rejects.toThrow(/no longer active|source retired/);
        } finally {
          host.closeHost();
          host.closeAdmission();
        }
      });
    },
  );
});
