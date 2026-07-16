import { dirname } from "node:path";
import { sqlitePath } from "../src/server/database.ts";

const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const databasePath = sqlitePath(databaseURL);

try {
  Deno.statSync(databasePath);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;

  // Removing a WAL database's main file can leave sidecars behind. A stale
  // shared-memory file may then make the replacement database fail with
  // SQLITE_IOERR when it is first opened in WAL mode.
  for (const suffix of ["-shm", "-wal"]) {
    try {
      Deno.removeSync(`${databasePath}${suffix}`);
    } catch (sidecarError) {
      if (!(sidecarError instanceof Deno.errors.NotFound)) throw sidecarError;
    }
  }
}

Deno.mkdirSync(dirname(databasePath), { recursive: true });
