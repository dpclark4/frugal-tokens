import { assertSnapshot } from "../support/snapshot.ts";
import { afterAll, beforeAll, describe, test } from "vitest";
import { deepStrictEqual, ok } from "node:assert/strict";
import {
  activityOverviewResponseSchema,
  harnessesResponseSchema,
  performanceResponseSchema,
  sessionDistributionResponseSchema,
  toolCallsResponseSchema,
  usageResponseSchema,
  workRhythmOverviewResponseSchema,
} from "../../src/shared/sessionSchemas.ts";
import { getJson } from "../support/http.ts";
import { startServer } from "../support/server.ts";

describe("dashboard endpoints aggregate imported sessions", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => await server?.[Symbol.asyncDispose]());
  test("all time includes full history across dashboard endpoints", async () => {
    const overview = activityOverviewResponseSchema.parse(
      await getJson(
        server.url,
        "/api/activity-overview?range=all&harness=pi&timeZone=UTC",
      ),
    );
    const rhythm = workRhythmOverviewResponseSchema.parse(
      await getJson(
        server.url,
        "/api/work-rhythm?range=all&harness=pi&timeZone=UTC",
      ),
    );
    const distributions = sessionDistributionResponseSchema.parse(
      await getJson(
        server.url,
        "/api/session-shape?range=all&harness=pi",
      ),
    );
    ok(overview.spendComposition.days.length > 0);
    ok(overview.startDate > "1970-01-01");
    deepStrictEqual(rhythm.workRhythm.range.start, overview.startDate);
    deepStrictEqual(distributions.rangeDays, "all");
    ok(distributions.sampleSize > 0);
    const empty = workRhythmOverviewResponseSchema.parse(
      await getJson(
        server.url,
        "/api/work-rhythm?range=all&harness=opencode&timeZone=UTC",
      ),
    );
    deepStrictEqual(empty.workRhythm.range.start, empty.workRhythm.range.end);
  });

  const cases = [
    ["harnesses", "/api/harnesses", harnessesResponseSchema],
    ["usage", "/api/usage?range=30", usageResponseSchema],
    [
      "activity overview",
      "/api/activity-overview?range=30&timeZone=UTC",
      activityOverviewResponseSchema,
    ],
    [
      "work rhythm",
      "/api/work-rhythm?range=30&timeZone=UTC",
      workRhythmOverviewResponseSchema,
    ],
    [
      "session shape",
      "/api/session-shape?range=30",
      sessionDistributionResponseSchema,
    ],
    ["performance", "/api/performance", performanceResponseSchema],
    ["tool calls", "/api/tool-calls?range=30", toolCallsResponseSchema],
    [
      "expanded tool calls",
      "/api/tool-calls?range=30&expand=true",
      toolCallsResponseSchema,
    ],
    [
      "Pi activity over 90 days",
      "/api/activity-overview?range=90&harness=pi&timeZone=America/Los_Angeles",
      activityOverviewResponseSchema,
    ],
    [
      "empty activity",
      "/api/activity-overview?range=30&harness=opencode&timeZone=UTC",
      activityOverviewResponseSchema,
    ],
  ] as const;
  for (const [name, path, schema] of cases) {
    test(name, async (t) => {
      const body = await getJson(server.url, path);
      schema.parse(body);
      if (name === "harnesses") {
        deepStrictEqual(body.harnesses, ["pi", "codex"]);
      }
      if (name === "session shape") ok(body.sampleSize > 0);
      await assertSnapshot(t, body, "dashboard.snap");
    });
  }
});

describe("dashboard endpoints reject invalid filters", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => await server?.[Symbol.asyncDispose]());
  const paths = [
    ...[
      "usage",
      "overview",
      "cache-misses/overview",
      "activity-overview",
      "work-rhythm",
      "session-shape",
      "performance",
      "tool-calls",
    ].map((endpoint) => `/api/${endpoint}?harness=invalid`),
    ...["activity-overview", "work-rhythm", "session-shape", "tool-calls"].map(
      (endpoint) => `/api/${endpoint}?range=invalid`,
    ),
    ...["activity-overview", "work-rhythm"].map(
      (endpoint) => `/api/${endpoint}?timeZone=invalid`,
    ),
    "/api/tool-calls?expand=invalid",
    "/api/performance?openai=invalid",
    "/api/performance?anthropic=invalid",
  ];
  for (const path of paths) {
    test(path, async (t) => {
      const body = await getJson(server.url, path, 400);
      await assertSnapshot(t, body, "dashboard-errors.snap");
    });
  }
});
