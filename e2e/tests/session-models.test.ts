import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { sessionFilterOptionsSchema } from "../../src/shared/sessionBrowserSchemas.ts";
import { sessionListResponseSchema } from "../../src/shared/sessionSchemas.ts";
import { getJson } from "../support/http.ts";
import { startServer } from "../support/server.ts";

Deno.test("model options and multi-select filtering agree across harnesses and pages", async () => {
  await using server = await startServer();
  for (const harness of ["all", "pi", "codex", "opencode"]) {
    const response = await fetch(
      `${server.url}/api/sessions/filter-options?harness=${harness}`,
    );
    strictEqual(response.status, 200);
    match(response.headers.get("Server-Timing") ?? "", /database;dur=/);
    const { models } = sessionFilterOptionsSchema.parse(await response.json());
    if (harness === "all") ok(models.length > 1);
    deepStrictEqual(
      models.map((model) => model.sessionCount),
      models.map((model) => model.sessionCount).toSorted((a, b) => b - a),
    );
    for (const model of models) {
      const query = new URLSearchParams({
        harness,
        model: model.id,
        pageSize: "1",
      });
      const list = sessionListResponseSchema.parse(
        await getJson(server.url, `/api/sessions?${query}`),
      );
      strictEqual(list.pagination.totalItems, model.sessionCount);
      strictEqual(list.items.length, 1);
    }
    const query = new URLSearchParams({ harness, pageSize: "100" });
    const all = sessionListResponseSchema.parse(
      await getJson(server.url, `/api/sessions?${query}`),
    );
    for (const model of models) query.append("model", model.id);
    const selected = sessionListResponseSchema.parse(
      await getJson(server.url, `/api/sessions?${query}`),
    );
    deepStrictEqual(selected, all);
  }
  const invalid = await getJson(
    server.url,
    "/api/sessions/filter-options?harness=invalid",
    400,
  );
  strictEqual(invalid.error, "Invalid harness");
  const emptyModel = await getJson(server.url, "/api/sessions?model=", 400);
  strictEqual(emptyModel.error, "Invalid model selection");
});
