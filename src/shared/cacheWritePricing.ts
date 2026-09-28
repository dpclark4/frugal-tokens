import type { TokenUsage } from "./sessionSchemas.ts";

export type CacheWriteUsage = Pick<
  TokenUsage,
  "cacheWrite" | "cacheWrite5m" | "cacheWrite1h"
>;

export type CacheWriteRates = {
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

/** Cost in USD. Missing duration data uses the 5-minute rate as an estimate. */
export function computeCacheWriteCost(
  tokens: CacheWriteUsage,
  rates: CacheWriteRates,
): number | undefined {
  if (tokens.cacheWrite === undefined || tokens.cacheWrite === 0) return 0;
  if (
    tokens.cacheWrite5m !== undefined && tokens.cacheWrite1h !== undefined &&
    tokens.cacheWrite5m + tokens.cacheWrite1h === tokens.cacheWrite &&
    rates.cacheWrite5m !== undefined && rates.cacheWrite1h !== undefined
  ) {
    return (tokens.cacheWrite5m * rates.cacheWrite5m +
      tokens.cacheWrite1h * rates.cacheWrite1h) / 1_000_000;
  }
  if (rates.cacheWrite !== undefined) {
    return tokens.cacheWrite * rates.cacheWrite / 1_000_000;
  }
  if (
    tokens.cacheWrite5m === undefined && tokens.cacheWrite1h === undefined &&
    rates.cacheWrite5m !== undefined
  ) {
    return tokens.cacheWrite * rates.cacheWrite5m / 1_000_000;
  }
  return undefined;
}
