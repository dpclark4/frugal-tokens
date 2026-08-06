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
  SessionContextEventImport,
  SourceSessionImport,
} from "./sessionRepository.ts";

type Harness = SessionSummary["harness"];

function contextEvent(value: SessionContextEventImport): ContextEvent {
  const { affectedCall: _affectedCall, compaction, ...event } = value;
  return {
    ...event,
    ...(compaction === undefined ? {} : {
      compaction: {
        ...compaction,
        checkpointItems: compaction.checkpointItems.map((item, index) => ({
          ...item,
          ordinal: item.ordinal ?? index + 1,
        })),
      },
    }),
  };
}

/** Hydrates the API detail shape without re-reading a freshly written tree. */
export function sessionDetailFromSourceImports(
  values: SourceSessionImport[],
  rootExternalID: string,
  harness: Harness,
): SessionDetail {
  const byID = new Map(values.map((value) => [value.externalID, value]));
  const children = Map.groupBy(
    values.filter((value) => value.parentExternalID !== undefined),
    (value) => value.parentExternalID!,
  );
  const hydrate = (value: SourceSessionImport): SessionDetail => {
    const events = value.session.contextEvents ?? [];
    const attached = Map.groupBy(
      events.filter((event) => event.affectedCall !== undefined),
      (event) => `${event.affectedCall!.turn}:${event.affectedCall!.call}`,
    );
    const turns = value.session.turns.map((turn) => ({
      number: turn.number,
      startedAt: turn.startedAt,
      inputs: (turn.inputs ?? []).map<TurnInput>((input) => ({
        kind: input.kind,
        ...(input.preview === undefined ? {} : { preview: input.preview }),
        ...(input.originalLength === undefined ? {} : {
          originalLength: input.originalLength,
        }),
        ...(input.truncated === undefined ? {} : {
          truncated: input.truncated,
        }),
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      })),
      ...(turn.reasoningSetting === undefined ? {} : {
        reasoningSetting: turn.reasoningSetting,
      }),
      calls: turn.calls.map<ModelCall>((call) => {
        const text = call.content?.find((content) => content.kind === "text");
        return {
          id: call.id,
          callWithinTurn: call.callWithinTurn,
          ...(text?.preview === undefined ? {} : { preview: text.preview }),
          provider: call.provider,
          model: call.model,
          startedAt: call.startedAt,
          ...(call.completedAt === undefined ? {} : {
            completedAt: call.completedAt,
          }),
          ...(call.reportedCost === undefined ? {} : {
            reportedCost: call.reportedCost,
          }),
          tokens: call.tokens,
          activity: {
            ...(call.activity.finishReason === undefined ? {} : {
              finishReason: call.activity.finishReason,
            }),
            ...(call.activity.images === undefined ? {} : {
              images: call.activity.images,
            }),
            hasText: call.activity.hasText,
            hasReasoning: call.activity.hasReasoning,
            tools: call.activity.tools.map((tool) => ({
              name: tool.name,
              status: tool.status,
              ...(tool.startedAt === undefined ? {} : {
                startedAt: tool.startedAt,
              }),
              ...(tool.completedAt === undefined ? {} : {
                completedAt: tool.completedAt,
              }),
              ...(tool.childExternalID === undefined ? {} : {
                childSessionID: byID.get(tool.childExternalID)?.publicID ??
                  tool.childExternalID,
              }),
              ...(tool.inputPreview === undefined ? {} : {
                inputPreview: tool.inputPreview,
              }),
              ...(tool.outputPreview === undefined ? {} : {
                outputPreview: tool.outputPreview,
              }),
            })),
          },
          ...(call.reasoningSetting === undefined ? {} : {
            reasoningSetting: call.reasoningSetting,
          }),
          contextEventsBefore: (attached.get(
            `${turn.number}:${call.callWithinTurn}`,
          ) ?? []).map(contextEvent),
        };
      }),
    }));
    return {
      id: value.publicID ?? value.externalID,
      ...(value.artifactPath === undefined ? {} : {
        sourcePath: value.artifactPath,
      }),
      ...(value.workingDirectory === undefined ? {} : {
        workingDirectory: value.workingDirectory,
      }),
      harness,
      title: value.session.title,
      updatedAt: value.session.updatedAt,
      ...(value.session.startedAt === undefined ? {} : {
        startedAt: value.session.startedAt,
      }),
      ...(value.session.endedAt === undefined ? {} : {
        endedAt: value.session.endedAt,
      }),
      providers: value.session.providers,
      models: value.session.models,
      userTurns: turns.length,
      modelCalls: turns.reduce((total, turn) => total + turn.calls.length, 0),
      ...(value.session.reportedCost === undefined ? {} : {
        reportedCost: value.session.reportedCost,
      }),
      tokens: value.session.tokens,
      ...(value.parentExternalID === undefined ? {} : {
        parentID: byID.get(value.parentExternalID)?.publicID ??
          value.parentExternalID,
      }),
      ...(value.session.agent === undefined ? {} : {
        agent: value.session.agent,
      }),
      turns,
      contextEvents: events.filter((event) => event.affectedCall === undefined)
        .map(contextEvent),
      subagents: (children.get(value.externalID) ?? []).map(hydrate),
    };
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
