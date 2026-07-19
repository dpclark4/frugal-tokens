import type {
  SessionDetail,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";

export type UsageCall = {
  harness: SessionSummary["harness"];
  session: {
    id: string;
    rootID: string;
    parentID?: string;
  };
  cacheChainID: string;
  turnID: string;
  sessionStartedAt: number;
  provider: string;
  model: string;
  startedAt: number;
  tokens: TokenUsage;
  reportedCost?: number;
  computedCost?: number;
  followsCompaction?: boolean;
};

export function usageCallsFromSession(
  session: SessionDetail,
  root = session,
): UsageCall[] {
  return [
    ...session.turns.flatMap((turn) =>
      turn.calls.map((call) => ({
        harness: session.harness,
        session: {
          id: session.id,
          rootID: root.id,
          parentID: session.parentID,
        },
        cacheChainID: session.id,
        turnID: `${session.id}:${turn.number}`,
        sessionStartedAt: root.startedAt ?? root.updatedAt,
        provider: call.provider,
        model: call.model,
        startedAt: call.startedAt,
        tokens: call.tokens,
        reportedCost: call.reportedCost,
        computedCost: call.computedCost,
        followsCompaction: (call.contextEventsBefore ?? []).some((event) =>
          event.type === "compaction"
        ),
      }))
    ),
    ...session.subagents.flatMap((subagent) =>
      usageCallsFromSession(subagent, root)
    ),
  ];
}
