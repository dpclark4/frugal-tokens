import { AssertionError, rejects, strictEqual } from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { assertSnapshot } from "../../e2e/support/snapshot.ts";
import { temporaryDirectory } from "./temporaryDirectory.ts";

const data = { label: 'quoted "value"', values: [1.25, null, true] };

for (const matches of [true, false]) {
  test(`snapshot comparison preserves expectations (matches=${matches})`, async (t) => {
    const path = join(temporaryDirectory(), "response.snap");
    const source = "export const snapshot = {};\n" +
      `snapshot[${JSON.stringify(`${t.task.fullTestName} 1`)}] = ` +
      `${JSON.stringify(JSON.stringify(data))};\n`;
    await writeFile(path, source);
    if (matches) {
      await assertSnapshot(t, data, path);
    } else {
      await rejects(
        () => assertSnapshot(t, { ...data, values: [2.5, null, true] }, path),
        AssertionError,
      );
    }
    strictEqual(await readFile(path, "utf8"), source);
  });
}

test("missing snapshots fail without creating expectations", async (t) => {
  const path = join(temporaryDirectory(), "missing.snap");
  await rejects(() => assertSnapshot(t, data, path), AssertionError);
  await rejects(() => stat(path), { code: "ENOENT" });
});
