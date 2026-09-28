import type { TokenUsage } from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";
import { computeCacheWriteCost } from "../shared/cacheWritePricing.ts";

export type CacheMissTokens = Pick<
  TokenUsage,
  | "uncachedInput"
  | "cacheRead"
  | "cacheWrite"
  | "cacheWrite5m"
  | "cacheWrite1h"
>;

export type InputBillingRates = {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

export type CacheMissTokenEstimate = {
  previousContext: number;
  currentContext: number;
  expectedReusable: number;
  actualCacheRead: number;
  missedTokens: number;
  actualBilling: {
    uncachedInput: number;
    cacheWrite: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
  };
};

export type CacheMissCostEstimate = CacheMissTokenEstimate & {
  actualMissedCost: number;
  expectedReadCost: number;
  estimatedExtraCost: number;
};

export function estimateCacheMissTokens(
  before: CacheMissTokens,
  after: CacheMissTokens,
  previousReusableTokens = contextSize(before),
): CacheMissTokenEstimate {
  const previousContext = contextSize(before);
  const currentContext = contextSize(after);
  const expectedReusable = Math.min(
    previousReusableTokens,
    previousContext,
    currentContext,
  );
  const actualCacheRead = Math.min(after.cacheRead, expectedReusable);
  const missedTokens = Math.max(expectedReusable - actualCacheRead, 0);

  return {
    previousContext,
    currentContext,
    expectedReusable,
    actualCacheRead,
    missedTokens,
    actualBilling: {
      uncachedInput: after.uncachedInput,
      cacheWrite: after.cacheWrite ?? 0,
      cacheWrite5m: after.cacheWrite5m,
      cacheWrite1h: after.cacheWrite1h,
    },
  };
}

export function computeCacheMissCost(
  billing: InputBillingRates,
  estimate: CacheMissTokenEstimate,
): CacheMissCostEstimate | undefined {
  const { actualBilling, missedTokens } = estimate;
  const cacheWriteCost = computeCacheWriteCost(actualBilling, billing);
  if (cacheWriteCost === undefined) return undefined;

  const nonReadTokens = actualBilling.uncachedInput + actualBilling.cacheWrite;
  const nonReadCost = actualBilling.uncachedInput * billing.input / 1_000_000 +
    cacheWriteCost;
  const actualMissedCost = nonReadTokens === 0
    ? 0
    : nonReadCost * missedTokens / nonReadTokens;
  const expectedReadCost = missedTokens * billing.cacheRead / 1_000_000;

  return {
    ...estimate,
    actualMissedCost,
    expectedReadCost,
    estimatedExtraCost: actualMissedCost - expectedReadCost,
  };
}

export function estimateCacheMissCost(
  billing: InputBillingRates,
  before: CacheMissTokens,
  after: CacheMissTokens,
  previousReusableTokens?: number,
) {
  return computeCacheMissCost(
    billing,
    estimateCacheMissTokens(before, after, previousReusableTokens),
  );
}
