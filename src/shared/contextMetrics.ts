import type { ModelCall, TokenUsage } from "./sessionSchemas.ts";

export function contextSize(
  tokens: Pick<TokenUsage, "uncachedInput" | "cacheRead" | "cacheWrite">,
) {
  return tokens.uncachedInput + tokens.cacheRead + (tokens.cacheWrite ?? 0);
}

export function contextRange<T extends Pick<ModelCall, "startedAt" | "tokens">>(
  calls: T[],
) {
  let first: T | undefined;
  let latest: T | undefined;
  let peak: T | undefined;
  for (const call of calls) {
    if (!first || call.startedAt < first.startedAt) first = call;
    if (!latest || call.startedAt >= latest.startedAt) latest = call;
    if (!peak || contextSize(call.tokens) > contextSize(peak.tokens)) peak = call;
  }
  return {
    first: first && { call: first, size: contextSize(first.tokens) },
    latest: latest && { call: latest, size: contextSize(latest.tokens) },
    peak: peak && { call: peak, size: contextSize(peak.tokens) },
  };
}
