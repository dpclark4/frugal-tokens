import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import type { RunManifest } from "./types.ts";

const DEFAULT_DIRECTORY =
  "~/.local/share/frugal-tokens/diagnostics/responses-cache-lab";

function homeDirectory(): string {
  return Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
}

export function resolvePath(value: string): string {
  if (value === "~") return homeDirectory();
  if (value.startsWith("~/")) return join(homeDirectory(), value.slice(2));
  return isAbsolute(value) ? value : join(Deno.cwd(), value);
}

export function defaultOutputDirectory(): string {
  return resolvePath(
    Deno.env.get("RESPONSES_CACHE_LAB_DIR") || DEFAULT_DIRECTORY,
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await Deno.chmod(path, 0o700);
  } catch {
    // chmod is unavailable on some filesystems; mkdir mode still applies there.
  }
}

async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await Deno.writeFile(
    path,
    typeof data === "string" ? new TextEncoder().encode(data) : data,
    {
      create: true,
      mode: 0o600,
    },
  );
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    // chmod is unavailable on some filesystems; write mode still applies there.
  }
}

function timestampStem(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "scenario";
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface RunStore {
  baseDirectory: string;
  runDirectory: string;
  rawDirectory: string;
  requestDirectory: string;
  manifestPath: string;
  manifest: RunManifest;
  writeManifest(): Promise<void>;
  writeRawResponse(
    ordinal: number,
    bytes: Uint8Array,
    stream: boolean,
  ): Promise<string>;
  writeRequest(ordinal: number, body: string): Promise<string>;
}

export async function createRunStore(
  baseDirectory: string,
  manifest: RunManifest,
): Promise<RunStore> {
  const resolvedBase = resolvePath(baseDirectory);
  await ensurePrivateDirectory(resolvedBase);
  const runDirectory = join(
    resolvedBase,
    `${timestampStem()}-${safeStem(manifest.scenarioId)}-${
      manifest.runId.slice(0, 12)
    }`,
  );
  const rawDirectory = join(runDirectory, "raw-responses");
  const requestDirectory = join(runDirectory, "requests");
  await ensurePrivateDirectory(runDirectory);
  await ensurePrivateDirectory(rawDirectory);
  await ensurePrivateDirectory(requestDirectory);
  const manifestPath = join(runDirectory, "manifest.json");

  const store: RunStore = {
    baseDirectory: resolvedBase,
    runDirectory,
    rawDirectory,
    requestDirectory,
    manifestPath,
    manifest,
    async writeManifest() {
      await writePrivateFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
    async writeRawResponse(ordinal, bytes, stream) {
      const path = join(
        rawDirectory,
        `${String(ordinal).padStart(4, "0")}.${stream ? "sse" : "json"}`,
      );
      await writePrivateFile(path, bytes);
      return relative(runDirectory, path);
    },
    async writeRequest(ordinal, body) {
      const path = join(
        requestDirectory,
        `${String(ordinal).padStart(4, "0")}.json`,
      );
      await writePrivateFile(path, body);
      return relative(runDirectory, path);
    },
  };
  await store.writeManifest();
  return store;
}
