import { assertSnapshot } from "../support/snapshot.ts";
import { test } from "vitest";
import { strictEqual } from "node:assert/strict";
import { startServer } from "../support/server.ts";

test("cache misses overview aggregates imported sessions", async (t) => {
  await using server = await startServer();
  const response = await fetch(
    `${server.url}/api/cache-misses/overview?range=all`,
    { signal: AbortSignal.timeout(10_000) },
  );
  strictEqual(response.status, 200);
  await assertSnapshot(t, await response.json(), "cache-misses-overview.snap");
});
