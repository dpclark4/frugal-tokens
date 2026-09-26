import { strictEqual } from "node:assert/strict";
import { enrichSessionSummary } from "./sessionSummaryEnrichment.ts";
import type {
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";

function tokens(cacheWrite: number): TokenUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
    freshPrompt: cacheWrite,
    output: 10,
    reasoning: 0,
    processed: cacheWrite + 10,
  };
}

function call(id: string, startedAt: number, cacheWrite: number): ModelCall {
  return {
    id,
    callWithinTurn: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    startedAt,
    tokens: tokens(cacheWrite),
    activity: { hasText: true, hasReasoning: false, tools: [] },
  };
}

Deno.test("propagates the session's estimated cache-miss cost from analyzeSessionCache", () => {
  // Two same-model, same-provider calls a millisecond apart where the
  // second returns to zero cache read despite the first having written a
  // large reusable prefix: an unexpected full miss, priced against
  // claude-sonnet-4-5's real cache rates.
  const detail: SessionDetail = {
    id: "session-1",
    harness: "claude-code",
    title: "Cache miss cost",
    updatedAt: 2,
    providers: ["anthropic"],
    models: ["claude-sonnet-4-5"],
    userTurns: 2,
    modelCalls: 2,
    tokens: tokens(2000),
    turns: [
      { number: 1, startedAt: 1, calls: [call("call-1", 1, 1000)] },
      { number: 2, startedAt: 2, calls: [call("call-2", 2, 1000)] },
    ],
    subagents: [],
  };

  const enriched = enrichSessionSummary(detail);

  strictEqual((enriched.cacheMissCost ?? 0) > 0, true);
  strictEqual(enriched.inclusiveCacheMissCost, enriched.cacheMissCost);
  strictEqual(enriched.hasUnpricedCacheMissCost, false);
  strictEqual(enriched.inclusiveHasUnpricedCacheMissCost, false);
});
