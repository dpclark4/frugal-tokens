import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  }
}

const environment = {
  ...process.env,
  VITE_API_BASE_URL: required("DEPLOY_API_BASE_URL"),
};
const project = required("DEPLOY_PAGES_PROJECT");

await run("pnpm", ["build"], environment);
await run("pnpm", [
  "exec",
  "wrangler",
  "pages",
  "deploy",
  "dist",
  `--project-name=${project}`,
  "--branch=main",
  "--commit-dirty=true",
], environment);
