import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  overviewResponseSchema,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { aggregateOverviewRollups } from "./overviewAnalytics.ts";
import type {
  ConversationCallImport,
  LinearConversationImport,
} from "./conversationImportTypes.ts";
import { buildSessionRollup } from "./sessionRollups.ts";

const baseTokens: TokenUsage = {
  uncachedInput: 100,
  cacheRead: 50,
  freshPrompt: 100,
  output: 20,
  reasoning: 10,
  processed: 180,
};

function call(
  id: string,
  model: string,
  startedAt: number,
  options: {
    thinking?: string;
    reportedCost?: number;
    images?: number;
    toolEnd?: number;
    tokens?: TokenUsage;
  } = {},
): ConversationCallImport {
  return {
    id,
    callWithinTurn: 1,
    provider: "test",
    model,
    startedAt,
    completedAt: startedAt + 100,
    reportedCost: options.reportedCost,
    tokens: options.tokens ?? baseTokens,
    reasoningSetting: options.thinking === undefined ? undefined : {
      settingName: "thinking",
      settingValue: options.thinking,
      provenance: "explicit",
    },
    activity: {
      images: options.images,
      hasText: true,
      hasReasoning: options.thinking !== undefined,
      tools: options.toolEnd === undefined ? [] : [{
        name: "bash",
        status: "completed",
        startedAt: startedAt + 20,
        completedAt: options.toolEnd,
      }],
    },
  };
}

function sourceSession(options: {
  sourceID: number;
  externalID: string;
  parentExternalID?: string;
  reportedCost?: number;
  turns: LinearConversationImport["session"]["turns"];
  tokens: TokenUsage;
}): LinearConversationImport {
  return {
    sourceID: options.sourceID,
    externalID: options.externalID,
    parentExternalID: options.parentExternalID,
    observedAt: 1,
    checkpoint: {},
    session: {
      title: options.externalID,
      updatedAt: options.turns.at(-1)?.startedAt ?? 0,
      providers: ["test"],
      models: ["gpt-5.6-luna", "unknown-model"],
      userTurns: options.turns.length,
      modelCalls: options.turns.reduce(
        (sum, turn) => sum + turn.calls.length,
        0,
      ),
      reportedCost: options.reportedCost,
      tokens: options.tokens,
      turns: options.turns,
    },
  };
}

Deno.test("builds root, subagent, thinking, context, and overview rollups", () => {
  const firstDay = new Date(2026, 6, 10, 9).getTime();
  const secondDay = new Date(2026, 6, 11, 10).getTime();
  const largerTokens: TokenUsage = {
    ...baseTokens,
    uncachedInput: 250,
    cacheRead: 50,
    freshPrompt: 250,
    processed: 330,
  };
  const root = sourceSession({
    sourceID: 1,
    externalID: "root",
    reportedCost: 0.5,
    tokens: {
      ...baseTokens,
      uncachedInput: 350,
      cacheRead: 100,
      freshPrompt: 350,
      output: 40,
      reasoning: 20,
      processed: 510,
    },
    turns: [{
      number: 1,
      startedAt: firstDay,
      calls: [call("root-1", "gpt-5.6-luna", firstDay + 10, {
        thinking: "medium",
        toolEnd: firstDay + 500,
      })],
    }, {
      number: 2,
      startedAt: secondDay,
      calls: [call("root-2", "unknown-model", secondDay + 10, {
        thinking: "high",
        reportedCost: 0.25,
        images: 2,
        tokens: largerTokens,
      })],
    }],
  });
  const child = sourceSession({
    sourceID: 1,
    externalID: "child",
    parentExternalID: "root",
    reportedCost: 0.1,
    tokens: baseTokens,
    turns: [{
      number: 1,
      startedAt: secondDay + 1_000,
      calls: [call("child-1", "gpt-5.6-luna", secondDay + 1_010)],
    }],
  });

  const rollup = buildSessionRollup([child, root]);

  strictEqual(rollup.computedCost, undefined);
  deepStrictEqual(
    {
      thinkingLatest: rollup.thinkingLatest,
      thinkingValues: rollup.thinkingValues,
      thinkingClassifiedCalls: rollup.thinkingClassifiedCalls,
      contextLatest: rollup.contextLatest,
      contextPeak: rollup.contextPeak,
      contextPeakTurn: rollup.contextPeakTurn,
      contextPeakCall: rollup.contextPeakCall,
      subagentCount: rollup.subagentCount,
      subagentUserTurns: rollup.subagentUserTurns,
      subagentModelCalls: rollup.subagentModelCalls,
      subagentImageInputs: rollup.subagentImageInputs,
      subagentTokens: rollup.subagentTokens,
      subagentReportedCost: rollup.subagentReportedCost,
      subagentComputedCost: rollup.subagentComputedCost,
    },
    {
      thinkingLatest: "high",
      thinkingValues: ["medium", "high"],
      thinkingClassifiedCalls: 2,
      contextLatest: 300,
      contextPeak: 300,
      contextPeakTurn: 2,
      contextPeakCall: 1,
      subagentCount: 1,
      subagentUserTurns: 1,
      subagentModelCalls: 1,
      subagentImageInputs: 0,
      subagentTokens: {
        ...baseTokens,
        cacheWrite: undefined,
        cacheWrite5m: undefined,
        cacheWrite1h: undefined,
      },
      subagentReportedCost: 0.1,
      subagentComputedCost: 0.000285,
    },
  );
  strictEqual(rollup.firstActivityAt, firstDay);
  strictEqual(rollup.lastActivityAt, secondDay + 1_110);
  deepStrictEqual(rollup.overview.executionIntervals, [{
    startedAt: firstDay,
    executionEndAt: firstDay + 500,
  }, {
    startedAt: secondDay,
    executionEndAt: secondDay + 110,
  }, {
    startedAt: secondDay + 1_000,
    executionEndAt: secondDay + 1_110,
  }]);
  deepStrictEqual(
    rollup.overview.days.map((day) => ({
      date: day.date,
      turns: day.turns,
      input: day.input,
      cacheRead: day.cacheRead,
      peakContext: day.peakContext,
      cost: day.cost,
      hasUnpricedCost: day.hasUnpricedCost,
      models: day.models.map((model) => model.model),
    })),
    [{
      date: "2026-07-10",
      turns: 1,
      input: 150,
      cacheRead: 50,
      peakContext: 150,
      cost: 0.000285,
      hasUnpricedCost: false,
      models: ["gpt-5.6-luna"],
    }, {
      date: "2026-07-11",
      turns: 2,
      input: 450,
      cacheRead: 100,
      peakContext: 300,
      cost: 0.250285,
      hasUnpricedCost: false,
      models: ["unknown-model", "gpt-5.6-luna"],
    }],
  );

  const overview = aggregateOverviewRollups(
    [{ rootSessionID: 1, overview: rollup.overview }],
    new Date(2026, 6, 10).getTime(),
    new Date(2026, 6, 11, 23, 59).getTime(),
    2,
  );
  overviewResponseSchema.parse(overview);
  strictEqual(overview.sessions, 1);
  strictEqual(overview.activeDays, 2);
  deepStrictEqual(overview.activity.turns, {
    average: 1.5,
    median: 1.5,
    p90: 1.9,
  });
  deepStrictEqual(overview.sessionProfile.input, {
    average: 600,
    median: 600,
    p90: 600,
  });
  strictEqual(overview.models.length, 2);
});
