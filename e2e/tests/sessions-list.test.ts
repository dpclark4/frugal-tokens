import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startServer } from "../support/server.ts";

const sessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({ id: z.string() }),
});

async function expectedSessionIDs() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const piIDs: string[] = [];
  for await (
    const entry of Deno.readDir(join(root, "e2e/fixtures/pi"))
  ) {
    if (entry.isFile && entry.name.endsWith(".jsonl")) {
      // Pi API IDs fall back to the fixture filename.
      piIDs.push(entry.name.slice(0, -".jsonl".length));
    }
  }
  const codexIDs: string[] = [];
  for await (
    const entry of Deno.readDir(join(root, "e2e/fixtures/codex"))
  ) {
    if (
      !entry.isFile || !entry.name.endsWith(".jsonl") ||
      (!entry.name.startsWith("rollout-") &&
        !entry.name.startsWith("rollout_"))
    ) continue;
    // Codex API IDs come from transcript session_meta payloads, not filenames.
    const text = await Deno.readTextFile(
      join(root, "e2e/fixtures/codex", entry.name),
    );
    let id: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parsed = sessionMetaSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        id = parsed.data.payload.id;
        break;
      }
    }
    if (id === undefined) {
      throw new Error(`No session_meta id in ${entry.name}`);
    }
    codexIDs.push(id);
  }
  return { piIDs, codexIDs };
}

Deno.test("sessions table lists imported Pi and Codex sessions", async (t) => {
  const { piIDs, codexIDs } = await expectedSessionIDs();
  await using server = await startServer();
  const response = await fetch(
    `${server.url}/api/sessions?page=1&pageSize=100&sortBy=cost&sortDirection=desc`,
    { signal: AbortSignal.timeout(10_000) },
  );
  strictEqual(response.status, 200);
  const body = await response.json();
  strictEqual(body.items.length, piIDs.length + codexIDs.length);
  deepStrictEqual(
    body.items.map((item: { harness: string }) => item.harness).sort(),
    [
      ...codexIDs.map(() => "codex"),
      ...piIDs.map(() => "pi"),
    ].sort(),
  );
  deepStrictEqual(
    new Set(body.items.map((item: { id: string }) => item.id)),
    new Set([...piIDs, ...codexIDs]),
  );
  await t.assertSnapshot(body, {
    path: "../snapshots/sessions-list.snap",
  });
});
