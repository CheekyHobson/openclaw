import { getActiveAgentRunContextCount } from "../infra/agent-run-registry.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  hasGatewayWorkMetricsListeners,
  onGatewayWorkMetricsDemand,
  publishGatewayWorkMetrics,
} from "../infra/gateway-work-metrics.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Share the server's activity view with maintenance and the lifetime-owned exporter source. */
export function startGatewayActiveWork(
  runtime: {
    gatewayRequestContext: GatewayRequestContext;
    registerGatewayLifetimeSidecars: (sidecar: { stop: () => Promise<void> }) => void;
  },
  log: SubsystemLogger,
): Partial<GatewayActiveWorkInspectors> {
  const context = runtime.gatewayRequestContext;
  const inspectors = createGatewayServerActiveWorkInspectors(context);
  runtime.registerGatewayLifetimeSidecars(startGatewayWorkMetrics({ context, inspectors, log }));
  return inspectors;
}

/** Projects existing owner facts after changes; scraping never acquires session rows. */
export function startGatewayWorkMetrics(params: {
  context: GatewayRequestContext;
  inspectors: Partial<GatewayActiveWorkInspectors>;
  log: SubsystemLogger;
}) {
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let unsubscribeSessionChanges: (() => void) | undefined;
  publishGatewayWorkMetrics(undefined);
  const needed = () => areDiagnosticsEnabledForProcess() && hasGatewayWorkMetricsListeners();

  let observedProjection: ReturnType<typeof getSessionRowProjection>;
  let unsubscribeSelection: (() => void) | undefined;
  const refresh = () => {
    if (!needed()) {
      return;
    }
    const projection = getSessionRowProjection(params.context);
    if (!projection) {
      return;
    }
    if (observedProjection !== projection) {
      unsubscribeSelection?.();
      observedProjection = projection;
      unsubscribeSelection = projection.onSelectionChange(changed);
    }
    const sessions = projection.countActiveSessions(params.context.resolveGatewayContext);
    publishGatewayWorkMetrics(
      sessions
        ? {
            sessions,
            work: {
              agentRuns: (params.inspectors.getAgentRuns ?? getActiveAgentRunContextCount)(),
              chatRuns: params.inspectors.getChatRuns?.() ?? 0,
              queuedTurns: params.inspectors.getQueuedTurns?.() ?? 0,
            },
          }
        : undefined,
    );
  };
  const changed = () => {
    if (stopped) {
      return;
    }
    if (!needed()) {
      if (unsubscribeSessionChanges) {
        unsubscribeSessionChanges();
        unsubscribeSessionChanges = undefined;
        unsubscribeSelection?.();
        unsubscribeSelection = undefined;
        observedProjection = undefined;
        if (scheduled) {
          clearImmediate(scheduled);
          scheduled = undefined;
        }
        publishGatewayWorkMetrics(undefined);
      }
      return;
    }
    unsubscribeSessionChanges ??= sessionChanges.subscribe(changed);
    if (scheduled) {
      return;
    }
    scheduled = runInDetachedAsyncContext(() =>
      setImmediate(() => {
        scheduled = undefined;
        try {
          refresh();
        } catch (error) {
          publishGatewayWorkMetrics(undefined);
          params.log.warn("Live work metric projection failed", { error });
        }
      }),
    );
    scheduled.unref();
  };
  const unsubscribeWorkChanges = onGatewayWorkMetricsChanged(changed);
  const unsubscribeDemand = onGatewayWorkMetricsDemand(changed);
  changed();
  return {
    stop: async () => {
      stopped = true;
      unsubscribeSessionChanges?.();
      unsubscribeSelection?.();
      unsubscribeWorkChanges();
      unsubscribeDemand();
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      publishGatewayWorkMetrics(undefined);
    },
  };
}
