import { deepStrictEqual, ok } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import type { TestContext } from "vitest";
import { z } from "zod";
import { type JsonValue, parseJsonValue } from "../../src/shared/json.ts";

const snapshotsSchema = z.record(z.string(), z.string());

function escapeTemplate(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}

// Read trusted, checked-in snapshot modules without changing their format.
// Only JSON response values are compared; no runtime compatibility shim is used.
export async function assertSnapshot(
  context: TestContext,
  actual: JsonValue,
  path: string,
) {
  const file = new URL(path, new URL("../snapshots/", import.meta.url));
  const source = await readFile(file, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "export const snapshot = {};";
    }
    throw error;
  });
  const snapshots = snapshotsSchema.parse(runInNewContext(
    source.replace("export const snapshot = {};", "const snapshot = {};") +
      "\nsnapshot",
    {},
    { timeout: 1_000 },
  ));
  const key = `${context.task.fullTestName} 1`;
  const stored = snapshots[key];
  const update =
    context.expect.getState().snapshotState.snapshotUpdateState === "all";
  if (stored !== undefined) {
    const expected = parseJsonValue(
      z.string().parse(runInNewContext(
        `JSON.stringify((${stored}))`,
        {},
        { timeout: 1_000 },
      )),
    );
    if (!update) {
      deepStrictEqual(actual, expected, key);
      return;
    }
    if (isDeepStrictEqual(actual, expected)) return;
  } else {
    ok(update, `Missing snapshot: ${key}`);
  }
  snapshots[key] = `\n${JSON.stringify(actual, null, 2)}\n`;
  await writeFile(
    file,
    "export const snapshot = {};\n\n" +
      Object.entries(snapshots).map(([name, value]) =>
        `snapshot[\`${escapeTemplate(name)}\`] = \`${
          escapeTemplate(value)
        }\`;\n`
      ).join("\n"),
  );
}
