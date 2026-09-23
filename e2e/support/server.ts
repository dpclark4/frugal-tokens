import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchiveDatabase } from "../../src/server/database.ts";
import { migrateTestDatabase } from "../../src/server/databaseTestUtils.ts";
import { setTitleGenerationEnabled } from "../../src/server/titleGeneration.ts";

export async function startServer() {
  const directory = Deno.makeTempDirSync({ prefix: "frugal-e2e-" });
  const databasePath = join(directory, "archive.sqlite");
  let child: Deno.ChildProcess | undefined;
  let stdout: Promise<void> | undefined;
  let stderr: Promise<string> | undefined;
  let logs = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function stop() {
    clearTimeout(timer);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await child.status;
      await stdout;
      await stderr;
    }
    Deno.removeSync(directory, { recursive: true });
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
    child = new Deno.Command(Deno.execPath(), {
      cwd: root,
      args: [
        "run",
        "--allow-env",
        `--allow-read=${root},${directory}`,
        `--allow-write=${directory}`,
        "--allow-net=0.0.0.0:0",
        "e2e/support/main.ts",
      ],
      clearEnv: true,
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
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const listening = Promise.withResolvers<string>();
    stdout = child.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream<string>({
        write(chunk) {
          logs += chunk;
          const match = logs.match(/API listening on http:\/\/localhost:(\d+)/);
          if (match) listening.resolve(`http://127.0.0.1:${match[1]}`);
        },
      }),
    );
    stderr = new Response(child.stderr).text();
    const url = await Promise.race([
      listening.promise,
      child.status.then(() => {
        throw new Error("Server exited before listening");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Server startup timed out")),
          30_000,
        );
      }),
    ]);
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
    throw new Error(`${error}\n${logs}\n${await stderr ?? ""}`);
  }
}
