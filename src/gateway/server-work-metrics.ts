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
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { prepareSessionRowSelection, selectSessionEntries } from "./session-utils-list.js";

const workCount = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

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
  let dirty = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let pending: Promise<void> | undefined;
  let unsubscribeSessionChanges: (() => void) | undefined;
  publishGatewayWorkMetrics(undefined);
  const needed = () => areDiagnosticsEnabledForProcess() && hasGatewayWorkMetricsListeners();

  const refresh = async () => {
    if (!needed()) {
      return;
    }
    const projection = getSessionRowProjection(params.context);
    if (!projection) {
      return;
    }
    await projection.withSelectionPreparation(async () => {
      do {
        await projection.prepareSelection({ metadataOnly: true });
        if (stopped || !needed() || projection !== getSessionRowProjection(params.context)) {
          return;
        }
      } while (projection.needsSelectionPreparation({ metadataOnly: true }));
      const now = Date.now();
      const projectRun = createVisibleActiveSessionRunProjector(
        projection.state.rowContext.projectedAgentRuns,
        undefined,
        params.context.resolveGatewayContext,
        projection.physicalPaths,
      );
      const presentation = prepareSessionRowPublication(projection, now)(undefined, projectRun);
      const prepared = prepareSessionRowSelection(
        projection,
        {
          activeOnly: true,
          includeGlobal: true,
          includeUnknown: true,
        },
        {
          now,
          rowContext: presentation.rowContext,
          metadataPrepared: true,
          ordered: true,
          candidateSessionIdsOrKeys: projectRun.candidateSessionIdsOrKeys(),
        },
      );
      const states = new Map<string, "running" | "queued">();
      const selection = runSynchronousWork(
        selectSessionEntries({
          ...prepared,
          entriesSorted: true,
          entryFilter: (key) => {
            const active = presentation.active(prepared.getTarget(key)!)!;
            if (active.active) {
              states.set(key, active.status ?? "running");
            }
            return active.active;
          },
        }),
      );
      const sessions = { running: 0, queued: 0 };
      for (const [key] of selection.entries) {
        sessions[states.get(key)!]++;
      }
      // Metrics consume these three counts, not suspension blockers or holder descriptions.
      publishGatewayWorkMetrics({
        sessions,
        work: {
          agentRuns: workCount((params.inspectors.getAgentRuns ?? getActiveAgentRunContextCount)()),
          chatRuns: workCount(params.inspectors.getChatRuns?.() ?? 0),
          queuedTurns: workCount(params.inspectors.getQueuedTurns?.() ?? 0),
        },
      });
    });
  };
  const changed = () => {
    if (stopped) {
      return;
    }
    if (!needed()) {
      if (unsubscribeSessionChanges) {
        unsubscribeSessionChanges();
        unsubscribeSessionChanges = undefined;
        dirty = false;
        if (scheduled) {
          clearImmediate(scheduled);
          scheduled = undefined;
        }
        publishGatewayWorkMetrics(undefined);
      }
      return;
    }
    unsubscribeSessionChanges ??= sessionChanges.subscribe(changed);
    dirty = true;
    if (scheduled || pending) {
      return;
    }
    scheduled = runInDetachedAsyncContext(() =>
      setImmediate(() => {
        scheduled = undefined;
        dirty = false;
        pending = refresh()
          .catch((error: unknown) => {
            if (!stopped) {
              publishGatewayWorkMetrics(undefined);
              params.log.warn("Live work metric projection failed", { error });
            }
          })
          .finally(() => {
            pending = undefined;
            if (dirty) {
              changed();
            }
          });
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
      unsubscribeWorkChanges();
      unsubscribeDemand();
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      publishGatewayWorkMetrics(undefined);
      await pending;
    },
  };
}
