import type {
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";

type RateCard = {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

const standard: Record<string, RateCard> = {
  "claude-fable-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  "claude-mythos-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  "claude-opus-4-8": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-1": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  "claude-opus-4": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  "claude-haiku-3-5": { input: 0.8, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, output: 4 },
  "grok-4-5": { input: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 6 },
  "grok-4.5": { input: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, output: 6 },
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, output: 30 },
  "gpt-5.5-pro": { input: 30, cacheRead: 0, output: 180 },
  "gpt-5.4": { input: 2.5, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheRead: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30, cacheRead: 0, output: 180 },
};

const longContext: Record<string, RateCard> = {
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
};

const LONG_CONTEXT_THRESHOLD = 272_000;

function normalizedModel(model: string) {
  return model.replace(/^.*?((?:claude|gpt|grok)-)/, "$1").replace(
    /-\d{8}.*$/,
    "",
  );
}

function rateCard(model: string, timestamp: number, inputTokens: number) {
  const normalized = normalizedModel(model);
  if (
    normalized.startsWith("gpt-5.") &&
    inputTokens >= LONG_CONTEXT_THRESHOLD
  ) return longContext[normalized];
  if (normalized === "claude-sonnet-5") {
    return timestamp < Date.parse("2026-09-01T00:00:00Z")
      ? { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 }
      : { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 };
  }
  return standard[normalized];
}

export function computeModelCallCost(
  tokens: TokenUsage,
  model: string,
  timestamp: number,
) {
  const categorizedTokens = tokens.uncachedInput + tokens.cacheRead +
    (tokens.cacheWrite ?? 0) + tokens.output + tokens.reasoning;
  if (tokens.processed > 0 && categorizedTokens === 0) return undefined;

  const inputSideTokens = contextSize(tokens);
  const rates = rateCard(model, timestamp, inputSideTokens);
  if (!rates) return undefined;

  let cacheWriteCost = 0;
  if (tokens.cacheWrite !== undefined) {
    if (tokens.cacheWrite5m !== undefined && tokens.cacheWrite1h !== undefined &&
      tokens.cacheWrite5m + tokens.cacheWrite1h === tokens.cacheWrite &&
      rates.cacheWrite5m !== undefined && rates.cacheWrite1h !== undefined) {
      cacheWriteCost = tokens.cacheWrite5m * rates.cacheWrite5m +
        tokens.cacheWrite1h * rates.cacheWrite1h;
    } else if (rates.cacheWrite !== undefined) {
      cacheWriteCost = tokens.cacheWrite * rates.cacheWrite;
    } else {
      return undefined;
    }
  }
  return (
    tokens.uncachedInput * rates.input +
    tokens.cacheRead * rates.cacheRead +
    cacheWriteCost +
    (tokens.output + tokens.reasoning) * rates.output
  ) / 1_000_000;
}

export function priceSessionDetail(session: SessionDetail): SessionDetail {
  const turns = session.turns.map((turn) => ({
    ...turn,
    calls: turn.calls.map((call) => ({
      ...call,
      computedCost: computeModelCallCost(
        call.tokens,
        call.model,
        call.startedAt,
      ),
    })),
  }));
  const costs = turns.flatMap((turn) => turn.calls.map((call) => call.computedCost));
  return {
    ...session,
    computedCost: costs.length > 0 && costs.every((cost) => cost !== undefined)
      ? costs.reduce((sum, cost) => sum + cost!, 0)
      : undefined,
    turns,
    subagents: session.subagents.map(priceSessionDetail),
  };
}
