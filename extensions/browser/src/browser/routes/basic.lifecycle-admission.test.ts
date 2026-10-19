import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import type { BrowserTab } from "../server-context.types.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const profilesService = vi.hoisted(() => ({
  importSystemProfile: vi.fn(async () => ({ ok: true }) as const),
  deleteProfile: vi.fn(async (name: string) => ({ ok: true, profile: name, deleted: true })),
}));

vi.mock("../profiles-service.js", () => ({ createBrowserProfilesService: () => profilesService }));

afterEach(() => clearRuntimeConfigSnapshot());

function createLifecycleRoute(path: string) {
  const state = makeBrowserServerState();
  const context = createBrowserRouteContext({ getState: () => state });
  const deleting = path === "DELETE /profiles/:name";
  const mutation = vi.fn();
  const isHttpReachable = vi.fn(async () => false);
  const listTabs = vi.fn(async (): Promise<BrowserTab[]> => []);
  profilesService.deleteProfile.mockImplementation(async (name) => {
    mutation();
    return { ok: true, profile: name, deleted: true };
  });
  const profile = {
    ...context.forProfile(),
    isHttpReachable,
    listTabs,
    ensureBrowserAvailable: async (options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      mutation();
    },
    stopRunningBrowser: async () => {
      mutation();
      return { stopped: true };
    },
    resetProfile: async () => {
      mutation();
      return { moved: false, from: "/synthetic/profile" };
    },
  };
  const { app, postHandlers, deleteHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, { ...context, forProfile: () => profile });
  const handler = deleting ? deleteHandlers.get("/profiles/:name") : postHandlers.get(path);
  if (!handler) {
    throw new Error(`Missing browser lifecycle route ${path}`);
  }
  return {
    mutation,
    isHttpReachable,
    listTabs,
    call: async (request: Partial<BrowserRequest>) => {
      const response = createBrowserRouteResponse();
      await handler({ params: { name: "work" }, query: {}, ...request }, response.res);
      return response;
    },
  };
}

describe("shared lifecycle admission", () => {
  it.each(["request canceled", "connection canceled"])(
    "rejects a request before mutation when %s",
    async (reason) => {
      const route = createLifecycleRoute("/start");
      const request = new AbortController();
      const connection = new AbortController();
      if (reason === "request canceled") {
        request.abort(new Error(reason));
      } else if (reason === "connection canceled") {
        connection.abort(new Error(reason));
      }

      const response = await route.call({
        signal: request.signal,
        requester: { signal: connection.signal, isCurrent: () => true },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(route.mutation).not.toHaveBeenCalled();
    },
  );

  it("rejects a retired dashboard before mutation", async () => {
    const route = createLifecycleRoute("/start");
    const response = await route.call({
      assertCurrent: async () => {
        throw new Error("dashboard retired");
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toEqual({ error: "Error: dashboard retired" });
    expect(route.mutation).not.toHaveBeenCalled();
  });
});

describe("lifecycle admission", () => {
  it.each(["/start", "DELETE /profiles/:name"])(
    "%s rechecks requester authority after dashboard admission",
    async (path) => {
      const route = createLifecycleRoute(path);
      let current = true;
      const response = await route.call({
        requester: { signal: new AbortController().signal, isCurrent: () => current },
        assertCurrent: async () => {
          current = false;
        },
      });

      expect(response.statusCode).toBe(401);
      expect(route.mutation).not.toHaveBeenCalled();
    },
  );

  it.each(["/reset-profile", "DELETE /profiles/:name"])(
    "%s invokes the admitted operation before yielding its authority check",
    async (path) => {
      const route = createLifecycleRoute(path);
      let current = true;
      const admittedWithAuthority: boolean[] = [];
      route.mutation.mockImplementation(() => admittedWithAuthority.push(current));

      const response = await route.call({
        requester: { signal: new AbortController().signal, isCurrent: () => current },
        assertCurrent: async () => {
          queueMicrotask(() =>
            queueMicrotask(() => {
              current = false;
            }),
          );
        },
      });

      expect(response.statusCode).toBe(200);
      expect(admittedWithAuthority).toEqual([true]);
    },
  );

  it("refuses an explicit managed stop with a current Control UI tab", async () => {
    setRuntimeConfigSnapshot({ gateway: { publicOrigin: "https://control.example" } });
    const route = createLifecycleRoute("/stop");
    route.isHttpReachable.mockResolvedValue(true);
    route.listTabs.mockResolvedValue([
      { targetId: "approval", title: "Approval", url: "https://control.example/approvals" },
    ]);

    const response = await route.call({});

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("cannot access this Gateway's Control UI"),
    });
    expect(route.mutation).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves ordinary stop when browser reachable=%s", async (reachable) => {
    const route = createLifecycleRoute("/stop");
    route.isHttpReachable.mockResolvedValue(reachable);
    route.listTabs.mockResolvedValue([
      { targetId: "app", title: "Local app", url: "http://127.0.0.1:3000/" },
    ]);

    const response = await route.call({});

    expect(response.statusCode).toBe(200);
    expect(route.mutation).toHaveBeenCalledOnce();
    expect(route.listTabs).toHaveBeenCalledTimes(reachable ? 1 : 0);
  });

  it("rechecks requester authority after inspecting tabs for an explicit stop", async () => {
    const route = createLifecycleRoute("/stop");
    route.isHttpReachable.mockResolvedValue(true);
    let current = true;
    route.listTabs.mockImplementation(async () => {
      current = false;
      return [];
    });
    const response = await route.call({
      requester: { signal: new AbortController().signal, isCurrent: () => current },
    });

    expect(response.statusCode).toBe(401);
    expect(route.mutation).not.toHaveBeenCalled();
  });
});

async function callImport(body: unknown, signal?: AbortSignal) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {} as never);
  const handler = postHandlers.get("/profiles/import");
  if (!handler) {
    throw new Error("expected /profiles/import handler");
  }
  const response = createBrowserRouteResponse();
  await handler({ body, signal } as never, response.res);
  return response;
}

describe("POST /profiles/import domain filter validation", () => {
  it.each([
    ["a non-array string", { domains: "google.com" }, "domains must be an array of domain strings"],
    [
      "an array of blanks",
      { domains: ["   ", ""] },
      "domains must include at least one non-empty domain",
    ],
  ])("fails closed for %s", async (_label, body, message) => {
    const response = await callImport(body);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: message });
  });

  it("forwards the request abort signal into the import transaction", async () => {
    const abort = new AbortController();
    await callImport({ into: "imported" }, abort.signal);

    expect(profilesService.importSystemProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ into: "imported" }),
      { signal: abort.signal },
    );
  });
});
