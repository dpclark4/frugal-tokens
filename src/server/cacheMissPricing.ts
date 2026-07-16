import type { TokenUsage } from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";

type CacheMissTokens = Pick<
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
    cacheWrite5m: number;
    cacheWrite1h: number;
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
): CacheMissTokenEstimate {
  const previousContext = contextSize(before);
  const currentContext = contextSize(after);
  const expectedReusable = Math.min(previousContext, currentContext);
  const actualCacheRead = Math.min(after.cacheRead, expectedReusable);
  const missedTokens = Math.max(expectedReusable - actualCacheRead, 0);
  const hasDetailedWrites = after.cacheWrite !== undefined &&
    after.cacheWrite5m !== undefined && after.cacheWrite1h !== undefined &&
    after.cacheWrite5m + after.cacheWrite1h === after.cacheWrite;

  return {
    previousContext,
    currentContext,
    expectedReusable,
    actualCacheRead,
    missedTokens,
    actualBilling: {
      uncachedInput: after.uncachedInput,
      cacheWrite: hasDetailedWrites ? 0 : after.cacheWrite ?? 0,
      cacheWrite5m: hasDetailedWrites ? after.cacheWrite5m! : 0,
      cacheWrite1h: hasDetailedWrites ? after.cacheWrite1h! : 0,
    },
  };
}

export function computeCacheMissCost(
  billing: InputBillingRates,
  estimate: CacheMissTokenEstimate,
): CacheMissCostEstimate | undefined {
  const { actualBilling, missedTokens } = estimate;
  if (actualBilling.cacheWrite > 0 && billing.cacheWrite === undefined) {
    return undefined;
  }
  if (actualBilling.cacheWrite5m > 0 && billing.cacheWrite5m === undefined) {
    return undefined;
  }
  if (actualBilling.cacheWrite1h > 0 && billing.cacheWrite1h === undefined) {
    return undefined;
  }

  const nonReadTokens = actualBilling.uncachedInput +
    actualBilling.cacheWrite + actualBilling.cacheWrite5m +
    actualBilling.cacheWrite1h;
  const nonReadCost = (
    actualBilling.uncachedInput * billing.input +
    actualBilling.cacheWrite * (billing.cacheWrite ?? 0) +
    actualBilling.cacheWrite5m * (billing.cacheWrite5m ?? 0) +
    actualBilling.cacheWrite1h * (billing.cacheWrite1h ?? 0)
  ) / 1_000_000;
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
) {
  return computeCacheMissCost(billing, estimateCacheMissTokens(before, after));
}
