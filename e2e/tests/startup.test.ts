import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { getJson } from "../support/http.ts";

for (const command of ["start", "dev:server"]) {
  test(`${command} loads its database configuration from .env`, async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "frugal-startup-"));
    let stop: (() => Promise<void>) | undefined;
    let logs = "";
    try {
      await cp(join(root, "package.json"), join(directory, "package.json"));
      await cp(join(root, "db"), join(directory, "db"), { recursive: true });
      for (const name of ["src", "scripts", "node_modules"]) {
        await symlink(join(root, name), join(directory, name), "junction");
      }
      await mkdir(join(directory, "dist"));
      await writeFile(
        join(directory, "dist/index.html"),
        "Fixture application",
      );
      await writeFile(
        join(directory, ".env"),
        [
          `FRUGAL_TOKENS_DATABASE_URL="sqlite:${
            join(directory, "archive.sqlite")
          }"`,
          "FRUGAL_TOKENS_SYNC_INTERVAL_SECONDS=0",
          "SERVE_STATIC=false",
          "PORT=0",
        ].join("\n"),
      );
      // Do not inherit the database URL or personal importer configuration:
      // the command itself must load .env before running migrations.
      const child = spawn("pnpm", [command], {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, TZ: "UTC" },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const listening = Promise.withResolvers<string>();
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          resolve();
          listening.reject(new Error("Command exited before listening"));
        });
      });
      child.once("error", listening.reject);
      const terminate = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (
            !(error instanceof Error) || !("code" in error) ||
            error.code !== "ESRCH"
          ) throw error;
        }
      };
      const timeout = setTimeout(
        () => listening.reject(new Error("Command startup timed out")),
        30_000,
      );
      stop = async () => {
        clearTimeout(timeout);
        terminate("SIGTERM");
        const forceStop = setTimeout(() => terminate("SIGKILL"), 5_000);
        try {
          await closed;
        } finally {
          clearTimeout(forceStop);
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8").on("data", (chunk: string) => {
          logs += chunk;
          const match = logs.match(/API listening on http:\/\/localhost:(\d+)/);
          if (match) listening.resolve(`http://127.0.0.1:${match[1]}`);
        });
      }
      const url = await listening.promise;
      clearTimeout(timeout);
      deepStrictEqual(await getJson(url, "/health"), { status: "ok" });
      const sessions = await getJson(url, "/api/sessions");
      deepStrictEqual(sessions.items, []);
      if (command === "start") {
        const response = await fetch(`${url}/sessions`, {
          signal: AbortSignal.timeout(10_000),
        });
        strictEqual(response.status, 200);
        strictEqual(await response.text(), "Fixture application");
      }
    } catch (error) {
      throw new Error(`${error}\n${logs}`, { cause: error });
    } finally {
      try {
        await stop?.();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
