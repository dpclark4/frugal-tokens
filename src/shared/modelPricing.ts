import type { TokenUsage } from "./sessionSchemas.ts";
import { contextSize } from "./contextMetrics.ts";
import { canonicalModelId } from "./modelNames.ts";

export type ModelRateCard = {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

const standard: Record<string, ModelRateCard> = {
  "claude-fable-5": {
    input: 10,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
    output: 50,
  },
  "claude-mythos-5": {
    input: 10,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
    output: 50,
  },
  "claude-opus-5": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-8": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-7": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-6": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-5": {
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-4-1": {
    input: 15,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-opus-4": {
    input: 15,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-sonnet-5": {
    input: 2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.2,
    output: 10,
  },
  "claude-sonnet-4-6": {
    input: 3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
    output: 15,
  },
  "claude-sonnet-4-5": {
    input: 3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
    output: 15,
  },
  "claude-sonnet-4": {
    input: 3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
    output: 15,
  },
  "claude-haiku-4-5": {
    input: 1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
    output: 5,
  },
  "claude-haiku-3-5": {
    input: 0.8,
    cacheWrite5m: 1,
    cacheWrite1h: 1.6,
    cacheRead: 0.08,
    output: 4,
  },
  "grok-4-6": {
    input: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.5,
    output: 6,
  },
  "grok-4.6": {
    input: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.5,
    output: 6,
  },
  "grok-4-5": {
    input: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.3,
    output: 6,
  },
  "grok-4.5": {
    input: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.3,
    output: 6,
  },
  "kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 },
  "kimi-k2.7-code": {
    input: 0.95,
    cacheRead: 0.19,
    cacheWrite: 0.95,
    output: 4,
  },
  "kimi-k2.6": { input: 0.95, cacheRead: 0.16, cacheWrite: 0.95, output: 4 },
  "kimi-k2.5": { input: 0.6, cacheRead: 0.1, cacheWrite: 0.6, output: 3 },
  "glm-5.3": { input: 1.4, cacheRead: 0.26, output: 4.4 },
  "glm-5.2": { input: 1.4, cacheRead: 0.26, output: 4.4 },
  "glm-5.1": { input: 1.4, cacheRead: 0.26, output: 4.4 },
  "glm-5": { input: 1, cacheRead: 0.2, output: 3.2 },
  "minimax-m3": { input: 0.3, cacheRead: 0.06, cacheWrite: 0.3, output: 1.2 },
  "minimax-m2.7": {
    input: 0.3,
    cacheRead: 0.06,
    cacheWrite: 0.375,
    output: 1.2,
  },
  "minimax-m2.5": {
    input: 0.3,
    cacheRead: 0.03,
    cacheWrite: 0.375,
    output: 1.2,
  },
  "grok-build-0.1": {
    input: 1,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.2,
    output: 2,
  },
  "muse-spark-1.2": { input: 1.25, cacheRead: 0.15, output: 4.25 },
  "gpt-5.6-sol": {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    output: 30,
  },
  "gpt-5.6-terra": {
    input: 2.5,
    cacheRead: 0.25,
    cacheWrite: 3.125,
    output: 15,
  },
  "gpt-5.6-luna": {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 6,
  },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.1": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cacheRead: 0.13, output: 10 },
  "gpt-5.1-codex-mini": { input: 0.25, cacheRead: 0.025, output: 2 },
  "gpt-5": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cacheRead: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cacheRead: 0.005, output: 0.4 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, output: 30 },
  "gpt-5.5-pro": { input: 30, cacheRead: 0, output: 180 },
  "gpt-5.4": { input: 2.5, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheRead: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30, cacheRead: 0, output: 180 },
};

const longContext: Record<string, ModelRateCard> = {
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cacheRead: 0.175, output: 14 },
  "gpt-5.1-codex-max": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cacheRead: 0.13, output: 10 },
  "gpt-5.1-codex-mini": { input: 0.25, cacheRead: 0.025, output: 2 },
  "gpt-5-codex": { input: 1.25, cacheRead: 0.125, output: 10 },
  "gpt-5.6-sol": {
    input: 10,
    cacheRead: 1,
    cacheWrite: 12.5,
    output: 45,
  },
  "gpt-5.6-terra": {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    output: 22.5,
  },
  "gpt-5.6-luna": {
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 9,
  },
  "gpt-5.5": { input: 10, cacheRead: 1, output: 45 },
  "gpt-5.5-pro": { input: 60, cacheRead: 0, output: 270 },
  "gpt-5.4": { input: 5, cacheRead: 0.5, output: 22.5 },
  "gpt-5.4-pro": { input: 60, cacheRead: 0, output: 270 },
  "grok-4-6": {
    input: 4,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 1,
    output: 12,
  },
  "grok-4.6": {
    input: 4,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 1,
    output: 12,
  },
  "grok-4-5": {
    input: 4,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.6,
    output: 12,
  },
  "grok-4.5": {
    input: 4,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.6,
    output: 12,
  },
  "grok-build-0.1": {
    input: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0.4,
    output: 4,
  },
  "minimax-m3": { input: 0.6, cacheRead: 0.12, cacheWrite: 0.6, output: 2.4 },
};

const reducedLunaTerraRates: Record<string, ModelRateCard> = {
  "gpt-5.6-terra": {
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    output: 12,
  },
  "gpt-5.6-luna": {
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
  },
};

const reducedLunaTerraLongContextRates: Record<string, ModelRateCard> = {
  "gpt-5.6-terra": {
    input: 4,
    cacheRead: 0.4,
    cacheWrite: 5,
    output: 18,
  },
  "gpt-5.6-luna": {
    input: 0.4,
    cacheRead: 0.04,
    cacheWrite: 0.5,
    output: 1.8,
  },
};

const LONG_CONTEXT_THRESHOLD = 272_000;
const GROK_LONG_CONTEXT_THRESHOLD = 200_000;
const MINIMAX_M3_LONG_CONTEXT_THRESHOLD = 512_000;
const OPENAI_LUNA_TERRA_PRICE_CUT = Date.parse("2026-07-30T20:00:00Z");

export const counterfactualModelIDs = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-3-5",
  "grok-4-6",
  "grok-4-5",
  "grok-build-0.1",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "muse-spark-1.2",
] as const;

function usesLongContextRates(model: string, inputTokens: number) {
  if (
    (model.startsWith("gpt-5.") || model === "gpt-5" ||
      model.startsWith("gpt-5-")) &&
    inputTokens >= LONG_CONTEXT_THRESHOLD
  ) return true;
  if (model.startsWith("grok-") && inputTokens >= GROK_LONG_CONTEXT_THRESHOLD) {
    return true;
  }
  return model === "minimax-m3" &&
    inputTokens >= MINIMAX_M3_LONG_CONTEXT_THRESHOLD;
}

function cursorPricingModel(model: string) {
  // Cursor sometimes decorates the underlying model with a routing/quality
  // suffix. Keep the estimate tied to the underlying public model card.
  return canonicalModelId(model).replace(
    /-(?:high|medium|low|max|fast|slow)$/,
    "",
  );
}

export function modelRateCard(
  model: string,
  timestamp: number,
  inputTokens: number,
  provider?: string,
) {
  const normalized = canonicalModelId(
    provider?.toLowerCase() === "cursor" ? cursorPricingModel(model) : model,
  );
  const long = usesLongContextRates(normalized, inputTokens);
  if (timestamp >= OPENAI_LUNA_TERRA_PRICE_CUT) {
    const reducedRates = long
      ? reducedLunaTerraLongContextRates[normalized]
      : reducedLunaTerraRates[normalized];
    if (reducedRates) return reducedRates;
  }
  if (long) return longContext[normalized];
  return standard[normalized];
}

export type ModelCallCostBreakdown = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export function computeModelCallCostBreakdown(
  tokens: TokenUsage,
  model: string,
  timestamp: number,
  provider?: string,
): ModelCallCostBreakdown | undefined {
  const categorizedTokens = tokens.uncachedInput + tokens.cacheRead +
    (tokens.cacheWrite ?? 0) + tokens.output + tokens.reasoning;
  if (tokens.processed > 0 && categorizedTokens === 0) return undefined;

  const rates = modelRateCard(
    model,
    timestamp,
    contextSize(tokens),
    provider,
  );
  if (!rates) return undefined;

  let cacheWrite = 0;
  if (tokens.cacheWrite !== undefined) {
    if (
      tokens.cacheWrite5m !== undefined && tokens.cacheWrite1h !== undefined &&
      tokens.cacheWrite5m + tokens.cacheWrite1h === tokens.cacheWrite &&
      rates.cacheWrite5m !== undefined && rates.cacheWrite1h !== undefined
    ) {
      cacheWrite = tokens.cacheWrite5m * rates.cacheWrite5m +
        tokens.cacheWrite1h * rates.cacheWrite1h;
    } else if (rates.cacheWrite !== undefined) {
      cacheWrite = tokens.cacheWrite * rates.cacheWrite;
    } else if (
      tokens.cacheWrite5m === undefined && tokens.cacheWrite1h === undefined &&
      rates.cacheWrite5m !== undefined
    ) {
      // Sources with only a total cache-write count use the default 5-minute TTL.
      cacheWrite = tokens.cacheWrite * rates.cacheWrite5m;
    } else {
      return undefined;
    }
  }
  return {
    input: tokens.uncachedInput * rates.input / 1_000_000,
    cacheRead: tokens.cacheRead * rates.cacheRead / 1_000_000,
    cacheWrite: cacheWrite / 1_000_000,
    output: (tokens.output + tokens.reasoning) * rates.output / 1_000_000,
  };
}

export function computeModelCallCost(
  tokens: TokenUsage,
  model: string,
  timestamp: number,
  provider?: string,
) {
  const breakdown = computeModelCallCostBreakdown(
    tokens,
    model,
    timestamp,
    provider,
  );
  return breakdown === undefined
    ? undefined
    : breakdown.input + breakdown.cacheRead + breakdown.cacheWrite +
      breakdown.output;
}
