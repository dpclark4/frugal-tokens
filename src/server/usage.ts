import type {
  SessionDetail,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";

export type UsageCall = {
  harness: SessionSummary["harness"];
  sourceSessionID: string;
  cacheChainID: string;
  sessionStartedAt: number;
  provider: string;
  model: string;
  startedAt: number;
  tokens: TokenUsage;
  reportedCost?: number;
  computedCost?: number;
};

export function usageCallsFromSession(
  session: SessionDetail,
  root = session,
): UsageCall[] {
  return [
    ...session.turns.flatMap((turn) =>
      turn.calls.map((call) => ({
        harness: session.harness,
        sourceSessionID: root.id,
        cacheChainID: session.id,
        sessionStartedAt: root.startedAt ?? root.updatedAt,
        provider: call.provider,
        model: call.model,
        startedAt: call.startedAt,
        tokens: call.tokens,
        reportedCost: call.reportedCost,
        computedCost: call.computedCost,
      }))
    ),
    ...session.subagents.flatMap((subagent) =>
      usageCallsFromSession(subagent, root)
    ),
  ];
}
