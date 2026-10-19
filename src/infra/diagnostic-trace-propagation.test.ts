import { afterEach, expect, it, vi } from "vitest";
import {
  formatPropagatedDiagnosticTraceparent,
  hasDiagnosticTracePropagationConsumer,
  registerDiagnosticTracePropagationBridge,
  resetDiagnosticTracePropagationForTest,
} from "./diagnostic-trace-propagation.js";

afterEach(resetDiagnosticTracePropagationForTest);

it.each([true, false])(
  "shares exporter context and cleanup across module instances (resolved=%s)",
  async (resolved) => {
    const trace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    };
    const bridge = {
      prepareEvent: () => undefined,
      resolveTraceContext: () => (resolved ? { ...trace, traceFlags: "00" } : undefined),
    };
    expect(hasDiagnosticTracePropagationConsumer()).toBe(false);
    expect(formatPropagatedDiagnosticTraceparent(trace)).toBe(
      `00-${trace.traceId}-${trace.spanId}-01`,
    );
    const stop = registerDiagnosticTracePropagationBridge(bridge);
    vi.resetModules();
    const duplicate = await import("./diagnostic-trace-propagation.js");
    expect(duplicate.hasDiagnosticTracePropagationConsumer()).toBe(true);
    expect(duplicate.formatPropagatedDiagnosticTraceparent(trace)).toBe(
      resolved ? `00-${trace.traceId}-${trace.spanId}-00` : undefined,
    );
    stop();
    expect(duplicate.hasDiagnosticTracePropagationConsumer()).toBe(false);
    expect(formatPropagatedDiagnosticTraceparent(trace)).toBe(
      `00-${trace.traceId}-${trace.spanId}-01`,
    );

    duplicate.registerDiagnosticTracePropagationBridge(bridge);
    resetDiagnosticTracePropagationForTest();
    expect(hasDiagnosticTracePropagationConsumer()).toBe(false);
    expect(formatPropagatedDiagnosticTraceparent(trace)).toBe(
      `00-${trace.traceId}-${trace.spanId}-01`,
    );
  },
);
