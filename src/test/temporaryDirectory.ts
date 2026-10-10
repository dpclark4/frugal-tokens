import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "frugal-test-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
