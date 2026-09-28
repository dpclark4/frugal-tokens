import { strictEqual } from "node:assert/strict";
import { computeCacheWriteCost } from "./cacheWritePricing.ts";

Deno.test("cache writes use reconciled duration rates before generic rates", () => {
  strictEqual(
    computeCacheWriteCost(
      { cacheWrite: 100, cacheWrite5m: 25, cacheWrite1h: 75 },
      { cacheWrite: 4, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    ),
    (25 * 6.25 + 75 * 10) / 1_000_000,
  );
});

Deno.test("cache writes fall back to generic rates with or without durations", () => {
  for (const durations of [{}, { cacheWrite5m: 25, cacheWrite1h: 75 }]) {
    strictEqual(
      computeCacheWriteCost(
        { cacheWrite: 100, ...durations },
        { cacheWrite: 4, cacheWrite5m: 6.25 },
      ),
      100 * 4 / 1_000_000,
    );
  }
});

Deno.test("only absent duration data permits the five-minute estimate", () => {
  const rates = { cacheWrite5m: 6.25, cacheWrite1h: 10 };
  strictEqual(
    computeCacheWriteCost({ cacheWrite: 100 }, rates),
    100 * 6.25 / 1_000_000,
  );
  for (
    const durations of [
      { cacheWrite5m: 25 },
      { cacheWrite1h: 75 },
      { cacheWrite5m: 25, cacheWrite1h: 70 },
    ]
  ) {
    strictEqual(
      computeCacheWriteCost({ cacheWrite: 100, ...durations }, rates),
      undefined,
    );
  }
});

Deno.test("cache writes need a rate only for nonzero writes", () => {
  strictEqual(computeCacheWriteCost({}, {}), 0);
  strictEqual(computeCacheWriteCost({ cacheWrite: 0 }, {}), 0);
  strictEqual(computeCacheWriteCost({ cacheWrite: 100 }, {}), undefined);
});
