import { spawn } from "node:child_process";
import { childExitCode } from "./childExitCode.ts";
import process from "node:process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [
  fileURLToPath(
    new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")),
  ),
  "run",
  "--project",
  "http",
  ...process.argv.slice(2).map((arg) =>
    arg === "--update-snapshots" ? "--update" : arg
  ),
], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = childExitCode(code, signal);
});
