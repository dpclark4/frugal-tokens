import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { TokenUsage } from "../shared/sessionSchemas.ts";
import {
  computeCacheMissCost,
  estimateCacheMissCost,
  estimateCacheMissTokens,
  type InputBillingRates,
} from "./cacheMissPricing.ts";
import { estimateModelCacheMissCost } from "./pricing.ts";

function tokens(values: Partial<TokenUsage>): TokenUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    freshPrompt: 0,
    output: 0,
    reasoning: 0,
    processed: 0,
    ...values,
  };
}

const billing: InputBillingRates = {
  input: 3,
  cacheRead: 0.3,
  cacheWrite: 4,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6,
};

function closeTo(actual: number, expected: number) {
  strictEqual(Math.abs(actual - expected) < 1e-12, true);
}

Deno.test("estimates missed reusable tokens for a partial cache miss", () => {
  const estimate = estimateCacheMissTokens(
    tokens({ uncachedInput: 2, cacheRead: 47_000, cacheWrite: 98 }),
    tokens({
      uncachedInput: 2,
      cacheRead: 28_800,
      cacheWrite: 19_098,
      cacheWrite5m: 0,
      cacheWrite1h: 19_098,
    }),
  );

  deepStrictEqual(estimate, {
    previousContext: 47_100,
    currentContext: 47_900,
    expectedReusable: 47_100,
    actualCacheRead: 28_800,
    missedTokens: 18_300,
    actualBilling: {
      uncachedInput: 2,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 19_098,
    },
  });
});

Deno.test("estimates a full uncached miss while excluding net-new context", () => {
  const estimate = estimateCacheMissTokens(
    tokens({ uncachedInput: 1_000, cacheRead: 99_800, cacheWrite: 100 }),
    tokens({ uncachedInput: 101_800, cacheRead: 0 }),
  );

  strictEqual(estimate.missedTokens, 100_900);
  strictEqual(estimate.currentContext - estimate.previousContext, 900);
  deepStrictEqual(estimate.actualBilling, {
    uncachedInput: 101_800,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });
});

Deno.test("caps expected reuse when the current context shrinks", () => {
  const estimate = estimateCacheMissTokens(
    tokens({ cacheRead: 100 }),
    tokens({ uncachedInput: 30, cacheRead: 50 }),
  );

  strictEqual(estimate.expectedReusable, 80);
  strictEqual(estimate.missedTokens, 30);
});

Deno.test("returns zero cost when there is no estimated miss", () => {
  const result = estimateCacheMissCost(
    billing,
    tokens({ cacheRead: 100 }),
    tokens({ uncachedInput: 2, cacheRead: 100 }),
  );

  strictEqual(result?.missedTokens, 0);
  strictEqual(result?.actualMissedCost, 0);
  strictEqual(result?.expectedReadCost, 0);
  strictEqual(result?.estimatedExtraCost, 0);
});

Deno.test("prices missed tokens at the observed weighted non-read rate", () => {
  const result = estimateCacheMissCost(
    billing,
    tokens({ cacheRead: 100 }),
    tokens({ uncachedInput: 2, cacheRead: 80, cacheWrite: 20 }),
  );
  if (!result) throw new Error("Expected a priced estimate");

  const actualNonReadCost = (2 * billing.input + 20 * billing.cacheWrite!) /
    1_000_000;
  closeTo(result.actualMissedCost, actualNonReadCost * 20 / 22);
  closeTo(result.expectedReadCost, 20 * billing.cacheRead / 1_000_000);
  closeTo(
    result.estimatedExtraCost,
    result.actualMissedCost - result.expectedReadCost,
  );
});

Deno.test("uses detailed write rates only when they reconcile to total writes", () => {
  const detailed = estimateCacheMissTokens(
    tokens({ cacheRead: 100 }),
    tokens({ cacheWrite: 100, cacheWrite5m: 25, cacheWrite1h: 75 }),
  );
  deepStrictEqual(detailed.actualBilling, {
    uncachedInput: 0,
    cacheWrite: 0,
    cacheWrite5m: 25,
    cacheWrite1h: 75,
  });

  const generic = estimateCacheMissTokens(
    tokens({ cacheRead: 100 }),
    tokens({ cacheWrite: 100, cacheWrite5m: 25, cacheWrite1h: 70 }),
  );
  deepStrictEqual(generic.actualBilling, {
    uncachedInput: 0,
    cacheWrite: 100,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });
});

Deno.test("does not price observed categories with missing rates", () => {
  const estimate = estimateCacheMissTokens(
    tokens({ cacheRead: 100 }),
    tokens({ cacheWrite: 100 }),
  );

  strictEqual(
    computeCacheMissCost({ input: 3, cacheRead: 0.3 }, estimate),
    undefined,
  );
});

Deno.test("uses short-context GPT rates below 272k", () => {
  const result = estimateModelCacheMissCost(
    tokens({ cacheRead: 229_000 }),
    tokens({ uncachedInput: 230_000 }),
    "gpt-5.6-sol",
    Date.parse("2026-07-15T00:00:00Z"),
  );
  if (!result) throw new Error("Expected a priced estimate");

  closeTo(result.actualMissedCost, 229_000 * 5 / 1_000_000);
  closeTo(result.expectedReadCost, 229_000 * 0.5 / 1_000_000);
  closeTo(result.estimatedExtraCost, 229_000 * 4.5 / 1_000_000);
});

Deno.test("uses long-context GPT rates above 272k", () => {
  const result = estimateModelCacheMissCost(
    tokens({ cacheRead: 289_000 }),
    tokens({ uncachedInput: 290_000 }),
    "gpt-5.6-sol",
    Date.parse("2026-07-15T00:00:00Z"),
  );
  if (!result) throw new Error("Expected a priced estimate");

  closeTo(result.actualMissedCost, 289_000 * 10 / 1_000_000);
  closeTo(result.expectedReadCost, 289_000 * 1 / 1_000_000);
  closeTo(result.estimatedExtraCost, 289_000 * 9 / 1_000_000);
});

Deno.test("switches cache-miss pricing at exactly 272k current context", () => {
  const timestamp = Date.parse("2026-07-15T00:00:00Z");
  const before = tokens({ cacheRead: 271_000 });
  const below = estimateModelCacheMissCost(
    before,
    tokens({ uncachedInput: 271_999 }),
    "gpt-5.6-sol",
    timestamp,
  );
  const atBoundary = estimateModelCacheMissCost(
    before,
    tokens({ uncachedInput: 272_000 }),
    "gpt-5.6-sol",
    timestamp,
  );
  if (!below || !atBoundary) throw new Error("Expected priced estimates");

  closeTo(below.estimatedExtraCost, 271_000 * 4.5 / 1_000_000);
  closeTo(atBoundary.estimatedExtraCost, 271_000 * 9 / 1_000_000);
});
