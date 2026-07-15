import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  analyzeSessionCache,
  assessCache,
  summarizeSessionCache,
  summarizeTurnCache,
} from "./cacheAnalysis.ts";
import type {
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";

function tokens(cacheRead: number, cacheWrite?: number): TokenUsage {
  return {
    uncachedInput: 100,
    cacheRead,
    cacheWrite,
    freshPrompt: 100 + (cacheWrite ?? 0),
    output: 10,
    reasoning: 0,
    processed: 110 + cacheRead + (cacheWrite ?? 0),
  };
}

function call(
  id: string,
  cacheRead: number,
  cacheWrite?: number,
  model = "claude-sonnet-4-5",
  provider = "anthropic",
): ModelCall {
  return {
    id,
    callWithinTurn: 1,
    provider,
    model,
    startedAt: 1,
    tokens: tokens(cacheRead, cacheWrite),
    activity: { hasText: true, hasReasoning: false, tools: [] },
  };
}

Deno.test("assesses cache retention from the preceding comparable call", () => {
  const baseline = call("baseline", 80_000, 20_000);

  deepStrictEqual(assessCache(undefined, baseline), {
    status: "baseline",
    reason: "no-predecessor",
  });
  strictEqual(assessCache(baseline, call("hit", 95_000)).status, "hit");
  strictEqual(
    assessCache(baseline, call("partial", 50_000)).status,
    "partial-hit",
  );
  deepStrictEqual(assessCache(baseline, call("miss", 5_000, 96_000)), {
    status: "full-miss",
    retainedRatio: 0.05,
    previousReusableTokens: 100_000,
  });
  deepStrictEqual(
    assessCache(baseline, call("changed", 0, 100_000, "claude-opus-4-7")),
    { status: "not-comparable", reason: "model-change" },
  );
  deepStrictEqual(assessCache(call("empty", 0), call("next", 0)), {
    status: "not-comparable",
    reason: "no-reusable-cache",
  });
});

Deno.test("tracks an OpenAI miss and implicit cache recovery across turns", () => {
  function openAICall(id: string, uncachedInput: number, cacheRead: number) {
    const value = call(id, cacheRead, undefined, "gpt-5.5", "openai");
    value.tokens = {
      ...value.tokens,
      uncachedInput,
      freshPrompt: uncachedInput,
      processed: uncachedInput + cacheRead + value.tokens.output,
    };
    return value;
  }

  const previousTurn = [openAICall("previous", 480, 52_736)];
  const missAndRecovery = [
    openAICall("miss", 53_573, 0),
    openAICall("recovery", 1_346, 53_248),
    openAICall("continued-hit", 987, 54_272),
  ];
  const base = session("openai", []);
  base.userTurns = 2;
  base.modelCalls = 4;
  base.turns = [
    { number: 1, startedAt: 1, calls: previousTurn },
    { number: 2, startedAt: 2, calls: missAndRecovery },
  ];

  const actual = analyzeSessionCache(base);
  deepStrictEqual(
    actual.turns.flatMap((turn) =>
      turn.calls.map((item) => item.cacheAssessment?.status)
    ),
    ["baseline", "full-miss", "hit", "hit"],
  );
  deepStrictEqual(actual.turns[1].cacheSummary, {
    baseline: 0,
    hits: 2,
    partialHits: 0,
    fullMisses: 1,
    notComparable: 0,
    unknown: 0,
    totalCacheRead: 107_520,
    peakCacheRead: 54_272,
    totalNewInput: 55_906,
    cachedInputShare: 107_520 / 163_426,
  });
  deepStrictEqual(
    summarizeTurnCache(actual.turns[1].calls),
    actual.turns[1].cacheSummary,
  );
});

function session(
  id: string,
  calls: ModelCall[],
  subagents: SessionDetail[] = [],
) {
  return {
    id,
    harness: "claude-code" as const,
    title: id,
    updatedAt: 1,
    providers: ["anthropic"],
    models: ["claude-sonnet-4-5"],
    userTurns: 1,
    modelCalls: calls.length,
    tokens: tokens(0),
    turns: [{ number: 1, startedAt: 1, calls }],
    subagents,
  };
}

Deno.test("summarizes turns and analyzes subagents independently", () => {
  const child = session("child", [
    call("child-first", 0, 10_000),
    call("child-second", 0, 10_100),
  ]);
  const actual = analyzeSessionCache(session("parent", [
    call("first", 80_000, 20_000),
    call("second", 50_000, 51_000),
    call("third", 5_000, 96_000),
  ], [child]));

  strictEqual(actual.turns[0].cacheAssessment?.status, "full-miss");
  deepStrictEqual(
    actual.turns[0].calls.map((item) => item.cacheAssessment?.status),
    ["baseline", "partial-hit", "full-miss"],
  );
  deepStrictEqual(
    actual.subagents[0].turns[0].calls.map((item) =>
      item.cacheAssessment?.status
    ),
    ["baseline", "full-miss"],
  );
  deepStrictEqual(summarizeSessionCache(actual), {
    baseline: 1,
    hits: 0,
    partialHits: 1,
    fullMisses: 1,
    notComparable: 0,
    unknown: 0,
  });
});
