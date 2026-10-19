import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickChromeMcpElement,
  evaluateChromeMcpScript,
  takeChromeMcpSnapshot,
  withChromeMcpDocument,
} from "./chrome-mcp-actions.js";
import { ChromeMcpDocumentUnavailableError } from "./chrome-mcp-contracts.js";
import { closeChromeMcpSession } from "./chrome-mcp-session.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import {
  installChromeMcpSessionTestHooks,
  pagesResult,
  setupSnapshotSession,
  snapshotResult,
  snapshotWithControls,
  textResult,
} from "./chrome-mcp.test-support.js";

await vi.hoisted(() => import("./chrome-mcp-process.test-support.js"));

vi.mock("./chrome-mcp-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chrome-mcp-connect.js")>();
  return { ...actual, createChromeMcpSession: vi.fn(actual.createChromeMcpSession) };
});

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function buttonDocument(suffix = "", name?: string): ChromeMcpSnapshotNode {
  return {
    id: `root${suffix}`,
    role: "RootWebArea",
    children: [{ id: `button${suffix}`, role: "button", ...(name ? { name } : {}) }],
  };
}

describe("Chrome MCP snapshot identity and lifetime", () => {
  installChromeMcpSessionTestHooks();

  it.each(["the Control UI opens", "the session retires"] as const)(
    "refuses a prepared document effect when %s",
    async (change) => {
      setRuntimeConfigSnapshot({ gateway: { publicOrigin: "https://control.example" } });
      let url = "https://page-1.example";
      let retireOnList = false;
      const effects: unknown[] = [];
      const { targets } = await setupSnapshotSession({
        list_pages: async () => {
          if (retireOnList) {
            await closeChromeMcpSession("chrome-live");
          }
          return pagesResult([{ id: 1, url }]);
        },
        take_snapshot: () => snapshotResult(buttonDocument()),
        evaluate_script: (call) => {
          effects.push(call.arguments?.function);
          return textResult("```json\ntrue\n```");
        },
      });
      const prepared = createDeferred<void>();
      const resume = createDeferred<void>();
      const pending = withChromeMcpDocument(targets[0]!, async (document) => {
        await document.evaluate("() => 1");
        prepared.resolve();
        await resume.promise;
        await document.evaluate("() => 2");
      });
      await prepared.promise;
      if (change === "the Control UI opens") {
        url = "https://control.example/approvals";
      } else {
        // Retire while the new URL check awaits its SDK list response.
        retireOnList = true;
      }
      resume.resolve();

      await expect(pending).rejects.toThrow(
        change === "the Control UI opens"
          ? "cannot access this Gateway's Control UI"
          : "changed before the operation could start",
      );
      expect(effects).toEqual(["() => 1"]);
    },
  );

  it("retires target refs before a failed snapshot refresh", async () => {
    let refreshing = false;
    let oldRef = "";
    const refPresentAtDispatch: boolean[] = [];
    const clicks: unknown[] = [];
    const { session, targets } = await setupSnapshotSession(
      {
        take_snapshot: (call) => {
          const pageId = call.arguments?.pageId;
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          if (refreshing) {
            refPresentAtDispatch.push(
              session.routing!.snapshotsByTarget.get(target.targetId)?.refs.has(oldRef) ?? false,
            );
            return textResult("snapshot failed after refresh", true);
          }
          return snapshotResult(buttonDocument(`-${pageId}`, "Run"));
        },
        click: (call) => {
          clicks.push([call.arguments?.pageId, call.arguments?.uid]);
          return { content: [] };
        },
      },
      [1, 2],
    );
    const target = targets[0]!;
    const sibling = targets[1]!;
    oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
    const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
    refreshing = true;
    const refresh = takeChromeMcpSnapshot(target);
    await expect(refresh).rejects.toThrow("snapshot failed after refresh");
    expect(refPresentAtDispatch).toEqual([false]);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);
    await clickChromeMcpElement({ ...sibling, uid: siblingRef });
    expect(clicks).toEqual([[2, "button-2"]]);
  });

  it("recaptures an expired document without retiring healthy sibling refs", async () => {
    const snapshots: number[] = [];
    const evaluatedUids: unknown[] = [];
    const clicks: unknown[] = [];
    let navigated = false;
    const { targets } = await setupSnapshotSession(
      {
        take_snapshot: (call) => {
          const pageId = call.arguments?.pageId;
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          snapshots.push(pageId);
          const documentId = pageId === 1 && navigated ? "new" : "initial";
          return snapshotResult(buttonDocument(`-${pageId}-${documentId}`));
        },
        evaluate_script: (call) => {
          const args = call.arguments?.args;
          evaluatedUids.push(args);
          if (navigated && Array.isArray(args) && args[0] === "root-1-initial") {
            return textResult(
              "Element with uid root-1-initial no longer exists on the page.",
              true,
            );
          }
          return textResult("```json\ntrue\n```");
        },
        click: (call) => {
          clicks.push([call.arguments?.pageId, call.arguments?.uid]);
          return { content: [] };
        },
      },
      [1, 2],
    );
    const target = targets[0]!;
    const sibling = targets[1]!;
    const oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
    const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
    navigated = true;

    await expect(
      withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
    ).rejects.toBeInstanceOf(ChromeMcpDocumentUnavailableError);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);
    await clickChromeMcpElement({ ...sibling, uid: siblingRef });
    await expect(
      withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
    ).resolves.toBe(true);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);

    expect(snapshots).toEqual([1, 2, 1]);
    expect(evaluatedUids).toEqual([["root-1-initial"], ["root-1-new"]]);
    expect(clicks).toEqual([[2, "button-2-initial"]]);
  });

  it.each([true, false])(
    "discards invalid snapshots without admitting inspection (ambiguous refs=%s)",
    async (ambiguous) => {
      let snapshots = 0;
      const { session, targets } = await setupSnapshotSession({
        take_snapshot: () => {
          if (++snapshots > 1) {
            return snapshotResult({ ...buttonDocument(), id: "valid-root" });
          }
          return snapshotResult(
            ambiguous
              ? snapshotWithControls(
                  { id: "button", role: "button", name: "Run" },
                  { id: "frame", role: "Iframe", children: [{ id: "button", role: "button" }] },
                )
              : { role: "RootWebArea", children: [{ id: "button", role: "button" }] },
          );
        },
        evaluate_script: () => textResult(ambiguous ? "```json\nnull\n```" : "```json\ntrue\n```"),
      });
      const target = targets[0]!;
      const inspect = vi.fn(async () => true);
      await expect(withChromeMcpDocument(target, inspect)).rejects.toThrow(
        ambiguous
          ? /ambiguous element IDs.*managed browser profile/
          : "Chrome MCP snapshot did not contain a top-level document uid",
      );
      expect(inspect).not.toHaveBeenCalled();
      expect(session.routing!.snapshotsByTarget.has(target.targetId)).toBe(false);
      if (ambiguous) {
        await expect(evaluateChromeMcpScript({ ...target, fn: "() => null" })).resolves.toBeNull();
      } else {
        await expect(
          withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
        ).resolves.toBe(true);
        expect(snapshots).toBe(2);
      }
    },
  );
});
