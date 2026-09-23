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

Deno.test("dashboard endpoints aggregate imported sessions", async (t) => {
  await using server = await startServer();
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
    await t.step(name, async (t) => {
      const body = await getJson(server.url, path);
      schema.parse(body);
      if (name === "harnesses") {
        deepStrictEqual(body.harnesses, ["pi", "codex"]);
      }
      if (name === "session shape") ok(body.sampleSize > 0);
      await t.assertSnapshot(body, { path: "../snapshots/dashboard.snap" });
    });
  }
});

Deno.test("dashboard endpoints reject invalid filters", async (t) => {
  await using server = await startServer();
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
    await t.step(path, async (t) => {
      const body = await getJson(server.url, path, 400);
      await t.assertSnapshot(body, {
        path: "../snapshots/dashboard-errors.snap",
      });
    });
  }
});
