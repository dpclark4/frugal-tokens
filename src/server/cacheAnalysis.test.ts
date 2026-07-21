import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
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
  const resumed = call("resumed", 95_000);
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
        retainedRatio: 95_000 / 100_000,
        previousReusableTokens: 100_000,
      },
    ],
  );
  strictEqual(actual.turns[0].cacheSummary?.fullMisses, 0);
  strictEqual(actual.turns[0].cacheSummary?.notComparable, 1);
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
    compactionRelatedMisses: 0,
    ttlRelatedMisses: 0,
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
    unexpectedMisses: 3,
  });
  deepStrictEqual(sessionCacheIssues(actual), [
    { status: "full-miss", turn: 1, scope: undefined },
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
    previousReusableTokens: 80_100,
  });
  strictEqual(actual.turns[1].cacheSummary?.fullMisses, 1);
  strictEqual(actual.turns[1].cacheSummary?.unexpectedMisses, 0);
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
    previousReusableTokens: 80_100,
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
