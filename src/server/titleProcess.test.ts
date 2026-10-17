import { rejects, strictEqual } from "node:assert/strict";
import { test } from "vitest";
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
