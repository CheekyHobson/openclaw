import { normalizeSessionsGroupBy, type SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const GROUP_BY_STORAGE_KEY = "openclaw:sessions:group-by";

export type SessionsTableState = {
  sortColumn: "key" | "updated";
  sortDir: "asc" | "desc";
  groupBy: SessionsGroupBy;
  page: number;
  pageSize: number;
};

export function loadStoredGroupBy(): SessionsGroupBy {
  return normalizeSessionsGroupBy(getSafeLocalStorage()?.getItem(GROUP_BY_STORAGE_KEY));
}

export function saveStoredGroupBy(mode: SessionsGroupBy): void {
  try {
    getSafeLocalStorage()?.setItem(GROUP_BY_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable or full; the in-memory selection still applies.
  }
}
