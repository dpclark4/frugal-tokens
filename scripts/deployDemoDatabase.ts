import { join } from "node:path";

const environment = "production";

function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(
  command: string,
  args: string[],
  environmentVariables?: Record<string, string>,
) {
  const result = await new Deno.Command(command, {
    args,
    env: environmentVariables,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  }
}

const service = required("DEPLOY_RAILWAY_SERVICE");
const volume = required("DEPLOY_RAILWAY_VOLUME");
const sourceDatabase = required("FRUGAL_TOKENS_DATABASE_URL");
const temporaryDirectory = await Deno.makeTempDir({ prefix: "frugal-tokens-demo-" });
const snapshot = join(temporaryDirectory, "archive.sqlite");
const remoteDatabase = "/demo.sqlite";

try {
  await run(Deno.execPath(), [
    "run",
    "--allow-env=FRUGAL_TOKENS_DATABASE_URL",
    "--allow-read",
    "--allow-write",
    "--allow-run=sqlite3",
    "scripts/createDemoDatabase.ts",
    "--output",
    snapshot,
  ], { FRUGAL_TOKENS_DATABASE_URL: sourceDatabase });

  await run("railway", [
    "volume",
    "files",
    "--volume",
    volume,
    "upload",
    snapshot,
    remoteDatabase,
    "--overwrite",
    "--json",
  ]);
  await run("railway", [
    "up",
    "--service",
    service,
    "--environment",
    environment,
    "--ci",
    "-m",
    "Publish sanitized demo database",
  ]);

  console.log(`Published sqlite:/data${remoteDatabase}.`);
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}
