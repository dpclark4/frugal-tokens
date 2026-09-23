import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  sessionListResponseSchema,
  sessionSortKeySchema,
} from "../../src/shared/sessionSchemas.ts";
import { getJson } from "../support/http.ts";
import { startServer } from "../support/server.ts";

Deno.test("sessions filters and pagination", async (t) => {
  await using server = await startServer();
  const list = async (query: string) =>
    sessionListResponseSchema.parse(
      await getJson(server.url, `/api/sessions?pageSize=100&${query}`),
    );
  const all = await list("sortBy=cost&sortDirection=desc");
  const cases = [
    "harness=pi",
    "harness=codex",
    "harness=opencode",
    "misses=ttl",
    "misses=compaction",
    "misses=thinking-change",
    "misses=model-change",
    "misses=full-miss",
    "misses=partial-miss",
    "misses=ttl,thinking-change",
    "misses=none",
    "harness=pi&misses=thinking-change",
  ];
  for (const query of cases) {
    await t.step(query, async (t) => {
      const body = await list(`${query}&sortBy=cost&sortDirection=desc`);
      await t.assertSnapshot({
        ids: body.items.map((item) => item.id),
        pagination: body.pagination,
      }, { path: "../snapshots/sessions-filters.snap" });
    });
  }
  await t.step(
    "pagination preserves cost order without duplicates",
    async () => {
      const ids: string[] = [];
      const totalPages = Math.ceil(all.pagination.totalItems / 2);
      for (let page = 1; page <= totalPages; page++) {
        const body = sessionListResponseSchema.parse(
          await getJson(
            server.url,
            `/api/sessions?page=${page}&pageSize=2&sortBy=cost&sortDirection=desc`,
          ),
        );
        strictEqual(body.pagination.page, page);
        strictEqual(body.pagination.pageSize, 2);
        strictEqual(body.pagination.totalItems, all.pagination.totalItems);
        strictEqual(body.pagination.totalPages, totalPages);
        ids.push(...body.items.map((item) => item.id));
      }
      deepStrictEqual(ids, all.items.map((item) => item.id));
      strictEqual(new Set(ids).size, ids.length);
      const beyond = await list("page=999");
      deepStrictEqual(beyond.items, []);
      strictEqual(beyond.pagination.totalItems, all.pagination.totalItems);
    },
  );
  for (const key of sessionSortKeySchema.options) {
    for (const direction of ["asc", "desc"]) {
      await t.step(`sort ${key} ${direction}`, async (t) => {
        const body = await list(`sortBy=${key}&sortDirection=${direction}`);
        strictEqual(body.items.length, all.items.length);
        if (key === "cost") {
          const costs = body.items.map((item) => item.computedCost ?? 0);
          deepStrictEqual(
            costs,
            costs.toSorted((a, b) => direction === "asc" ? a - b : b - a),
          );
        }
        await t.assertSnapshot(body.items.map((item) => item.id), {
          path: "../snapshots/sessions-filters.snap",
        });
      });
    }
  }
});

Deno.test("sessions reject invalid filters", async (t) => {
  await using server = await startServer();
  for (
    const query of [
      "harness=invalid",
      "misses=invalid",
      "sortBy=invalid",
      "sortDirection=invalid",
    ]
  ) {
    await t.step(query, async (t) => {
      const body = await getJson(server.url, `/api/sessions?${query}`, 400);
      await t.assertSnapshot(body, {
        path: "../snapshots/sessions-filters.snap",
      });
    });
  }
});
