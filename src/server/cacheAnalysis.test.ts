import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  analyzeCacheMisses,
  analyzeSessionCache,
  assessCache,
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  sessionCacheIssues,
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
  thinking?: string,
): ModelCall {
  return {
    id,
    callWithinTurn: 1,
    provider,
    model,
    startedAt: 1,
    ...(thinking === undefined ? {} : {
      reasoningSetting: {
        settingName: "thinkingLevel",
        settingValue: thinking,
        provenance: "inherited" as const,
      },
    }),
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
  strictEqual(assessCache(baseline, call("hit", 100_000)).status, "hit");
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
    {
      status: "full-miss",
      reason: "model-change",
      retainedRatio: 0,
      previousReusableTokens: 100_000,
    },
  );
  deepStrictEqual(assessCache(call("empty", 0), call("next", 0)), {
    status: "not-comparable",
    reason: "no-reusable-cache",
  });
});

Deno.test("detects exact linear cache losses without treating shrinkage as a miss", () => {
  const previous = call("previous", 90_000, undefined, "gpt-5.6", "openai");
  previous.tokens = {
    ...previous.tokens,
    uncachedInput: 0,
    freshPrompt: 0,
    processed: 90_010,
  };

  const smallLoss = call("small-loss", 85_000, undefined, "gpt-5.6", "openai");
  smallLoss.tokens = {
    ...smallLoss.tokens,
    uncachedInput: 15_000,
    freshPrompt: 15_000,
    processed: 100_010,
  };
  strictEqual(assessCache(previous, smallLoss).status, "partial-hit");
  const smallLossMisses = analyzeCacheMisses([
    { ...previous, id: "previous" },
    { ...smallLoss, id: "small-loss" },
  ]);
  strictEqual(smallLossMisses.length, 1);
  strictEqual(smallLossMisses[0].missedTokens, 5_000);

  const fullyCachedShrink = call(
    "fully-cached-shrink",
    80_000,
    undefined,
    "gpt-5.6",
    "openai",
  );
  fullyCachedShrink.tokens = {
    ...fullyCachedShrink.tokens,
    uncachedInput: 0,
    freshPrompt: 0,
    processed: 80_010,
  };
  strictEqual(assessCache(previous, fullyCachedShrink).status, "hit");
  strictEqual(
    analyzeCacheMisses([
      { ...previous, id: "previous" },
      { ...fullyCachedShrink, id: "fully-cached-shrink" },
    ]).length,
    0,
  );

  const writtenPrefix = call("written-prefix", 80_000, 20_000);
  const partialWriteLoss = call("partial-write-loss", 90_000);
  partialWriteLoss.tokens = {
    ...partialWriteLoss.tokens,
    uncachedInput: 10_000,
    freshPrompt: 10_000,
    processed: 100_010,
  };
  strictEqual(
    assessCache(writtenPrefix, partialWriteLoss).status,
    "partial-hit",
  );
});

Deno.test("uses observed cache state instead of assuming uncached input becomes reusable", () => {
  function openAICall(
    id: string,
    startedAt: number,
    cacheRead: number,
    uncachedInput: number,
  ) {
    const value = call(id, cacheRead, undefined, "gpt-5.6", "openai");
    value.startedAt = startedAt;
    value.tokens = {
      ...value.tokens,
      uncachedInput,
      freshPrompt: uncachedInput,
      processed: cacheRead + uncachedInput + value.tokens.output,
    };
    return value;
  }

  const baseline = openAICall("baseline", 1, 9_984, 5_535);
  const grown = openAICall("grown", 2, 15_104, 466);
  const stable = openAICall("stable", 3, 15_104, 496);
  strictEqual(assessCache(baseline, grown).status, "hit");
  strictEqual(assessCache(grown, stable).status, "hit");
  strictEqual(
    analyzeCacheMisses([baseline, grown, stable]).length,
    0,
  );

  const dropped = openAICall("dropped", 4, 9_984, 5_617);
  const misses = analyzeCacheMisses([baseline, grown, dropped]);
  strictEqual(misses.length, 1);
  strictEqual(misses[0].previousCallID, "grown");
  strictEqual(misses[0].status, "full-miss");
  strictEqual(misses[0].missedTokens, 5_120);
});

Deno.test("uses explicit branch predecessors instead of flattened order", () => {
  const root = call("root", 90_000, undefined, "gpt-5.6", "openai");
  root.startedAt = 1;
  const originalTail = call(
    "original-tail",
    20_000,
    undefined,
    "gpt-5.6",
    "openai",
  );
  originalTail.startedAt = 2;
  originalTail.previousCallID = "root";
  originalTail.predecessorResolved = true;
  const sibling = call("sibling", 80_000, undefined, "gpt-5.6", "openai");
  sibling.startedAt = 3;
  sibling.tokens = {
    ...sibling.tokens,
    uncachedInput: 10_000,
    freshPrompt: 10_000,
    processed: 90_010,
  };
  sibling.previousCallID = "root";
  sibling.predecessorResolved = true;

  const misses = analyzeCacheMisses([root, originalTail, sibling]);
  strictEqual(misses.length, 2);
  strictEqual(misses[1].callID, "sibling");
  strictEqual(misses[1].previousCallID, "root");
  strictEqual(misses[1].missedTokens, 10_000);
});

Deno.test("treats a return to the initial cache-read floor as a full miss", () => {
  const first = call("first", 10_000);
  const grown = call("grown", 15_000);
  const reset = call("reset", 10_000);
  first.startedAt = 1;
  grown.startedAt = 2;
  reset.startedAt = 3;

  const actual = analyzeSessionCache(session("baseline-reset", [
    first,
    grown,
    reset,
  ]));

  deepStrictEqual(
    actual.turns[0].calls.map((item) => item.cacheAssessment?.status),
    ["baseline", "hit", "full-miss"],
  );
  strictEqual(
    actual.turns[0].calls[2].cacheAssessment?.retainedRatio,
    10_000 / 15_000,
  );

  const misses = analyzeCacheMisses([
    { ...first, id: "first" },
    { ...grown, id: "grown" },
    { ...reset, id: "reset" },
  ]);
  strictEqual(misses.length, 1);
  strictEqual(misses[0].status, "full-miss");
  strictEqual(misses[0].previousCallID, "grown");

  const retained = call("retained", 11_000);
  retained.startedAt = 3;
  const control = analyzeSessionCache(session("above-baseline", [
    first,
    grown,
    retained,
  ]));
  strictEqual(
    control.turns[0].calls[2].cacheAssessment?.status,
    "partial-hit",
  );
});

Deno.test("classifies mid-turn and cross-turn thinking changes", () => {
  const first = call("first", 80_000, 20_000, undefined, undefined, "high");
  const midTurn = call(
    "mid-turn",
    50_000,
    undefined,
    undefined,
    undefined,
    "xhigh",
  );
  const secondMidTurn = call(
    "second-mid-turn",
    0,
    100_000,
    undefined,
    undefined,
    "max",
  );
  const crossTurn = call(
    "cross-turn",
    0,
    100_000,
    undefined,
    undefined,
    "off",
  );
  const base = session("thinking-change", []);
  base.userTurns = 2;
  base.modelCalls = 4;
  base.turns = [
    { number: 1, startedAt: 1, calls: [first, midTurn, secondMidTurn] },
    { number: 2, startedAt: 2, calls: [crossTurn] },
  ];

  const actual = analyzeSessionCache(base);

  deepStrictEqual(
    actual.turns.flatMap((turn) =>
      turn.calls.map((item) => item.cacheAssessment?.cause)
    ),
    [undefined, "thinking-change", "thinking-change", "thinking-change"],
  );
  strictEqual(actual.turns[1].cacheAssessment?.cause, "thinking-change");
  strictEqual(actual.turns[1].cacheSummary?.thinkingChangeRelatedMisses, 1);
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[1].cacheSummary?.unexpectedMisses, 0);
  deepStrictEqual(sessionCacheIssues(actual), [
    {
      status: "full-miss",
      cause: "thinking-change",
      turn: 1,
      scope: undefined,
    },
    {
      status: "partial-hit",
      cause: "thinking-change",
      turn: 1,
      scope: undefined,
    },
    {
      status: "full-miss",
      cause: "thinking-change",
      turn: 2,
      scope: undefined,
    },
  ]);
});

Deno.test("prioritizes TTL over a simultaneous thinking change", () => {
  const previous = call(
    "previous",
    80_000,
    20_000,
    undefined,
    undefined,
    "high",
  );
  previous.startedAt = 0;
  previous.tokens.cacheWrite5m = 20_000;
  const expired = call(
    "expired",
    50_000,
    undefined,
    undefined,
    undefined,
    "off",
  );
  expired.startedAt = CACHE_TTL_5M_MS;

  const actual = analyzeSessionCache(session("ttl-before-thinking", [
    previous,
    expired,
  ]));

  strictEqual(actual.turns[0].calls[1].cacheAssessment?.cause, "ttl");
  strictEqual(actual.turns[0].cacheSummary?.thinkingChangeRelatedMisses, 0);
  strictEqual(actual.turns[0].cacheSummary?.ttlRelatedMisses, 1);
});

Deno.test("produces a database-ready miss record as a pure calculation", () => {
  const previous = call(
    "previous",
    80_000,
    undefined,
    "gpt-5.6-luna",
    "openai",
    "high",
  );
  const current = call(
    "current",
    50_000,
    undefined,
    "gpt-5.6-luna",
    "openai",
    "off",
  );
  current.startedAt = 2;
  current.tokens = {
    ...current.tokens,
    uncachedInput: 30_000,
    freshPrompt: 30_000,
    processed: 80_010,
  };

  const misses = analyzeCacheMisses([
    { ...previous, id: "previous" },
    { ...current, id: "current" },
  ]);

  strictEqual(misses.length, 1);
  strictEqual(misses[0].callID, "current");
  strictEqual(misses[0].previousCallID, "previous");
  strictEqual(misses[0].status, "partial-hit");
  strictEqual(misses[0].cause, "thinking-change");
  strictEqual(misses[0].missedTokens, 30_000);
  strictEqual(misses[0].modelCallCost !== undefined, true);
  strictEqual(misses[0].actualMissedCost !== undefined, true);
});

Deno.test("does not count opaque zero-context usage as a cache miss", () => {
  const first = call("first", 80_000, 20_000);
  first.startedAt = 1;
  const opaque = call("opaque", 0);
  opaque.startedAt = 2;
  opaque.tokens = {
    uncachedInput: 0,
    cacheRead: 0,
    freshPrompt: 0,
    output: 0,
    reasoning: 0,
    processed: 4_291,
  };
  const resumed = call("resumed", 100_000);
  resumed.startedAt = 3;

  const actual = analyzeSessionCache(session("opaque", [
    first,
    opaque,
    resumed,
  ]));

  deepStrictEqual(
    actual.turns[0].calls.map((item) => item.cacheAssessment),
    [
      { status: "baseline", reason: "no-predecessor" },
      { status: "not-comparable", reason: "no-input-context" },
      {
        status: "hit",
        retainedRatio: 1,
        previousReusableTokens: 100_000,
      },
    ],
  );
  strictEqual(actual.turns[0].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[0].cacheSummary?.notComparable, 1);
});

Deno.test("tracks an OpenAI full miss and observed cache recovery", () => {
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
    ["baseline", "full-miss", "not-comparable", "hit"],
  );
  deepStrictEqual(actual.turns[1].cacheSummary, {
    baseline: 0,
    hits: 1,
    partialHits: 0,
    fullMisses: 1,
    notComparable: 1,
    unknown: 0,
    compactionRelatedMisses: 0,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 1,
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

Deno.test("summarizes turns and includes independently analyzed subagents", () => {
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
    baseline: 2,
    hits: 0,
    partialHits: 1,
    fullMisses: 2,
    notComparable: 0,
    unknown: 0,
    compactionRelatedMisses: 0,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 3,
  });
  deepStrictEqual(sessionCacheIssues(actual), [
    { status: "full-miss", turn: 1, scope: undefined },
    { status: "partial-hit", turn: 1, scope: undefined },
    { status: "full-miss", turn: 1, scope: "child" },
  ]);
});

Deno.test("tracks a partial miss after compaction without counting it as a miss", () => {
  const previous = call("previous", 80_000, 20_000);
  const compacted = call("compacted", 50_000);
  compacted.contextEventsBefore = [{
    type: "compaction",
    sourceOrder: 2,
    occurredAt: 2,
  }];
  const base = session("compaction", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: 1, calls: [previous] },
    { number: 2, startedAt: 2, calls: [compacted] },
  ];
  const actual = analyzeSessionCache(base);

  deepStrictEqual(actual.turns[1].calls[0].cacheAssessment, {
    status: "partial-hit",
    retainedRatio: 0.5,
    previousReusableTokens: 100_000,
    cause: "compaction",
  });
  deepStrictEqual(actual.turns[1].cacheSummary, {
    baseline: 0,
    hits: 0,
    partialHits: 0,
    fullMisses: 0,
    notComparable: 0,
    unknown: 0,
    compactionRelatedMisses: 1,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 0,
    totalCacheRead: 50_000,
    peakCacheRead: 50_000,
    totalNewInput: 100,
    cachedInputShare: 50_000 / 50_100,
  });
  strictEqual(actual.turns[1].cacheAssessment, undefined);
  deepStrictEqual(summarizeSessionCache(actual), {
    baseline: 1,
    hits: 0,
    partialHits: 0,
    fullMisses: 0,
    notComparable: 0,
    unknown: 0,
    compactionRelatedMisses: 1,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 0,
  });
  deepStrictEqual(sessionCacheIssues(actual), []);
});

Deno.test("attributes a Claude miss to an expired 5-minute write", () => {
  const previous = call("previous", 80_000, 20_000);
  previous.startedAt = 0;
  previous.tokens.cacheWrite5m = 20_000;
  previous.tokens.cacheWrite1h = 0;
  const expired = call("expired", 50_000);
  expired.startedAt = CACHE_TTL_5M_MS;
  expired.callWithinTurn = 2;

  const actual = analyzeSessionCache(session("ttl-5m", [previous, expired]));

  deepStrictEqual(actual.turns[0].calls[1].cacheAssessment, {
    status: "partial-hit",
    retainedRatio: 0.5,
    previousReusableTokens: 100_000,
    cause: "ttl",
  });
  strictEqual(actual.turns[0].cacheSummary?.partialHits, 0);
  strictEqual(actual.turns[0].cacheSummary?.ttlRelatedMisses, 1);
  strictEqual(actual.turns[0].cacheSummary?.unexpectedMisses, 0);
  deepStrictEqual(sessionCacheIssues(actual), [{
    status: "partial-hit",
    cause: "ttl",
    turn: 1,
    scope: undefined,
  }]);
});

Deno.test("keeps a Claude miss unexpected before its 5-minute TTL", () => {
  const previous = call("previous", 80_000, 20_000);
  previous.startedAt = 0;
  previous.tokens.cacheWrite5m = 20_000;
  const early = call("early", 50_000);
  early.startedAt = CACHE_TTL_5M_MS - 1;

  const actual = analyzeSessionCache(session("before-ttl", [previous, early]));

  strictEqual(actual.turns[0].calls[1].cacheAssessment?.cause, undefined);
  strictEqual(actual.turns[0].cacheSummary?.partialHits, 1);
  strictEqual(actual.turns[0].cacheSummary?.ttlRelatedMisses, 0);
  strictEqual(actual.turns[0].cacheSummary?.unexpectedMisses, 1);
});

Deno.test("attributes a cross-turn Claude miss to an expired 1-hour write", () => {
  const previous = call("previous", 80_000, 20_000);
  previous.startedAt = 0;
  previous.tokens.cacheWrite5m = 0;
  previous.tokens.cacheWrite1h = 20_000;
  const expired = call("expired", 5_000);
  expired.startedAt = CACHE_TTL_1H_MS;
  const base = session("ttl-1h", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: 0, calls: [previous] },
    { number: 2, startedAt: CACHE_TTL_1H_MS, calls: [expired] },
  ];

  const actual = analyzeSessionCache(base);

  strictEqual(actual.turns[1].calls[0].cacheAssessment?.cause, "ttl");
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[1].cacheSummary?.ttlRelatedMisses, 1);
  deepStrictEqual(sessionCacheIssues(actual), [{
    status: "full-miss",
    cause: "ttl",
    turn: 2,
    scope: undefined,
  }]);
});

Deno.test("uses a 1-hour TTL fallback for other providers", () => {
  const previous = call(
    "previous",
    80_000,
    undefined,
    "gpt-5.5",
    "openai",
  );
  previous.startedAt = 0;
  const expired = call("expired", 0, undefined, "gpt-5.5", "openai");
  expired.startedAt = CACHE_TTL_1H_MS;

  const actual = analyzeSessionCache(session("generic-ttl", [
    previous,
    expired,
  ]));

  strictEqual(actual.turns[0].calls[1].cacheAssessment?.cause, "ttl");
  strictEqual(actual.turns[0].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[0].cacheSummary?.ttlRelatedMisses, 1);
  strictEqual(actual.turns[0].cacheSummary?.unexpectedMisses, 0);
});

Deno.test("records a recent model switch as a non-unexpected full miss", () => {
  const previous = call("terra", 80_000, undefined, "gpt-5.6-terra", "openai");
  previous.startedAt = 0;
  const switched = call("luna", 0, undefined, "gpt-5.6-luna", "openai");
  switched.startedAt = 2 * 60 * 1_000;
  const base = session("recent-model-switch", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: previous.startedAt, calls: [previous] },
    { number: 2, startedAt: switched.startedAt, calls: [switched] },
  ];

  const actual = analyzeSessionCache(base);

  deepStrictEqual(actual.turns[1].calls[0].cacheAssessment, {
    status: "full-miss",
    reason: "model-change",
    retainedRatio: 0,
    previousReusableTokens: 80_000,
  });
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 1);
  strictEqual(actual.turns[1].cacheSummary?.unexpectedMisses, 0);
  deepStrictEqual(sessionCacheIssues(actual), [{
    status: "full-miss",
    reason: "model-change",
    turn: 2,
    scope: undefined,
  }]);
});

Deno.test("records a provider switch on the same model as a cache-chain change", () => {
  const previous = call(
    "anthropic",
    80_000,
    undefined,
    "claude-opus-4-5",
    "anthropic",
  );
  previous.startedAt = 0;
  const switched = call(
    "opencode",
    0,
    undefined,
    "claude-opus-4-5",
    "opencode",
  );
  switched.startedAt = 2 * 60 * 1_000;
  const base = session("provider-switch", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: previous.startedAt, calls: [previous] },
    { number: 2, startedAt: switched.startedAt, calls: [switched] },
  ];

  const actual = analyzeSessionCache(base);

  deepStrictEqual(actual.turns[1].calls[0].cacheAssessment, {
    status: "full-miss",
    reason: "model-change",
    retainedRatio: 0,
    previousReusableTokens: 80_000,
  });
  strictEqual(actual.turns[1].cacheSummary?.unexpectedMisses, 0);
  deepStrictEqual(sessionCacheIssues(actual), [{
    status: "full-miss",
    reason: "model-change",
    turn: 2,
    scope: undefined,
  }]);
});

Deno.test("attributes an expired model switch to TTL", () => {
  const previous = call("terra", 80_000, undefined, "gpt-5.6-terra", "openai");
  previous.startedAt = 0;
  const switched = call("luna", 0, undefined, "gpt-5.6-luna", "openai");
  switched.startedAt = 4 * CACHE_TTL_1H_MS;
  const base = session("expired-model-switch", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: previous.startedAt, calls: [previous] },
    { number: 2, startedAt: switched.startedAt, calls: [switched] },
  ];

  const actual = analyzeSessionCache(base);

  deepStrictEqual(actual.turns[1].calls[0].cacheAssessment, {
    status: "full-miss",
    reason: "model-change",
    retainedRatio: 0,
    previousReusableTokens: 80_000,
    cause: "ttl",
  });
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[1].cacheSummary?.ttlRelatedMisses, 1);
  strictEqual(actual.turns[1].cacheSummary?.unexpectedMisses, 0);
});

Deno.test("attributes an expired miss to compaction before TTL", () => {
  const previous = call("previous", 80_000, 20_000);
  previous.startedAt = 0;
  previous.tokens.cacheWrite5m = 20_000;
  const expired = call("expired", 50_000);
  expired.startedAt = CACHE_TTL_5M_MS;
  expired.contextEventsBefore = [{ type: "compaction", sourceOrder: 1 }];

  const actual = analyzeSessionCache(session("compaction-first", [
    previous,
    expired,
  ]));

  strictEqual(actual.turns[0].calls[1].cacheAssessment?.cause, "compaction");
  strictEqual(actual.turns[0].cacheSummary?.compactionRelatedMisses, 1);
  strictEqual(actual.turns[0].cacheSummary?.ttlRelatedMisses, 0);
});

Deno.test("tracks a full miss after compaction without counting it as a miss", () => {
  const previous = call("previous", 80_000, 20_000);
  const compacted = call("compacted", 5_000);
  compacted.contextEventsBefore = [{
    type: "compaction",
    sourceOrder: 2,
    occurredAt: 2,
  }];
  const base = session("compaction", []);
  base.userTurns = 2;
  base.modelCalls = 2;
  base.turns = [
    { number: 1, startedAt: 1, calls: [previous] },
    { number: 2, startedAt: 2, calls: [compacted] },
  ];
  const actual = analyzeSessionCache(base);

  deepStrictEqual(actual.turns[1].calls[0].cacheAssessment, {
    status: "full-miss",
    retainedRatio: 0.05,
    previousReusableTokens: 100_000,
    cause: "compaction",
  });
  strictEqual(actual.turns[1].cacheAssessment, undefined);
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[1].cacheSummary?.compactionRelatedMisses, 1);
  strictEqual(summarizeSessionCache(actual).fullMisses, 0);
  deepStrictEqual(sessionCacheIssues(actual), []);
});
