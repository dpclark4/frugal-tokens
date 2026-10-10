import process from "node:process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { sqlitePath } from "../src/server/database.ts";

const databaseURL = process.env.FRUGAL_TOKENS_DATABASE_URL;
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const databasePath = sqlitePath(databaseURL);

try {
  statSync(databasePath);
} catch (error) {
  if (
    !(error instanceof Error) || !("code" in error) ||
    error.code !== "ENOENT"
  ) throw error;

  // Removing a WAL database's main file can leave sidecars behind. A stale
  // shared-memory file may then make the replacement database fail with
  // SQLITE_IOERR when it is first opened in WAL mode.
  for (const suffix of ["-shm", "-wal"]) {
    try {
      rmSync(`${databasePath}${suffix}`);
    } catch (sidecarError) {
      if (
        !(sidecarError instanceof Error) || !("code" in sidecarError) ||
        sidecarError.code !== "ENOENT"
      ) throw sidecarError;
    }
  }
}

mkdirSync(dirname(databasePath), { recursive: true });
