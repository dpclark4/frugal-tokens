import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { Hono } from "hono";
import { sessionBrowserRoutes } from "./routes.ts";
import type { SessionBrowserRepository } from "./repository.ts";

Deno.test("session browser route preserves mounting, filters, pagination, and timing", async () => {
  let args: Parameters<SessionBrowserRepository["listSessions"]> | undefined;
  let enriched = false;
  const result = {
    items: [],
    pagination: { page: 2, pageSize: 25, totalItems: 0, totalPages: 0 },
  };
  const app = new Hono().route(
    "/api/sessions",
    sessionBrowserRoutes({
      listModels() {
        return [];
      },
      listSessions(...received) {
        args = received;
        return result;
      },
    }, {
      enrichSessionSummaries(items) {
        enriched = true;
        return items;
      },
      getSession() {
        throw new Error("Empty lists should not load session details");
      },
    }),
  );
  const response = await app.request(
    "/api/sessions?page=2&pageSize=25&harness=pi&misses=model-change&sortBy=name&model=provider%2Fone&model=two",
  );
  strictEqual(response.status, 200);
  deepStrictEqual(await response.json(), result);
  deepStrictEqual(args, [2, 25, "pi", ["model-change"], {
    key: "name",
    direction: "asc",
  }, ["provider/one", "two"]]);
  strictEqual(enriched, true);
  match(
    response.headers.get("Server-Timing") ?? "",
    /^database;dur=.*enrichment;dur=.*total;dur=/,
  );
});

Deno.test("model options route returns ranked models, validates harness, and includes timing", async () => {
  const calls: Array<string | undefined> = [];
  const models = [{ id: "one", sessionCount: 10 }, {
    id: "two",
    sessionCount: 2,
  }];
  const app = new Hono().route(
    "/api/sessions",
    sessionBrowserRoutes({
      listModels(harness) {
        calls.push(harness);
        return models;
      },
      listSessions() {
        throw new Error("Options must not load session lists");
      },
    }, {
      enrichSessionSummaries() {
        throw new Error("Options must not enrich sessions");
      },
      getSession() {
        throw new Error("Options must not load session details");
      },
    }),
  );
  for (const query of ["", "?harness=pi"]) {
    const response = await app.request(`/api/sessions/filter-options${query}`);
    strictEqual(response.status, 200);
    deepStrictEqual(await response.json(), { models });
    match(
      response.headers.get("Server-Timing") ?? "",
      /^database;dur=.*total;dur=/,
    );
  }
  const invalid = await app.request(
    "/api/sessions/filter-options?harness=invalid",
  );
  strictEqual(invalid.status, 400);
  await invalid.body?.cancel();
  deepStrictEqual(calls, [undefined, "pi"]);
});

Deno.test("session browser route rejects invalid queries before database access", async () => {
  const app = new Hono().route(
    "/api/sessions",
    sessionBrowserRoutes({
      listModels() {
        return [];
      },
      listSessions() {
        throw new Error("Invalid queries should not access the database");
      },
    }, {
      enrichSessionSummaries() {
        throw new Error("Invalid queries should not enrich summaries");
      },
      getSession() {
        throw new Error("Invalid queries should not load session details");
      },
    }),
  );
  for (const field of ["harness", "misses", "sortBy", "sortDirection"]) {
    const response = await app.request(`/api/sessions?${field}=invalid`);
    strictEqual(response.status, 400);
    const body = await response.json();
    match(body.error, /^Invalid /);
  }
});
