import { contextSize } from "../shared/contextMetrics.ts";
import type { TokenUsage } from "../shared/sessionSchemas.ts";
import { computeModelCallCost } from "./pricing.ts";
import type {
  ConversationCallImport,
  LinearConversationImport,
} from "./conversationImportTypes.ts";

export const SESSION_ROLLUP_VERSION = 2;

type CostBucket = {
  cost: number;
  hasPricedCost: boolean;
  hasUnpricedCost: boolean;
};

export type OverviewDayRollup = CostBucket & {
  date: string;
  turns: number;
  firstTurnAt: number;
  lastCallAt?: number;
  input: number;
  cacheRead: number;
  peakContext: number;
  models: Array<
    CostBucket & {
      model: string;
      input: number;
      cacheRead: number;
    }
  >;
};

export type SessionOverviewRollup = {
  days: OverviewDayRollup[];
  executionIntervals: Array<{ startedAt: number; executionEndAt: number }>;
};

export type SessionRollup = {
  version: number;
  firstActivityAt?: number;
  lastActivityAt?: number;
  computedCost?: number;
  thinkingLatest?: string;
  thinkingValues: string[];
  thinkingClassifiedCalls: number;
  contextLatest?: number;
  contextPeak?: number;
  contextPeakTurn?: number;
  contextPeakCall?: number;
  subagentCount: number;
  subagentUserTurns: number;
  subagentModelCalls: number;
  subagentImageInputs: number;
  subagentTokens: TokenUsage;
  subagentReportedCost?: number;
  subagentComputedCost?: number;
  overview: SessionOverviewRollup;
  rootExecutionIntervals: SessionOverviewRollup["executionIntervals"];
};

type MutableDay = Omit<OverviewDayRollup, "models"> & {
  models: Map<string, CostBucket & { input: number; cacheRead: number }>;
};

function dateKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function visibleCalls(session: LinearConversationImport["session"]) {
  return session.turns.flatMap((turn) =>
    turn.calls.filter((call) =>
      !call.id.startsWith("context-operation:") &&
      !call.id.startsWith("unmeasured:")
    ).map((call) => ({ turn, call }))
  );
}

function completeComputedCost(calls: ConversationCallImport[]) {
  if (calls.length === 0) return undefined;
  const costs = calls.map((call) =>
    computeModelCallCost(call.tokens, call.model, call.startedAt, call.provider)
  );
  return costs.some((cost) => cost === undefined)
    ? undefined
    : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
}

function completeSum(values: (number | undefined)[]) {
  if (values.length === 0 || values.some((value) => value === undefined)) {
    return undefined;
  }
  return values.reduce<number>(
    (total, value) => total + (value ?? 0),
    0,
  );
}

function sumOptional(values: (number | undefined)[]) {
  const present = values.filter((value): value is number =>
    value !== undefined
  );
  return present.length === 0
    ? undefined
    : present.reduce((total, value) => total + value, 0);
}

function sumTokens(values: TokenUsage[]): TokenUsage {
  return {
    uncachedInput: values.reduce((sum, value) => sum + value.uncachedInput, 0),
    cacheRead: values.reduce((sum, value) => sum + value.cacheRead, 0),
    cacheWrite: sumOptional(values.map((value) => value.cacheWrite)),
    cacheWrite5m: sumOptional(values.map((value) => value.cacheWrite5m)),
    cacheWrite1h: sumOptional(values.map((value) => value.cacheWrite1h)),
    freshPrompt: values.reduce((sum, value) => sum + value.freshPrompt, 0),
    output: values.reduce((sum, value) => sum + value.output, 0),
    reasoning: values.reduce((sum, value) => sum + value.reasoning, 0),
    processed: values.reduce((sum, value) => sum + value.processed, 0),
  };
}

function executionEnd(
  turn: LinearConversationImport["session"]["turns"][number],
) {
  let end = turn.startedAt;
  for (const call of turn.calls) {
    end = Math.max(end, call.completedAt ?? call.startedAt);
    for (const tool of call.activity.tools) {
      end = Math.max(
        end,
        tool.completedAt ?? tool.startedAt ?? call.completedAt ??
          call.startedAt,
      );
    }
  }
  return end;
}

/** Builds the disposable, query-oriented data stored beside a root session. */
export function buildSessionRollup(
  sessions: LinearConversationImport[],
): SessionRollup {
  if (sessions.length === 0) {
    throw new Error("Cannot roll up an empty session tree");
  }
  const roots = sessions.filter((session) =>
    session.parentExternalID === undefined
  );
  if (roots.length !== 1) {
    throw new Error("A session rollup requires exactly one root");
  }
  const root = roots[0];
  const descendants = sessions.filter((session) => session !== root);
  const rootCalls = visibleCalls(root.session).map(({ call }) => call);
  const descendantCalls = descendants.flatMap((session) =>
    visibleCalls(session.session).map(({ call }) => call)
  );

  const thinkingCalls = root.session.turns.flatMap((turn) =>
    turn.calls.filter((call) =>
      !call.id.startsWith("context-operation:") &&
      call.reasoningSetting !== undefined
    )
  ).toSorted((a, b) =>
    a.startedAt - b.startedAt || a.callWithinTurn - b.callWithinTurn
  );
  const thinkingValues: string[] = [];
  for (const call of thinkingCalls) {
    const value = call.reasoningSetting!.settingValue;
    if (!thinkingValues.includes(value)) thinkingValues.push(value);
  }

  const chronologicalRootCalls = root.session.turns.flatMap((turn) =>
    turn.calls.filter((call) => !call.id.startsWith("context-operation:"))
      .map((call) => ({ turn, call }))
  ).toSorted((a, b) =>
    a.call.startedAt - b.call.startedAt ||
    a.turn.number - b.turn.number ||
    a.call.callWithinTurn - b.call.callWithinTurn
  );
  const contextualRootCalls = chronologicalRootCalls.filter(({ call }) =>
    contextSize(call.tokens) > 0
  );
  const latestContext = contextualRootCalls.at(-1);
  const peakContext = contextualRootCalls.reduce<
    (typeof contextualRootCalls)[number] | undefined
  >(
    (peak, value) =>
      peak === undefined || contextSize(value.call.tokens) >
          contextSize(peak.call.tokens)
        ? value
        : peak,
    undefined,
  );

  const days = new Map<string, MutableDay>();
  const executionIntervals: SessionOverviewRollup["executionIntervals"] = [];
  const rootExecutionIntervals: SessionOverviewRollup["executionIntervals"] = [];
  let firstActivityAt: number | undefined;
  let lastActivityAt: number | undefined;
  for (const session of [root, ...descendants]) {
    for (const turn of session.session.turns) {
      const calls = turn.calls.filter((call) =>
        !call.id.startsWith("context-operation:") &&
        !call.id.startsWith("unmeasured:")
      );
      if (calls.length === 0) continue;
      const date = dateKey(turn.startedAt);
      const day: MutableDay = days.get(date) ?? {
        date,
        turns: 0,
        firstTurnAt: turn.startedAt,
        input: 0,
        cacheRead: 0,
        peakContext: 0,
        cost: 0,
        hasPricedCost: false,
        hasUnpricedCost: false,
        models: new Map(),
      };
      day.turns++;
      day.firstTurnAt = Math.min(day.firstTurnAt, turn.startedAt);
      const turnLastCall = Math.max(
        ...calls.map((call) => call.completedAt ?? call.startedAt),
      );
      day.lastCallAt = Math.max(day.lastCallAt ?? turnLastCall, turnLastCall);

      const turnExecutionEnd = executionEnd({ ...turn, calls });
      const interval = {
        startedAt: turn.startedAt,
        executionEndAt: turnExecutionEnd,
      };
      executionIntervals.push(interval);
      if (session === root) rootExecutionIntervals.push(interval);
      firstActivityAt = Math.min(
        firstActivityAt ?? turn.startedAt,
        turn.startedAt,
      );
      lastActivityAt = Math.max(
        lastActivityAt ?? turnExecutionEnd,
        turnExecutionEnd,
      );

      for (const call of calls) {
        const input = contextSize(call.tokens);
        const computed = computeModelCallCost(
          call.tokens,
          call.model,
          call.startedAt,
          call.provider,
        );
        const cost = computed ?? call.reportedCost;
        day.input += input;
        day.cacheRead += call.tokens.cacheRead;
        day.peakContext = Math.max(day.peakContext, input);
        if (cost === undefined) day.hasUnpricedCost = true;
        else {
          day.cost += cost;
          day.hasPricedCost = true;
        }

        const model = day.models.get(call.model) ?? {
          input: 0,
          cacheRead: 0,
          cost: 0,
          hasPricedCost: false,
          hasUnpricedCost: false,
        };
        model.input += input;
        model.cacheRead += call.tokens.cacheRead;
        if (cost === undefined) model.hasUnpricedCost = true;
        else {
          model.cost += cost;
          model.hasPricedCost = true;
        }
        day.models.set(call.model, model);
      }
      days.set(date, day);
    }
  }

  return {
    version: SESSION_ROLLUP_VERSION,
    firstActivityAt,
    lastActivityAt,
    computedCost: completeComputedCost(rootCalls),
    thinkingLatest: thinkingCalls.at(-1)?.reasoningSetting?.settingValue,
    thinkingValues,
    thinkingClassifiedCalls: thinkingCalls.length,
    contextLatest: latestContext && contextSize(latestContext.call.tokens),
    contextPeak: peakContext && contextSize(peakContext.call.tokens),
    contextPeakTurn: peakContext?.turn.number,
    contextPeakCall: peakContext?.call.callWithinTurn,
    subagentCount: descendants.length,
    subagentUserTurns: descendants.reduce(
      (sum, session) => sum + session.session.userTurns,
      0,
    ),
    subagentModelCalls: descendants.reduce(
      (sum, session) => sum + session.session.modelCalls,
      0,
    ),
    subagentImageInputs: descendantCalls.reduce(
      (sum, call) => sum + (call.activity.images ?? 0),
      0,
    ),
    subagentTokens: sumTokens(
      descendants.map((session) => session.session.tokens),
    ),
    subagentReportedCost: completeSum(
      descendants.map((session) => session.session.reportedCost),
    ),
    subagentComputedCost: completeComputedCost(descendantCalls),
    overview: {
      days: [...days.values()].toSorted((a, b) => a.firstTurnAt - b.firstTurnAt)
        .map((day) => ({
          ...day,
          models: [...day.models.entries()].map(([model, values]) => ({
            model,
            ...values,
          })),
        })),
      executionIntervals: executionIntervals.toSorted((a, b) =>
        a.startedAt - b.startedAt
      ),
    },
    rootExecutionIntervals: rootExecutionIntervals.toSorted((a, b) =>
      a.startedAt - b.startedAt
    ),
  };
}
