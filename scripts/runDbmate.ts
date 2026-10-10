import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sqlitePath } from "../src/server/database.ts";

const databaseURL = process.env.FRUGAL_TOKENS_DATABASE_URL;
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const environment = {
  ...process.env,
  FRUGAL_TOKENS_DATABASE_URL: `sqlite:${sqlitePath(databaseURL)}`,
};
const child = spawn(process.execPath, [
  fileURLToPath(import.meta.resolve("dbmate/dist/cli.js")),
  "--migrations-dir",
  "db/migrations",
  "--env",
  "FRUGAL_TOKENS_DATABASE_URL",
  ...process.argv.slice(2),
], {
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
