import fsSync from "node:fs";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { lstatIfExists } from "../infra/path-existence.js";
import { resolveSqliteDatabaseFilePaths, SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";

export async function assertFreshRestoreTarget(databasePath: string): Promise<void> {
  for (const candidate of resolveSqliteDatabaseFilePaths(databasePath)) {
    if (await lstatIfExists(candidate, "ENOENT")) {
      throw new Error(`Fresh SQLite restore path already exists: ${candidate}`);
    }
  }
}

export function assertNoSqliteSidecarsSync(databasePath: string, errorPrefix: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      fsSync.lstatSync(sidecarPath);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new Error(`${errorPrefix}: ${sidecarPath}`);
  }
}
