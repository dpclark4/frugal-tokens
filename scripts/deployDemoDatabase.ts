import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import process from "node:process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sqlitePath } from "../src/server/database.ts";

const environment = "production";
const volumeListing = z.object({
  files: z.array(z.object({
    path: z.string(),
    type: z.string(),
    modifiedAt: z.string().datetime({ offset: true }).nullable(),
  })),
});
const snapshotPath =
  /^\/demo-archive-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

type VolumeListing = z.infer<typeof volumeListing>;

function obsoleteDatabaseFiles({ files }: VolumeListing): string[] {
  const paths = new Set(
    files.filter((file) => file.type === "file").map((file) => file.path),
  );
  const published = files.filter((file) =>
    file.type === "file" && file.path.endsWith(".published") &&
    snapshotPath.test(file.path.slice(0, -".published".length)) &&
    paths.has(file.path.slice(0, -".published".length))
  ).map((file) => {
    if (file.modifiedAt === null) {
      throw new Error("Missing snapshot publication time");
    }
    return {
      path: file.path.slice(0, -".published".length),
      time: Date.parse(file.modifiedAt),
    };
  }).sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));

  // Older snapshots have no success markers; keep them until two verified
  // rollback versions exist. Failed uploads never count toward retention.
  if (published.length < 2) return [];
  const retained = new Set(published.slice(0, 2).map((file) => file.path));
  return [...paths].filter((path) =>
    snapshotPath.test(path) && !retained.has(path)
  )
    .flatMap((path) =>
      ["-wal", "-shm", "-journal", ".published", ""].map((suffix) =>
        `${path}${suffix}`
      )
        .filter((candidate) => paths.has(candidate))
    );
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(
  command: string,
  args: string[],
  environmentVariables?: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    env: { ...process.env, ...environmentVariables },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  }
}

const service = required("DEPLOY_RAILWAY_SERVICE");
const volume = required("DEPLOY_RAILWAY_VOLUME");
const sourceDatabase = required("FRUGAL_TOKENS_DATABASE_URL");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "frugal-tokens-demo-"));
const snapshot = join(temporaryDirectory, "archive.sqlite");
// Upload a new file rather than overwriting the database open in the running
// service. The previous file remains available if this deployment fails.
const remoteDatabase = `/demo-archive-${crypto.randomUUID()}.sqlite`;
const remoteDatabaseURL = `sqlite:/data${remoteDatabase}`;

try {
  await run(process.execPath, [
    "--import",
    "tsx",
    "scripts/createDemoDatabase.ts",
    "--output",
    snapshot,
  ], {
    FRUGAL_TOKENS_DATABASE_URL: `sqlite:${sqlitePath(sourceDatabase)}`,
  });

  // Plan cleanup before uploading; delete only after deployment succeeds.
  const { stdout } = await promisify(execFile)("railway", [
    "volume",
    "files",
    "--volume",
    volume,
    "list",
    "/",
    "--json",
  ], { maxBuffer: 10 * 1024 * 1024 });
  const obsoleteFiles = obsoleteDatabaseFiles(
    volumeListing.parse(JSON.parse(stdout)),
  );

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
  // Point the next deployment at the uploaded snapshot. --skip-deploys keeps
  // the running service on its old database until `railway up` replaces it.
  await run("railway", [
    "variable",
    "set",
    "--service",
    service,
    "--environment",
    environment,
    "--skip-deploys",
    `FRUGAL_TOKENS_DATABASE_URL=${remoteDatabaseURL}`,
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

  console.log(`Published ${remoteDatabaseURL}.`);
  const marker = join(temporaryDirectory, "published");
  await writeFile(marker, "");
  await run("railway", [
    "volume",
    "files",
    "--volume",
    volume,
    "upload",
    marker,
    `${remoteDatabase}.published`,
    "--json",
  ]);
  for (const path of obsoleteFiles) {
    await run("railway", [
      "volume",
      "files",
      "--volume",
      volume,
      "delete",
      path,
      "--yes",
      "--json",
    ]);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true });
}
