import { strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { test } from "vitest";
import { childExitCode } from "./childExitCode.ts";

test("child exit codes preserve success and ordinary failures", () => {
  strictEqual(childExitCode(0, null), 0);
  strictEqual(childExitCode(1, null), 1);
  strictEqual(childExitCode(42, null), 42);
});

test("child exit codes prefer an explicit code and handle missing status", () => {
  strictEqual(childExitCode(0, "SIGTERM"), 0);
  strictEqual(childExitCode(null, null), 1);
});

test("child exit codes distinguish cancellation from ordinary failures", () => {
  strictEqual(childExitCode(null, "SIGINT"), 130);
  strictEqual(childExitCode(null, "SIGTERM"), 143);
  strictEqual(childExitCode(null, "SIGKILL"), 137);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`signal-terminated children preserve ${signal} status`, async () => {
    const child = spawn(process.execPath, [
      "-e",
      `process.kill(process.pid, "${signal}")`,
    ], { stdio: "ignore" });
    const [code, receivedSignal] = await once(child, "close");
    strictEqual(code, null);
    strictEqual(receivedSignal, signal);
    strictEqual(
      childExitCode(code, receivedSignal),
      signal === "SIGINT" ? 130 : 143,
    );
  });
}
