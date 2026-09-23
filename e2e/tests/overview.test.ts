import { strictEqual } from "node:assert/strict";
import { startServer } from "../support/server.ts";

Deno.test("overview aggregates imported sessions", async (t) => {
  await using server = await startServer();
  const response = await fetch(`${server.url}/api/overview?range=all`, {
    signal: AbortSignal.timeout(10_000),
  });
  strictEqual(response.status, 200);
  await t.assertSnapshot(await response.json(), {
    path: "../snapshots/overview.snap",
  });
});
