import type { createSessionsPage } from "./sessions-page-state.ts";

type SessionsView = ReturnType<ReturnType<typeof createSessionsPage>["view"]>;
type OptionalViewProps =
  | "labelDisabledReason"
  | "patchAdminDisabledReason"
  | "groupWriteDisabledReason"
  | "deleteArchivedDisabledReason"
  | "deleteSelectedDisabledReason";

export type SessionsProps = Omit<SessionsView, OptionalViewProps | "sessionMenu"> & {
  sessionMenu: Pick<NonNullable<SessionsView["sessionMenu"]>, "key"> | null;
} & Partial<Pick<SessionsView, OptionalViewProps>>;
