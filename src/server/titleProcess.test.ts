import { rejects, strictEqual } from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runTitleProcess } from "./titleProcess.ts";
import { createTitleWorker } from "./titleWorker.ts";

test("title subprocess receives EOF instead of inherited stdin", async () => {
  const result = await runTitleProcess(process.execPath, [
    "-e",
    "process.stdin.resume(); process.stdin.on('end', () => console.log('OK'))",
  ], 5_000);
  strictEqual(result.code, 0);
  strictEqual(result.stdout.trim(), "OK");
});

test("kills a hung title subprocess at its deadline", async () => {
  await rejects(
    runTitleProcess(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ], 100),
    /timed out after 100ms; process killed/,
  );
});

test.skipIf(process.platform === "win32")(
  "preserves signal exit codes",
  async () => {
    const result = await runTitleProcess(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    strictEqual(result.code, 128 + constants.signals.SIGTERM);
  },
);

for (const detached of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `deadline settles with inherited pipes (escaped descendant: ${detached})`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "title-process-"));
      const heartbeat = join(directory, "heartbeat");
      const pidFile = join(directory, "pid");
      const child = `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready');
        setInterval(() => fs.appendFileSync(${
        JSON.stringify(heartbeat)
      }, '.'), 20);
      `;
      const launcher = `
        require('node:child_process').spawn(process.execPath, ['-e', ${
        JSON.stringify(child)
      }], {
          stdio: 'inherit', detached: ${detached}
        }).unref();
      `;
      try {
        await rejects(
          runTitleProcess(process.execPath, ["-e", launcher], 1_000),
          {
            message:
              "Codex title generation timed out after 1000ms; process killed",
            exitCode: 128 + constants.signals.SIGKILL,
          },
        );
        strictEqual(Number(await readFile(pidFile, "utf8")) > 0, true);
        // In the ordinary launcher case, the entire group must stop, not only
        // the wrapper. An escaped descendant must not prevent settlement either.
        if (!detached) {
          await delay(100);
          const before = await readFile(heartbeat, "utf8");
          await delay(100);
          strictEqual(await readFile(heartbeat, "utf8"), before);
        }
      } finally {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (
              !(error instanceof Error && "code" in error &&
                error.code === "ESRCH")
            ) throw error;
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test("reports missing executables and nonzero exits", async () => {
  await rejects(runTitleProcess("/nonexistent/title-test", []), /ENOENT/);
  const result = await runTitleProcess(process.execPath, [
    "-e",
    "console.error('auth failed'); process.exit(1)",
  ]);
  strictEqual(result.code, 1);
  strictEqual(result.stderr, "auth failed");
});

test("background worker returns immediately and deduplicates overlapping work", async () => {
  let finish!: () => void;
  let calls = 0;
  const start = createTitleWorker(() => {
    calls += 1;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const first = start();
  strictEqual(start(), first);
  await Promise.resolve();
  strictEqual(calls, 1);
  finish();
  await first;
  const second = start();
  await Promise.resolve();
  strictEqual(calls, 2);
  finish();
  await second;
});

test("background worker recovers after an exception", async () => {
  let calls = 0;
  const start = createTitleWorker(async () => {
    calls += 1;
    throw new Error("test failure");
  });
  await start();
  await start();
  strictEqual(calls, 2);
});
