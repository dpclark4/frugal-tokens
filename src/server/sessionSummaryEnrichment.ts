import type {
  ContextEvent,
  ModelCall,
  SessionDetail,
  SessionSummary,
  TokenUsage,
  TurnInput,
} from "../shared/sessionSchemas.ts";
import { contextRange } from "../shared/contextMetrics.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import {
  analyzeSessionCache,
  sessionCacheIssues,
  summarizeSessionCache,
} from "./cacheAnalysis.ts";
import { priceSessionDetail } from "./pricing.ts";
import type {
  ConversationContextEventImport,
  LinearConversationImport,
} from "./conversationImportTypes.ts";

type Harness = SessionSummary["harness"];

function contextEvent(value: ConversationContextEventImport): ContextEvent {
  const { affectedCall: _affectedCall, compaction, ...event } = value;
  const hydrated: ContextEvent = { ...event };
  if (compaction !== undefined) {
    hydrated.compaction = {
      ...compaction,
      checkpointItems: compaction.checkpointItems.map((item, index) => ({
        ...item,
        ordinal: item.ordinal ?? index + 1,
      })),
    };
  }
  return hydrated;
}

/** Hydrates the API detail shape without re-reading a freshly written tree. */
export function sessionDetailFromConversationImports(
  values: LinearConversationImport[],
  rootExternalID: string,
  harness: Harness,
): SessionDetail {
  const byID = new Map(values.map((value) => [value.externalID, value]));
  const children = Map.groupBy(
    values.filter((value) => value.parentExternalID !== undefined),
    (value) => value.parentExternalID!,
  );
  const hydrate = (value: LinearConversationImport): SessionDetail => {
    const events = value.session.contextEvents ?? [];
    const attached = Map.groupBy(
      events.filter((event) => event.affectedCall !== undefined),
      (event) => `${event.affectedCall!.turn}:${event.affectedCall!.call}`,
    );
    const turns = value.session.turns.map((turn) => {
      const inputs = (turn.inputs ?? []).map<TurnInput>((input) => {
        const hydrated: TurnInput = { kind: input.kind };
        if (input.preview !== undefined) hydrated.preview = input.preview;
        if (input.originalLength !== undefined) {
          hydrated.originalLength = input.originalLength;
        }
        if (input.truncated !== undefined) hydrated.truncated = input.truncated;
        if (input.mimeType !== undefined) hydrated.mimeType = input.mimeType;
        return hydrated;
      });
      const calls = turn.calls.map<ModelCall>((call) => {
        const activity: ModelCall["activity"] = {
          hasText: call.activity.hasText,
          hasReasoning: call.activity.hasReasoning,
          tools: call.activity.tools.map((tool) => {
            const hydrated: ModelCall["activity"]["tools"][number] = {
              name: tool.name,
              status: tool.status,
            };
            if (tool.startedAt !== undefined) {
              hydrated.startedAt = tool.startedAt;
            }
            if (tool.completedAt !== undefined) {
              hydrated.completedAt = tool.completedAt;
            }
            if (tool.childExternalID !== undefined) {
              hydrated.childSessionID =
                byID.get(tool.childExternalID)?.publicID ??
                  tool.childExternalID;
            }
            if (tool.inputPreview !== undefined) {
              hydrated.inputPreview = tool.inputPreview;
            }
            if (tool.outputPreview !== undefined) {
              hydrated.outputPreview = tool.outputPreview;
            }
            return hydrated;
          }),
        };
        if (call.activity.finishReason !== undefined) {
          activity.finishReason = call.activity.finishReason;
        }
        if (call.activity.images !== undefined) {
          activity.images = call.activity.images;
        }
        const hydrated: ModelCall = {
          id: call.id,
          callWithinTurn: call.callWithinTurn,
          provider: call.provider,
          model: call.model,
          startedAt: call.startedAt,
          tokens: call.tokens,
          activity,
          contextEventsBefore: (attached.get(
            `${turn.number}:${call.callWithinTurn}`,
          ) ?? []).map(contextEvent),
        };
        const text = call.content?.find((content) => content.kind === "text");
        if (text?.preview !== undefined) hydrated.preview = text.preview;
        if (call.completedAt !== undefined) {
          hydrated.completedAt = call.completedAt;
        }
        if (call.reportedCost !== undefined) {
          hydrated.reportedCost = call.reportedCost;
        }
        if (call.reasoningSetting !== undefined) {
          hydrated.reasoningSetting = call.reasoningSetting;
        }
        return hydrated;
      });
      const hydrated: SessionDetail["turns"][number] = {
        number: turn.number,
        startedAt: turn.startedAt,
        inputs,
        calls,
      };
      if (turn.reasoningSetting !== undefined) {
        hydrated.reasoningSetting = turn.reasoningSetting;
      }
      return hydrated;
    });
    const hydrated: SessionDetail = {
      id: value.publicID ?? value.externalID,
      harness,
      title: value.session.title,
      updatedAt: value.session.updatedAt,
      providers: value.session.providers,
      models: value.session.models,
      userTurns: turns.length,
      modelCalls: turns.reduce((total, turn) => total + turn.calls.length, 0),
      tokens: value.session.tokens,
      turns,
      contextEvents: events.filter((event) => event.affectedCall === undefined)
        .map(contextEvent),
      subagents: (children.get(value.externalID) ?? []).map(hydrate),
    };
    if (value.artifactPath !== undefined) {
      hydrated.sourcePath = value.artifactPath;
    }
    if (value.workingDirectory !== undefined) {
      hydrated.workingDirectory = value.workingDirectory;
    }
    if (value.session.startedAt !== undefined) {
      hydrated.startedAt = value.session.startedAt;
    }
    if (value.session.endedAt !== undefined) {
      hydrated.endedAt = value.session.endedAt;
    }
    if (value.session.reportedCost !== undefined) {
      hydrated.reportedCost = value.session.reportedCost;
    }
    if (value.parentExternalID !== undefined) {
      hydrated.parentID = byID.get(value.parentExternalID)?.publicID ??
        value.parentExternalID;
    }
    if (value.session.agent !== undefined) {
      hydrated.agent = value.session.agent;
    }
    return hydrated;
  };
  const root = byID.get(rootExternalID);
  if (root === undefined) {
    throw new Error(`Unknown summary root: ${rootExternalID}`);
  }
  return hydrate(root);
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
    uncachedInput: values.reduce(
      (total, tokens) => total + tokens.uncachedInput,
      0,
    ),
    cacheRead: values.reduce((total, tokens) => total + tokens.cacheRead, 0),
    cacheWrite: sumOptional(values.map((tokens) => tokens.cacheWrite)),
    cacheWrite5m: sumOptional(values.map((tokens) => tokens.cacheWrite5m)),
    cacheWrite1h: sumOptional(values.map((tokens) => tokens.cacheWrite1h)),
    freshPrompt: values.reduce(
      (total, tokens) => total + tokens.freshPrompt,
      0,
    ),
    output: values.reduce((total, tokens) => total + tokens.output, 0),
    reasoning: values.reduce((total, tokens) => total + tokens.reasoning, 0),
    processed: values.reduce((total, tokens) => total + tokens.processed, 0),
  };
}

function sessionTree(session: SessionDetail): SessionDetail[] {
  return [
    session,
    ...session.subagents.flatMap(sessionTree),
  ];
}

function imageInputCount(session: Pick<SessionDetail, "turns">) {
  return session.turns.reduce(
    (total, turn) =>
      total + turn.calls.reduce(
        (callTotal, call) => callTotal + (call.activity.images ?? 0),
        0,
      ),
    0,
  );
}

function compactionCount(session: SessionDetail): number {
  return (session.contextEvents ?? []).filter((event) =>
    event.type === "compaction"
  ).length +
    session.turns.reduce(
      (total, turn) =>
        total + turn.calls.reduce(
          (callTotal, call) =>
            callTotal + (call.contextEventsBefore ?? []).filter((event) =>
              event.type === "compaction"
            ).length,
          0,
        ),
      0,
    ) + session.subagents.reduce(
      (total, subagent) => total + compactionCount(subagent),
      0,
    );
}

/** Produces the fully enriched list representation from one hydrated tree. */
export function enrichSessionSummary(detail: SessionDetail): SessionSummary {
  const priced = priceSessionDetail(detail);
  const analyzed = analyzeSessionCache(priced);
  const sessions = sessionTree(priced);
  const descendants = sessions.slice(1);
  const reportedCosts = sessions.map((item) => item.reportedCost);
  const computed = rollupCosts(sessions.map((item) => item.computedCost));
  const context = contextRange(
    priced.turns.flatMap((turn) =>
      turn.calls.map((call) => ({
        startedAt: call.startedAt,
        tokens: call.tokens,
        turn: turn.number,
        call: call.callWithinTurn,
      }))
    ),
  );
  return {
    ...detail,
    userTurns: priced.userTurns,
    modelCalls: priced.modelCalls,
    computedCost: priced.computedCost,
    cacheSummary: summarizeSessionCache(analyzed),
    cacheIssues: sessionCacheIssues(analyzed),
    compactionCount: compactionCount(analyzed),
    contextLatest: context.latest?.size,
    contextPeak: context.peak?.size,
    contextPeakTurn: context.peak?.call.turn,
    contextPeakCall: context.peak?.call.call,
    subagentCount: descendants.length,
    subagentModelCalls: descendants.reduce(
      (total, item) => total + item.modelCalls,
      0,
    ),
    inclusiveUserTurns: sessions.reduce(
      (total, item) => total + item.userTurns,
      0,
    ),
    inclusiveModelCalls: sessions.reduce(
      (total, item) => total + item.modelCalls,
      0,
    ),
    inclusiveReportedCost: reportedCosts.every((cost) => cost !== undefined)
      ? reportedCosts.reduce((total, cost) => total + cost!, 0)
      : undefined,
    inclusiveComputedCost: computed.cost,
    inclusiveImageInputs: sessions.reduce(
      (total, item) => total + imageInputCount(item),
      0,
    ),
    inclusiveTokens: sumTokens(sessions.map((item) => item.tokens)),
  };
}
