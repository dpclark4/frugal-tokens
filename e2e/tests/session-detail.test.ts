import { assertSnapshot } from "../support/snapshot.ts";
import { afterAll, beforeAll, describe, test } from "vitest";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  costScenarioResponseSchema,
  sessionDetailSchema,
} from "../../src/shared/sessionSchemas.ts";
import { getJson } from "../support/http.ts";
import { startServer } from "../support/server.ts";

const sessionPath = "/api/sessions/astra-full1-partial2";

test("Pi session detail includes full and partial cache misses", async (t) => {
  await using server = await startServer();
  const body = await getJson(server.url, `${sessionPath}?harness=pi`);
  const session = sessionDetailSchema.parse(body);
  strictEqual(session.id, "astra-full1-partial2");
  strictEqual(session.harness, "pi");
  strictEqual(
    session.turns.reduce(
      (sum, turn) => sum + (turn.cacheSummary?.fullMisses ?? 0),
      0,
    ),
    1,
  );
  strictEqual(
    session.turns.reduce(
      (sum, turn) => sum + (turn.cacheSummary?.partialHits ?? 0),
      0,
    ),
    2,
  );
  await assertSnapshot(t, body, "session-detail.snap");
});

describe("Pi session cost scenarios", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => await server?.[Symbol.asyncDispose]());
  for (const cacheTtl of ["5m", "1h"]) {
    test(cacheTtl, async (t) => {
      const body = await getJson(
        server.url,
        `${sessionPath}/cost-scenario?harness=pi&model=claude-sonnet-4-6&cacheTtl=${cacheTtl}`,
      );
      const scenario = costScenarioResponseSchema.parse(body);
      strictEqual(scenario.model, "claude-sonnet-4-6");
      strictEqual(scenario.cacheTtl, cacheTtl);
      await assertSnapshot(t, body, "session-cost-scenario.snap");
    });
  }
});

describe("session detail and cost scenario errors", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => await server?.[Symbol.asyncDispose]());
  const cases = [
    [`${sessionPath}?harness=invalid`, 400, "Invalid harness"],
    ["/api/sessions/missing?harness=pi", 404, "Session not found"],
    [`${sessionPath}?harness=codex`, 404, "Session not found"],
    [
      `${sessionPath}/cost-scenario?harness=invalid&model=gpt-6-astra`,
      400,
      "Invalid harness",
    ],
    [`${sessionPath}/cost-scenario?harness=pi`, 400, "Invalid model"],
    [
      `${sessionPath}/cost-scenario?harness=pi&model=invalid`,
      400,
      "Invalid model",
    ],
    [
      `${sessionPath}/cost-scenario?harness=pi&model=gpt-6-astra&cacheTtl=invalid`,
      400,
      "Invalid cache TTL",
    ],
    [
      "/api/sessions/missing/cost-scenario?harness=pi&model=gpt-6-astra",
      404,
      "Session not found",
    ],
  ] as const;
  for (const [path, status, error] of cases) {
    test(path, async () => {
      deepStrictEqual(await getJson(server.url, path, status), { error });
    });
  }
});
