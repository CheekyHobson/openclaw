import { describe, expect, it, vi } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const COLD_PROFILE = { ...PROFILE, warmImage: false };
const COORDINATOR_TIMEOUT = `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\nGet "https://coordinator.example/v1/leases/${LEASE_ID}": context deadline exceeded`;
const LEASE_CONFLICT = "lease_id_conflict: fixed claim changed during resolution; retry";

describe("Crabbox worker coordinator retries", () => {
  it.each([
    {
      name: "remote script output",
      code: 1,
      stderr: COORDINATOR_TIMEOUT,
      stdout: "CRABBOX_PHASE:openclaw-bootstrap-start",
    },
    { name: "a lease conflict", code: 4, stderr: LEASE_CONFLICT, stdout: "" },
  ])("does not retry enrollment after $name", async ({ name: _name, ...failure }) => {
    let attempts = 0;
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[1] === "run" && ++attempts <= 2) {
        return commandResult(failure);
      }
      return undefined;
    });
    await expect(provisionWarmProfile(provider, COLD_PROFILE)).rejects.toThrow(
      "Crabbox node enrollment setup failed",
    );
    const scripts = calls.filter(({ argv }) => argv[1] === "run");
    expect(scripts).toHaveLength(1);
    expect(new Set(scripts.map(({ options }) => options.input)).size).toBe(1);
    expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
  });

  it("retries a profile setup lease conflict using the same fixed lease", async () => {
    const setup = "install-node";
    let attempts = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const { provider, calls } = createWarmProvider(
      ({ options }) =>
        options.input === setup && attempts++ === 0
          ? commandResult({ code: 4, stderr: LEASE_CONFLICT })
          : undefined,
      undefined,
      { sleep },
    );
    await expect(provisionWarmProfile(provider, { ...COLD_PROFILE, setup })).resolves.toMatchObject(
      {
        leaseId: LEASE_ID,
        node: { deviceId: "device-1" },
      },
    );
    const setups = calls.filter(({ options }) => options.input === setup);
    expect(setups).toHaveLength(2);
    expect(setups.every(({ argv }) => argv[argv.indexOf("--id") + 1] === LEASE_ID)).toBe(true);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each([
    { name: "coordinator timeout", code: 1, stderr: COORDINATOR_TIMEOUT },
    { name: "lease conflict", code: 4, stderr: "lease_id_conflict: claim is still changing" },
  ])("stops the lease after exhausting profile setup retries: $name", async ({ code, stderr }) => {
    const setup = "install-node";
    const sleep = vi.fn(async (_ms: number) => {});
    const { provider, calls } = createWarmProvider(
      ({ options }) => {
        if (options.input !== setup) {
          return undefined;
        }
        return commandResult({ code, stderr });
      },
      undefined,
      { sleep },
    );
    const provisioning = provisionWarmProfile(provider, { ...COLD_PROFILE, setup });
    await expect(provisioning).rejects.toMatchObject({
      code: "cleanup_complete",
      message: expect.stringContaining(`${stderr.replaceAll("\n", " ")} (after 3 attempts)`),
    });
    expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
    const setups = calls.filter(({ options }) => options.input === setup);
    expect(setups).toHaveLength(3);
    expect(
      setups.every(({ argv }) => argv.includes(LEASE_ID) && argv.includes("--script-stdin")),
    ).toBe(true);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it.each([
    { name: "another exit-4 failure", code: 4, stderr: "lease_unavailable: retry" },
    { name: "a different exit code", code: 1, stderr: LEASE_CONFLICT },
    { name: "a different code token", code: 4, stderr: "lease_id_conflict_other: retry" },
    { name: "script stdout", code: 4, stderr: LEASE_CONFLICT, stdout: "installing packages" },
    { name: "mixed stderr", code: 4, stderr: `${LEASE_CONFLICT}\ninstallation failed` },
  ])("does not retry profile setup after $name", async ({ name: _name, ...failure }) => {
    const setup = "install-node";
    const { provider, calls } = createWarmProvider(({ options }) =>
      options.input === setup ? commandResult(failure) : undefined,
    );
    await expect(provisionWarmProfile(provider, { ...COLD_PROFILE, setup })).rejects.toMatchObject({
      code: "cleanup_complete",
      message: expect.stringContaining("Crabbox profile setup failed"),
    });
    expect(calls.filter(({ options }) => options.input === setup)).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
  });

  it("cancels backoff without resubmitting setup or stopping the lease", async () => {
    const controller = new AbortController();
    const { provider, calls } = createWarmProvider(
      ({ argv }) =>
        argv[1] === "run" ? commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT }) : undefined,
      undefined,
      {
        sleep: async () => {
          controller.abort();
        },
      },
    );
    await expect(
      provisionWarmProfile(
        provider,
        { ...COLD_PROFILE, setup: "install-node" },
        undefined,
        undefined,
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter(({ argv }) => argv[1] === "run")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it("does not retry warmup coordinator timeouts", async () => {
    const { provider, calls } = createWarmProvider(({ argv }) =>
      argv[1] === "warmup" ? commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT }) : undefined,
    );
    await expect(provisionWarmProfile(provider, COLD_PROFILE)).rejects.toThrow(
      "Crabbox warmup failed",
    );
    expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "run" || argv[1] === "stop")).toBe(false);
  });
});
