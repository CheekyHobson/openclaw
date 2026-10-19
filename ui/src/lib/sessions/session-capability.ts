import type { GatewaySessionMessageSubscription } from "@openclaw/gateway-client/browser";
import type {
  PreservedSessionWorktree,
  SessionsDeleteResult,
  SessionsListParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { SchemaContract } from "../../../../packages/gateway-protocol/src/schema-contract.js";
import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayPhase,
  ApplicationGatewaySnapshot,
} from "../../app/gateway.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import type { GatewayConnectionScope } from "../gateway-connection-lifecycle.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";
import type { GitHubPublicationPresentationBinding } from "./github-publication-owner.ts";
import type { SessionArchivedFilter } from "./navigation.ts";
import type { BootRoster } from "./session-boot-roster.ts";
import type { createSessionDeletions } from "./session-deletions.ts";
import type { createSessionGitHubPublication } from "./session-github-publication.ts";
import type { createSessionGroupCatalog } from "./session-group-catalog.ts";
import type { createSessionMutations } from "./session-mutations.ts";
import type { createSessionPermissionProjection } from "./session-permission-projection.ts";
import type { createSessionReconciliation } from "./session-reconciliation.ts";
import type { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import type { SessionChangedRowResult } from "./session-row-reconcile.ts";
import type { SessionRunTerminal } from "./session-run-terminal.ts";
import type { createSessionScopedOperations } from "./session-scoped-operations.ts";
import type { createSessionThinkingClaims } from "./session-thinking-claims.ts";

export type SessionState = {
  result: SessionsListResult | null;
  resultCached?: boolean;
  agentId: string | null;
  modelOverrides: Readonly<Record<string, string | null>>;
  loading: boolean;
  error: string | null;
  startupPending?: boolean;
  deletedSessions: readonly SessionDeletionFact[];
  /** Gateway-owned custom group catalog in display order. */
  groups: readonly string[];
  /** New Session defaults associated with each gateway-owned group. */
  groupSettings: readonly SessionGroupSettings[];
  /** Gateway-owned sidebar section order; pinned is intentionally absent. */
  sectionOrder: readonly string[];
};

export function createSessionState(
  bootRecord?: Pick<BootRecord, "groups" | "sectionOrder"> | null,
): SessionState {
  return {
    result: null,
    agentId: null,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: bootRecord?.groups.map((group) => group.name) ?? [],
    groupSettings: bootRecord?.groups ?? [],
    sectionOrder: bootRecord?.sectionOrder ?? [],
  };
}

type SessionDeletionFact = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export type SessionGroupMutationResult = "completed" | "stale";
export type SessionGroupDefaultsStatus = "idle" | "loading" | "ready" | "unavailable";

export type SessionListOptions = SchemaContract<
  Omit<
    SessionsListParams,
    | "source"
    | "activityPulseBoundaries"
    | "activeOnly"
    | "requireLastInteraction"
    | "sortBy"
    | "includeActivitySummary"
    | "label"
    | "projectId"
    | "workspaceDir"
    | "group"
    | "pinned"
    | "creatorId"
    | "profileRelation"
    | "involvingProfileId"
    | "includePeople"
    | "archived"
  >
> & {
  source?: SessionsListParams["source"];
  /** Physical read size for a managed window that needs every page enriched. */
  pageSize?: number;
  archivedFilter?: SessionArchivedFilter;
  append?: boolean;
};

export type SessionRefreshOptions = SessionListOptions & {
  force?: boolean;
  // Sidebar startup hydration must not block session creation or drop the open session.
  backgroundHydrate?: boolean;
};

export type SessionRefreshOutcome =
  | { status: "refreshed" | "stale" }
  | { status: "failed"; error: string };

export type SessionListScope = Readonly<Omit<SessionListOptions, "offset" | "append">>;

export type SessionListSnapshot = Pick<
  SessionState,
  "result" | "agentId" | "loading" | "error" | "startupPending"
> & {
  /** Outcome of the latest settled managed-list read, including suppressed availability errors. */
  readSucceeded?: boolean;
  /** Accepted server-window membership before local visibility and generation filters. */
  pagination?: Pick<SessionsListResult, "totalCount" | "hasMore" | "nextOffset"> & {
    count: number;
  };
};

export type SessionRowTarget = Readonly<{ key: string; agentId: string }>;

type SessionRowReadOutcome =
  | { status: "current"; row: GatewaySessionRow | null }
  | { status: "retired" };

export type SessionRowObservation = {
  readonly row: GatewaySessionRow | null;
  readonly sessionId: string | null;
  /** False until this owner accepts a row or confirms its absence. */
  readonly hasObserved: boolean;
  isCurrent: () => boolean;
  captureReconcile: () => (row: GatewaySessionRow | undefined) => SessionRowReadOutcome;
  dispose: () => void;
};

export type SessionRowEventListener = (
  event: GatewayEventFrame,
  /** Rejected generations can wake recovery but cannot mutate transcript or lifecycle state. */
  result: SessionChangedRowResult & { generationRejected?: true },
) => void;

export type SessionRowListener = (
  row: GatewaySessionRow | null,
  /** This retiring registration still owns delivery of the captured frame. */
  notification?: { eventPending: true },
) => void;

export type SessionDeleteOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  archivedOnly?: boolean;
};

export type SessionDeleteTarget = SessionDeleteOptions & {
  key: string;
};

export type SessionDeleteOutcome = Pick<SessionsDeleteResult, "deleted" | "worktreePreserved">;

export type SessionDeleteBatchResult = {
  deleted: string[];
  errors: { target: SessionDeleteTarget; error: unknown }[];
  preservedWorktrees: PreservedSessionWorktree[];
};

export type SessionCompactResult = {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: { tokensBefore?: number; tokensAfter?: number };
};

export type SessionResetOptions = {
  agentId?: string | null;
};

export type SessionResetResult = "completed" | "not-started" | "uncertain";

export type SessionGateway = {
  defer?: ApplicationGateway["defer"];
  readonly connection?: { readonly gatewayUrl: string; readonly token?: string };
  readonly connectionRevision?: number;
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    phase: ApplicationGatewayPhase;
    deferredIntentCount?: number;
    deferredIntentDraining?: boolean;
    restartPending?: boolean;
    suspensionPhase?: ApplicationGatewaySnapshot["suspensionPhase"];
    hello: GatewayHelloOk | null;
    assistantAgentId?: string | null;
    sessionKey?: string;
    selfUser?: AuthenticatedUser | null;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

export type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

export type SessionConnectionScope = GatewayConnectionScope;

export type SessionConnectionOwner = {
  capture: () => SessionConnectionScope | null;
  isCurrent: (scope: SessionConnectionScope) => boolean;
};

export type SessionCreateReconciliation = "blocking" | "background";

export type SessionMessageSubscription = GatewaySessionMessageSubscription;
export type SessionArchiveVisibility = "pending" | "archived";

export type GitHubPublicationBinding = GitHubPublicationPresentationBinding & {
  matches: (row: GatewaySessionRow) => boolean;
};

type SessionRoster = ReturnType<typeof createSessionRosterRefresh>;
type SessionGroups = ReturnType<typeof createSessionGroupCatalog>;
type SessionGroupMethod = "load" | "status" | "invalidate" | "put" | "rename" | "update" | "delete";

/** Public operations come from their concrete owners; internal lifecycle methods stay private. */
export type SessionCapability = Pick<
  ReturnType<typeof createSessionMutations>,
  | "create"
  | "createResult"
  | "patch"
  | "patchMany"
  | "archiveVisibility"
  | "beginArchive"
  | "assignOwner"
  | "retireModelOverride"
  | "settingsPreview"
  | "patchRowLocal"
  | "isPreparedWorkSession"
  | "reset"
> &
  Omit<ReturnType<typeof createSessionScopedOperations>, "retireConnection" | "dispose"> &
  Pick<
    SessionRoster,
    | "list"
    | "listSnapshot"
    | "subscribeList"
    | "observeList"
    | "refreshList"
    | "refresh"
    | "refreshReplacement"
  > &
  Pick<ReturnType<typeof createSessionReconciliation>, "observeRow" | "captureReconcile"> &
  Pick<ReturnType<typeof createSessionDeletions>, "delete" | "deleteMany" | "deletionState"> & {
    [K in SessionGroupMethod as `groups${Capitalize<K>}`]: SessionGroups[K];
  } & {
    readonly githubPublication: Pick<ReturnType<typeof createSessionGitHubPublication>, "attach">;
    readonly state: SessionState;
    /** Broad observer outage, independent of query and operation errors. */
    readonly eventSubscriptionError: string | null;
    /** Advances for every publication, including pending facts outside state. */
    readonly revision: number;
    /** Memory-only presentation; never authority for mutations or live row observations. */
    readonly presentation: Pick<SessionState, "result" | "agentId" | "resultCached"> & {
      profileId?: string | null;
    };
    /** Advances only when a canonical sessions.list result is published. */
    readonly canonicalListRevision: number;
    /** Initial routing hints only; cached agent discovery never grants live authority. */
    readonly cachedRoutingDefaults?: {
      readonly mainKey: string;
      readonly scope: "per-sender" | "global";
    };
    whenCachedRosterSettled: () => Promise<void>;
    captureBootRoster: () => BootRoster | null;
    captureConnectionScope: () => SessionConnectionScope | null;
    isConnectionScopeCurrent: (scope: SessionConnectionScope) => boolean;
    describe: SessionRoster["observations"]["descriptions"]["describe"];
    /** Admits history through lifecycle fences; defaults-only never authorizes row publication. */
    reconcile: ReturnType<ReturnType<typeof createSessionReconciliation>["captureReconcile"]>;
    inheritRow: (
      row: GatewaySessionRow,
      previous: GatewaySessionRow | undefined,
      donor?: GatewaySessionRow,
    ) => GatewaySessionRow;
    projectRows: SessionRoster["observations"]["projectRows"];
    isRunVisuallyActive: (row: GatewaySessionRow) => boolean;
    reconcileRunTerminal: (terminal: SessionRunTerminal) => boolean;
    /** Schedules background list refreshes without replacing queued foreground queries. */
    invalidate: () => void;
    /** Reconciles an operation's agent without claiming the foreground query. */
    reconcileMutation: (agentId?: string | null) => Promise<SessionRefreshOutcome>;
    capturePermissionObservation: ReturnType<typeof createSessionPermissionProjection>["capture"];
    think: ReturnType<typeof createSessionThinkingClaims>["get"];
    pullRequestSummary: (key: string) => SessionCatalogPullRequestSummary | undefined;
    capturePullRequestEpoch: (key: string) => object;
    setPullRequestSummary: (
      key: string,
      summary: SessionCatalogPullRequestSummary | undefined,
      epoch?: object,
    ) => void;
    subscribeCreated: (listener: (key: string) => void) => () => void;
    subscribe: (listener: (state: SessionState) => void) => () => void;
    dispose: () => void;
  };
