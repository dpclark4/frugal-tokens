import { deepStrictEqual, strictEqual } from "node:assert";
import { Hono } from "hono";
import { createResponseCache } from "./responseCache.ts";

Deno.test("caches GET responses by path and complete query string", async () => {
  const cache = createResponseCache();
  const app = new Hono();
  let calls = 0;

  app.use("/api/*", cache.middleware);
  app.get("/api/value", (context) => context.json({ calls: ++calls }));

  const first = await app.request("/api/value?range=30&harness=all");
  strictEqual(first.headers.get("x-cache"), "MISS");
  deepStrictEqual(await first.json(), { calls: 1 });

  const hit = await app.request("/api/value?range=30&harness=all");
  strictEqual(hit.headers.get("x-cache"), "HIT");
  deepStrictEqual(await hit.json(), { calls: 1 });

  const otherQuery = await app.request("/api/value?range=90&harness=all");
  strictEqual(otherQuery.headers.get("x-cache"), "MISS");
  deepStrictEqual(await otherQuery.json(), { calls: 2 });

  cache.clear();
  const afterClear = await app.request("/api/value?range=30&harness=all");
  strictEqual(afterClear.headers.get("x-cache"), "MISS");
  deepStrictEqual(await afterClear.json(), { calls: 3 });
});

Deno.test("does not cache a response that overlaps invalidation", async () => {
  const cache = createResponseCache();
  const app = new Hono();
  let calls = 0;
  let blockFirst = true;
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => markStarted = resolve);
  const blocked = new Promise<void>((resolve) => release = resolve);

  app.use("/api/*", cache.middleware);
  app.get("/api/value", async (context) => {
    const value = ++calls;
    if (blockFirst) {
      blockFirst = false;
      markStarted();
      await blocked;
    }
    return context.json({ calls: value });
  });

  const overlappingRequest = app.request("/api/value");
  await started;
  cache.clear();
  release();
  await overlappingRequest;

  const next = await app.request("/api/value");
  strictEqual(next.headers.get("x-cache"), "MISS");
  deepStrictEqual(await next.json(), { calls: 2 });

  const hit = await app.request("/api/value");
  strictEqual(hit.headers.get("x-cache"), "HIT");
  deepStrictEqual(await hit.json(), { calls: 2 });
});
