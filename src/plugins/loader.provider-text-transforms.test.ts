import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import {
  globalAfterAll1,
  globalAfterEach0,
  loadRegistryFromSinglePlugin,
} from "./loader.test-harness.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

it("registers provider-scoped text transforms", () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "text-shim",
    filename: "text-shim.cjs",
    registration: `api.registerProvider({
      id: "text-shim",
      label: "Text shim",
      auth: [],
      textTransforms: {
        input: [{ from: /red basket/g, to: "blue basket" }],
        output: [{ from: /blue basket/g, to: "red basket" }],
      },
    });`,
  });

  const registry = loadRegistryFromSinglePlugin({
    plugin,
    pluginConfig: { allow: ["text-shim"] },
  });

  expect(registry.providers).toHaveLength(1);
  const transformRegistration = registry.providers[0];
  expect(transformRegistration?.pluginId).toBe("text-shim");
  expect(transformRegistration?.provider.textTransforms?.input).toEqual([
    { from: /red basket/g, to: "blue basket" },
  ]);
  expect(transformRegistration?.provider.textTransforms?.output).toEqual([
    { from: /blue basket/g, to: "red basket" },
  ]);
});
