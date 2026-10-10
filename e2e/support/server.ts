import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { openArchiveDatabase } from "../../src/server/database.ts";
import { migrateTestDatabase } from "../../src/server/databaseTestUtils.ts";
import { setTitleGenerationEnabled } from "../../src/server/titleGeneration.ts";

export async function startServer() {
  const directory = mkdtempSync(join(tmpdir(), "frugal-e2e-"));
  const databasePath = join(directory, "archive.sqlite");
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let logs = "";
  let errors = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function stop() {
    clearTimeout(timer);
    if (child && closed) {
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child?.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(forceStop);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    const db = openArchiveDatabase(databasePath);
    try {
      migrateTestDatabase(db);
      setTitleGenerationEnabled(db, false);
    } finally {
      db.close();
    }
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const listening = Promise.withResolvers<string>();
    const server = spawn(process.execPath, [
      "--import",
      "tsx",
      "e2e/support/main.ts",
    ], {
      cwd: root,
      env: {
        HOME: directory,
        TZ: "UTC",
        FRUGAL_TOKENS_DATABASE_URL: `sqlite:${databasePath}`,
        PI_SESSION_DIR: join(root, "e2e/fixtures/pi"),
        CODEX_SESSION_DIR: join(root, "e2e/fixtures/codex"),
        FRUGAL_TOKENS_SYNC_INTERVAL_SECONDS: "0",
        SERVE_STATIC: "false",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = server;
    closed = new Promise((resolve) => server.once("close", () => resolve()));
    server.once("error", listening.reject);
    server.once("close", () => {
      listening.reject(new Error("Server exited before listening"));
    });
    server.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      logs += chunk;
      const match = logs.match(/API listening on http:\/\/localhost:(\d+)/);
      if (match) listening.resolve(`http://127.0.0.1:${match[1]}`);
    });
    server.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    timer = setTimeout(
      () => listening.reject(new Error("Server startup timed out")),
      30_000,
    );
    const url = await listening.promise;
    clearTimeout(timer);
    // This awaits startup's in-flight import, or runs a completed second sync.
    const response = await fetch(`${url}/api/sync`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status} ${body}`);
    }
    return { url, [Symbol.asyncDispose]: stop };
  } catch (error) {
    await stop();
    throw new Error(`${error}\n${logs}\n${errors}`);
  }
}
