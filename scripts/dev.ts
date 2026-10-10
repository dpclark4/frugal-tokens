import { spawn } from "node:child_process";
import { childExitCode } from "./childExitCode.ts";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const usage = "Usage: pnpm dev [web-port]";
const suppliedPort = args[0];

if (
  args.length > 1 || (suppliedPort !== undefined && !/^\d+$/.test(suppliedPort))
) {
  console.error(usage);
  process.exit(1);
}

const webPort = suppliedPort === undefined ? 5273 : Number(suppliedPort);
const apiPort = webPort + (9000 - 5273);

if (!Number.isInteger(webPort) || webPort < 1024 || apiPort > 65535) {
  console.error("Web port must be between 1024 and 61808.");
  process.exit(1);
}

console.log(`Starting web: http://localhost:${webPort}`);
console.log(`Starting API: http://localhost:${apiPort}`);

const child = spawn(process.execPath, [
  fileURLToPath(
    new URL(
      "./dist/bin/index.js",
      import.meta.resolve("concurrently/package.json"),
    ),
  ),
  "--kill-others-on-fail",
  "--names",
  "api,web",
  "pnpm dev:server",
  "pnpm dev:client",
], {
  env: {
    ...process.env,
    FRUGAL_TOKENS_WEB_PORT: String(webPort),
    PORT: String(apiPort),
  },
  stdio: "inherit",
});

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
