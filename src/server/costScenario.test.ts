import { strictEqual } from "node:assert";
import type {
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { estimateSessionCostScenario } from "./costScenario.ts";

function tokens(uncachedInput: number): TokenUsage {
  return {
    uncachedInput,
    cacheRead: 0,
    freshPrompt: 0,
    output: 10,
    reasoning: 0,
    processed: uncachedInput + 10,
  };
}

function call(id: string, startedAt: number, uncachedInput: number): ModelCall {
  return {
    id,
    callWithinTurn: 1,
    provider: "openai",
    model: "gpt-5",
    startedAt,
    tokens: tokens(uncachedInput),
    activity: { hasText: true, hasReasoning: false, tools: [] },
  };
}

const session: SessionDetail = {
  id: "root",
  harness: "pi",
  title: "Cost scenario",
  updatedAt: 1,
  providers: ["openai"],
  models: ["gpt-5"],
  userTurns: 2,
  modelCalls: 2,
  tokens: tokens(0),
  turns: [
    { number: 1, startedAt: 0, calls: [call("one", 0, 1_000)] },
    {
      number: 2,
      startedAt: 10 * 60_000,
      calls: [call("two", 10 * 60_000, 1_100)],
    },
  ],
  subagents: [],
};

Deno.test("Anthropic cost scenarios simulate the selected cache duration", () => {
  const fiveMinutes = estimateSessionCostScenario(
    session,
    "claude-sonnet-4-5",
    "5m",
  );
  const oneHour = estimateSessionCostScenario(
    session,
    "claude-sonnet-4-5",
    "1h",
  );

  strictEqual(fiveMinutes.breakdown.cacheRead, 0);
  strictEqual(fiveMinutes.breakdown.cacheWrite, 2_100 * 3.75 / 1_000_000);
  strictEqual(oneHour.breakdown.cacheRead, 1_000 * 0.3 / 1_000_000);
  strictEqual(oneHour.breakdown.cacheWrite, 1_100 * 6 / 1_000_000);
  strictEqual(oneHour.breakdown.output, 20 * 15 / 1_000_000);
  strictEqual(oneHour.cost < fiveMinutes.cost, true);
});

Deno.test("an identical Anthropic 1-hour scenario preserves recorded billing", () => {
  const recordedTokens: TokenUsage = {
    uncachedInput: 2,
    cacheRead: 19_535,
    cacheWrite: 13_625,
    cacheWrite5m: 0,
    cacheWrite1h: 13_625,
    freshPrompt: 13_627,
    output: 296,
    reasoning: 0,
    processed: 33_458,
  };
  const recorded: SessionDetail = {
    ...session,
    providers: ["anthropic"],
    models: ["claude-fable-5"],
    modelCalls: 1,
    turns: [{
      number: 1,
      startedAt: 0,
      calls: [{
        ...call("fable", 0, 0),
        provider: "anthropic",
        model: "claude-fable-5",
        tokens: recordedTokens,
      }],
    }],
  };

  const estimate = estimateSessionCostScenario(
    recorded,
    "claude-fable-5",
    "1h",
  );

  strictEqual(estimate.breakdown.input, 2 * 10 / 1_000_000);
  strictEqual(estimate.breakdown.cacheRead, 19_535 * 1 / 1_000_000);
  strictEqual(estimate.breakdown.cacheWrite, 13_625 * 20 / 1_000_000);
  strictEqual(estimate.breakdown.output, 296 * 50 / 1_000_000);
  strictEqual(estimate.cost, 0.306855);
});

Deno.test("a matching TTL preserves provider cache reads after a long gap", () => {
  const first = {
    ...call("first", 0, 0),
    provider: "anthropic",
    model: "claude-opus-4-8",
    tokens: {
      ...tokens(0),
      uncachedInput: 5_769,
      cacheRead: 18_762,
      cacheWrite: 5_518,
      cacheWrite5m: 0,
      cacheWrite1h: 5_518,
    },
  };
  const afterExpiry = {
    ...call("after-expiry", 4 * 60 * 60_000, 0),
    provider: "anthropic",
    model: "claude-opus-4-8",
    tokens: {
      ...tokens(0),
      uncachedInput: 131,
      cacheRead: 18_762,
      cacheWrite: 55_651,
      cacheWrite5m: 0,
      cacheWrite1h: 55_651,
    },
  };
  const estimate = estimateSessionCostScenario(
    {
      ...session,
      providers: ["anthropic"],
      models: ["claude-opus-4-8"],
      modelCalls: 2,
      turns: [
        { number: 1, startedAt: 0, calls: [first] },
        { number: 2, startedAt: afterExpiry.startedAt, calls: [afterExpiry] },
      ],
    },
    "claude-opus-4-8",
    "1h",
  );

  strictEqual(estimate.breakdown.cacheRead, (18_762 * 2) * 0.5 / 1_000_000);
  strictEqual(
    estimate.breakdown.cacheWrite,
    (5_518 + 55_651) * 10 / 1_000_000,
  );
});

Deno.test("cost scenarios exclude delegated subagent calls", () => {
  const rootOnly = estimateSessionCostScenario(
    session,
    "claude-sonnet-4-5",
    "1h",
  );
  const withSubagent = estimateSessionCostScenario(
    {
      ...session,
      subagents: [{
        ...session,
        id: "child",
        title: "Haiku subagent",
        models: ["claude-haiku-4-5"],
        subagents: [],
      }],
    },
    "claude-sonnet-4-5",
    "1h",
  );

  strictEqual(withSubagent.cost, rootOnly.cost);
  strictEqual(withSubagent.breakdown.output, rootOnly.breakdown.output);
});
