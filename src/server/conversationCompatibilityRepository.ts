import type { DatabaseSync } from "node:sqlite";
import {
  type ContextEvent,
  type ModelCall,
  type SessionDetail,
  sessionDetailSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  type SessionMissFilter,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import {
  analyzeCacheMisses,
  analyzeSessionCache,
  sessionCacheIssues,
} from "./cacheAnalysis.ts";
import { computeModelCallCost } from "./pricing.ts";
import { buildSessionRollup, type SessionRollup } from "./sessionRollups.ts";
import type {
  InitialInputDistribution,
  InitialInputSample,
  ModelCallCostSummary,
  ReasoningSettingImport,
  SourceSessionImport,
  StoredCacheMiss,
  StoredSessionShapeRollup,
} from "./sessionRepository.ts";
import type { ToolCallObservation } from "./toolCallAnalytics.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import type {
  StoredSubagentUsage,
  StoredUsageRollup,
} from "./usageAnalytics.ts";
import type { UsageCall } from "./usage.ts";

type Harness = SessionSummary["harness"];

type ConversationRow = {
  id: number;
  source_id: number;
  external_id: string;
  public_id: string | null;
  harness: Harness;
  title: string;
  agent: string | null;
  working_directory: string | null;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  providers_json: string;
  models_json: string;
  user_turns: number;
  model_calls: number;
  reported_cost: number | null;
  computed_cost: number | null;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
};

type CallRow = {
  id: number;
  turn_id: number;
  source_call_id: string | null;
  source_turn_id: string | null;
  turn_ordinal: number;
  turn_started_at: number;
  turn_reasoning_setting_name: string | null;
  turn_reasoning_setting_value: string | null;
  turn_reasoning_source_field_path: string | null;
  turn_reasoning_source_order: number | null;
  turn_reasoning_observed_at: number | null;
  turn_reasoning_provenance: ReasoningSettingImport["provenance"] | null;
  call_within_turn: number | null;
  provider: string;
  model: string;
  started_at: number;
  completed_at: number | null;
  reported_cost: number | null;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
  finish_reason: string | null;
  images: number | null;
  has_text: number;
  has_reasoning: number;
  reasoning_setting_name: string | null;
  reasoning_setting_value: string | null;
  reasoning_source_field_path: string | null;
  reasoning_source_order: number | null;
  reasoning_observed_at: number | null;
  reasoning_provenance: ReasoningSettingImport["provenance"] | null;
  source_order_start: number | null;
};

const conversationColumns = `
  c.id, c.source_id, c.external_id, c.public_id, so.harness, c.title, c.agent,
  c.working_directory, c.updated_at, c.started_at, c.ended_at,
  c.providers_json, c.models_json, cr.user_turns, cr.model_calls,
  cr.reported_cost, cr.computed_cost, cr.uncached_input_tokens,
  cr.cache_read_tokens, cr.cache_write_tokens, cr.cache_write_5m_tokens,
  cr.cache_write_1h_tokens, cr.fresh_prompt_tokens, cr.output_tokens,
  cr.reasoning_tokens, cr.processed_tokens
`;

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function tokens(row: {
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
}): TokenUsage {
  return {
    uncachedInput: row.uncached_input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: optional(row.cache_write_tokens),
    cacheWrite5m: optional(row.cache_write_5m_tokens),
    cacheWrite1h: optional(row.cache_write_1h_tokens),
    freshPrompt: row.fresh_prompt_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
    processed: row.processed_tokens,
  };
}

function reasoningSetting(row: {
  reasoning_setting_name: string | null;
  reasoning_setting_value: string | null;
  reasoning_source_field_path: string | null;
  reasoning_source_order: number | null;
  reasoning_observed_at: number | null;
  reasoning_provenance: ReasoningSettingImport["provenance"] | null;
}) {
  if (
    row.reasoning_setting_name === null ||
    row.reasoning_setting_value === null ||
    row.reasoning_provenance === null
  ) return undefined;
  return {
    settingName: row.reasoning_setting_name,
    settingValue: row.reasoning_setting_value,
    sourceFieldPath: optional(row.reasoning_source_field_path),
    sourceOrder: optional(row.reasoning_source_order),
    observedAt: optional(row.reasoning_observed_at),
    provenance: row.reasoning_provenance,
  };
}

function percentile(values: number[], quantile: number) {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const remainder = index - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * remainder ||
    sorted[lower];
}

function modelCallCost(
  call: Pick<
    UsageCall,
    "tokens" | "model" | "startedAt" | "reportedCost"
  >,
) {
  return computeModelCallCost(call.tokens, call.model, call.startedAt) ??
    call.reportedCost;
}

/** Existing session/analytics contracts reconstructed from conversation tables. */
export class ConversationCompatibilityRepository {
  constructor(private db: DatabaseSync) {}

  listSessions(
    page: number,
    pageSize: number,
    harness?: Harness,
    missFilters?: SessionMissFilter[],
  ): SessionListResponse {
    if (
      !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) ||
      pageSize < 1
    ) {
      throw new RangeError("page and pageSize must be positive integers");
    }
    let rows = this.#rootRows(harness).filter((row) =>
      row.uncached_input_tokens > 0 || row.cache_read_tokens > 0 ||
      (row.cache_write_tokens ?? 0) > 0
    );
    if (missFilters !== undefined) {
      rows = missFilters.length === 0 ? [] : rows.filter((row) => {
        const detail = this.#detail(row, new Set());
        const issues = sessionCacheIssues(analyzeSessionCache(detail));
        return issues.some((issue) =>
          (missFilters.includes("ttl") && issue.cause === "ttl") ||
          (missFilters.includes("thinking-change") &&
            issue.cause === "thinking-change") ||
          (missFilters.includes("full-miss") && issue.cause === undefined &&
            issue.status === "full-miss") ||
          (missFilters.includes("partial-miss") &&
            issue.cause === undefined && issue.status === "partial-hit")
        ) || (missFilters.includes("compaction") &&
          this.#conversationMisses(row, row).some((miss) =>
            miss.cause === "compaction"
          ));
      });
    }
    const totalItems = rows.length;
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map((
      row,
    ) => this.#summary(row));
    return sessionListResponseSchema.parse({
      items,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    });
  }

  getSession(harness: Harness, id: string): SessionDetail | undefined {
    const row = this.db.prepare(`
      SELECT ${conversationColumns}
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE so.harness = ? AND COALESCE(c.public_id, c.external_id) = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      ORDER BY c.id LIMIT 1
    `).get(harness, id) as ConversationRow | undefined;
    return row === undefined
      ? undefined
      : sessionDetailSchema.parse(this.#detail(row, new Set()));
  }

  listUsageCalls(startedAt?: number, harness?: Harness): UsageCall[] {
    const rows = this.#rootRows(harness);
    return rows.flatMap((row) => this.#canonicalUsageCalls(row)).filter((
      call,
    ) => startedAt === undefined || call.startedAt >= startedAt).sort((a, b) =>
      a.startedAt - b.startedAt || a.turnID.localeCompare(b.turnID)
    );
  }

  listToolCalls(
    startedAt: number,
    endedAt: number,
    harness?: Harness,
  ): ToolCallObservation[] {
    const rows = this.db.prepare(`
      SELECT tool.model_call_id, tool.name, tool.input_preview,
        tool.started_at AS tool_started_at,
        tool.completed_at AS tool_completed_at,
        call.started_at AS model_started_at,
        call.completed_at AS model_completed_at
      FROM conversation_tool_events tool
      JOIN conversation_model_calls call ON call.id = tool.model_call_id
      JOIN conversations c ON c.id = call.conversation_id
      JOIN sources so ON so.id = c.source_id
      WHERE call.started_at >= ? AND call.started_at <= ?
        AND (? IS NULL OR so.harness = ?)
      ORDER BY tool.id
    `).all(
      startedAt,
      endedAt,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      model_call_id: number;
      name: string;
      input_preview: string | null;
      tool_started_at: number | null;
      tool_completed_at: number | null;
      model_started_at: number;
      model_completed_at: number | null;
    }>;
    return rows.map((row) => ({
      modelCallID: row.model_call_id,
      name: row.name,
      inputPreview: optional(row.input_preview),
      startedAt: optional(row.tool_started_at),
      completedAt: optional(row.tool_completed_at),
      modelStartedAt: row.model_started_at,
      modelCompletedAt: optional(row.model_completed_at),
    }));
  }

  summarizeModelCallCosts(
    startedAt: number,
    harness?: Harness,
  ): ModelCallCostSummary {
    const roots = this.#rootRows(harness);
    const allCalls = roots.flatMap((root) => this.#canonicalUsageCalls(root));
    const scoped = allCalls.filter((call) => call.startedAt >= startedAt);
    const byRoot = Map.groupBy(
      scoped,
      (call) => `${call.harness}:${call.session.rootID}`,
    );
    const sessions = roots.filter((root) =>
      (root.started_at ?? root.updated_at) >= startedAt
    ).map((root) => {
      const calls =
        byRoot.get(`${root.harness}:${root.public_id ?? root.external_id}`) ??
          [];
      const rootID = root.public_id ?? root.external_id;
      const rootCalls = calls.filter((call) => call.session.id === rootID);
      return {
        harness: root.harness,
        rootID,
        sessionStartedAt: root.started_at ?? root.updated_at,
        rootCost: rootCalls.reduce(
          (sum, call) => sum + (modelCallCost(call) ?? 0),
          0,
        ),
        hasUnpricedRootCost: rootCalls.some((call) =>
          modelCallCost(call) === undefined
        ),
      };
    });
    return {
      totalCost: scoped.reduce(
        (sum, call) => sum + (modelCallCost(call) ?? 0),
        0,
      ),
      hasUnpricedTotalCost: scoped.some((call) =>
        modelCallCost(call) === undefined
      ),
      totalSessionCost: sessions.reduce(
        (sum, session) => sum + session.rootCost,
        0,
      ),
      hasUnpricedSessionCost: sessions.some((session) =>
        session.hasUnpricedRootCost
      ),
      sessions,
    };
  }

  listCacheMisses(startedAt?: number, harness?: Harness): StoredCacheMiss[] {
    return this.#rootRows(harness).flatMap((row) =>
      this.#conversationMisses(row, row)
    ).filter((miss) =>
      startedAt === undefined ||
      this.#callStartedAt(miss.modelCallID) >= startedAt
    )
      .sort((a, b) =>
        this.#callStartedAt(a.modelCallID) -
          this.#callStartedAt(b.modelCallID) ||
        a.modelCallID - b.modelCallID
      );
  }

  listOverviewRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredOverviewRollup[] {
    return this.#rollups(harness).filter(({ rollup }) =>
      (rollup.lastActivityAt ?? 0) >= startedAt
    ).map(({ row, rollup }) => ({
      rootSessionID: row.id,
      title: row.title,
      harness: row.harness,
      overview: rollup.overview,
    }));
  }

  listSessionShapeRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredSessionShapeRollup[] {
    return this.#rollups(harness).filter(({ rollup }) =>
      (rollup.lastActivityAt ?? 0) >= startedAt
    ).map(({ row, rollup, root }) => ({
      rootSessionID: row.id,
      title: row.title,
      harness: row.harness,
      overview: rollup.overview,
      initialInput: root.session.turns[0]?.calls[0] === undefined
        ? undefined
        : this.#input(root.session.turns[0].calls[0].tokens),
    }));
  }

  listUsageRollups(
    startedAt?: number,
    harness?: Harness,
  ): StoredUsageRollup[] {
    return this.#rollups(harness).filter(({ rollup }) =>
      startedAt === undefined || (rollup.lastActivityAt ?? 0) >= startedAt
    ).map(({ row, rollup, root }) => ({
      rootSessionID: row.id,
      sessionStartedAt: row.started_at ?? row.updated_at,
      directInput: this.#input(root.session.tokens),
      subagentInput: this.#input(rollup.subagentTokens),
      subagentModelCalls: rollup.subagentModelCalls,
      overview: rollup.overview,
    }));
  }

  listSubagentUsage(
    startedAt?: number,
    harness?: Harness,
  ): StoredSubagentUsage[] {
    const result: StoredSubagentUsage[] = [];
    for (const { row, tree } of this.#rollups(harness)) {
      for (const subagent of tree.slice(1)) {
        const calls = subagent.session.turns.flatMap((turn) => turn.calls)
          .filter((call) =>
            startedAt === undefined || call.startedAt >= startedAt
          );
        for (
          const [date, dayCalls] of Map.groupBy(
            calls,
            (call) => this.#date(call.startedAt),
          )
        ) {
          const costs = dayCalls.map(modelCallCost);
          result.push({
            rootSessionID: row.id,
            subagentSessionID: Number(subagent.externalID.split(":").at(-1)) ||
              this.#conversationID(row.source_id, subagent.externalID),
            date,
            input: dayCalls.reduce(
              (sum, call) => sum + this.#input(call.tokens),
              0,
            ),
            cost: costs.reduce<number>(
              (sum, cost) => sum + (cost ?? 0),
              0,
            ),
            hasUnpricedCost: costs.some((cost) => cost === undefined),
          });
        }
      }
    }
    return result.sort((a, b) =>
      a.date.localeCompare(b.date) || a.rootSessionID - b.rootSessionID ||
      a.subagentSessionID - b.subagentSessionID
    );
  }

  listInitialInputSamples(
    startedAt?: number,
    harness?: Harness,
  ): InitialInputSample[] {
    return this.#rollups(harness).flatMap(({ row, root }) => {
      const sessionStartedAt = row.started_at ?? row.updated_at;
      const call = root.session.turns[0]?.calls[0];
      return call === undefined ||
          (startedAt !== undefined && sessionStartedAt < startedAt)
        ? []
        : [{
          harness: row.harness,
          sessionStartedAt,
          input: this.#input(call.tokens),
        }];
    }).sort((a, b) => a.sessionStartedAt - b.sessionStartedAt);
  }

  initialInputDistribution(
    startedAt: number,
    harness?: Harness,
  ): InitialInputDistribution | undefined {
    const values = this.listInitialInputSamples(startedAt, harness).map((
      sample,
    ) => sample.input);
    return values.length === 0 ? undefined : {
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
    };
  }

  #rootRows(harness?: Harness): ConversationRow[] {
    return this.db.prepare(`
      SELECT ${conversationColumns}
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE (? IS NULL OR so.harness = ?)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      ORDER BY c.updated_at DESC, COALESCE(c.public_id, c.external_id) DESC,
        so.harness DESC
    `).all(harness ?? null, harness ?? null) as ConversationRow[];
  }

  #summary(row: ConversationRow): SessionSummary {
    const thinkingRows = this.db.prepare(`
      SELECT reasoning_setting_value AS value
      FROM conversation_model_calls
      WHERE conversation_id = ? AND reasoning_setting_value IS NOT NULL
        AND COALESCE(source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY started_at, ordinal
    `).all(row.id) as Array<{ value: string }>;
    const values = [...new Set(thinkingRows.map((item) => item.value))];
    const branch = this.#selectedBranch(row.id);
    const source = branch === undefined ? undefined : this.db.prepare(`
      SELECT artifact_path FROM source_sessions WHERE id = ?
    `).get(branch.source_session_id) as
      | { artifact_path: string | null }
      | undefined;
    return {
      id: row.public_id ?? row.external_id,
      internalID: row.id,
      sourcePath: optional(source?.artifact_path ?? null),
      workingDirectory: optional(row.working_directory),
      harness: row.harness,
      title: row.title,
      updatedAt: row.updated_at,
      startedAt: optional(row.started_at),
      endedAt: optional(row.ended_at),
      providers: JSON.parse(row.providers_json),
      models: JSON.parse(row.models_json),
      userTurns: row.user_turns,
      modelCalls: row.model_calls,
      thinking: {
        latest: thinkingRows.at(-1)?.value,
        values,
        classifiedCalls: thinkingRows.length,
      },
      reportedCost: optional(row.reported_cost),
      tokens: tokens(row),
    };
  }

  #selectedBranch(conversationID: number) {
    return this.db.prepare(`
      SELECT id, source_session_id FROM conversation_branches
      WHERE conversation_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(conversationID) as {
      id: number;
      source_session_id: number;
    } | undefined;
  }

  #detail(row: ConversationRow, visited: Set<number>): SessionDetail {
    if (visited.has(row.id)) throw new Error("Conversation subagent cycle");
    const nextVisited = new Set(visited).add(row.id);
    const branch = this.#selectedBranch(row.id);
    const calls = branch === undefined ? [] : this.#branchCalls(branch.id);
    const callIDs = calls.map((call) => call.id);
    const placeholders = callIDs.map(() => "?").join(", ");
    const contentRows = callIDs.length === 0 ? [] : this.db.prepare(`
      SELECT producer_model_call_id AS model_call_id,
        COALESCE(content_kind, kind) AS kind, content_preview,
        original_length, truncated
      FROM conversation_entries
      WHERE producer_model_call_id IN (${placeholders})
      ORDER BY producer_model_call_id, output_ordinal
    `).all(...callIDs) as Array<{
      model_call_id: number;
      kind: string;
      content_preview: string | null;
      original_length: number | null;
      truncated: number;
    }>;
    const tools = callIDs.length === 0 ? [] : this.db.prepare(`
      SELECT tool.id, tool.model_call_id, tool.name, tool.status,
        tool.started_at, tool.completed_at, tool.input_preview,
        tool.output_preview, child.public_id AS child_public_id,
        child.external_id AS child_external_id
      FROM conversation_tool_events tool
      LEFT JOIN conversation_subagent_launches launch
        ON launch.tool_event_id = tool.id
      LEFT JOIN conversations child ON child.id = launch.child_conversation_id
      WHERE tool.model_call_id IN (${placeholders})
      ORDER BY tool.model_call_id, tool.ordinal
    `).all(...callIDs) as Array<{
      id: number;
      model_call_id: number;
      name: string;
      status: string;
      started_at: number | null;
      completed_at: number | null;
      input_preview: string | null;
      output_preview: string | null;
      child_public_id: string | null;
      child_external_id: string | null;
    }>;
    const turnIDs = [...new Set(calls.map((call) => call.turn_id))];
    const turnPlaceholders = turnIDs.map(() => "?").join(", ");
    const inputs = turnIDs.length === 0 ? [] : this.db.prepare(`
      SELECT entry.turn_id, COALESCE(entry.content_kind, entry.kind) AS kind,
        entry.content_preview,
        entry.original_length, entry.truncated, entry.mime_type
      FROM conversation_entries entry
      JOIN artifact_entry_occurrences occurrence ON occurrence.entry_id = entry.id
      WHERE occurrence.branch_id = ?
        AND entry.turn_id IN (${turnPlaceholders})
        AND entry.role = 'user'
        AND entry.producer_model_call_id IS NULL
        AND entry.producer_tool_event_id IS NULL
      ORDER BY occurrence.source_order_start, entry.id
    `).all(branch!.id, ...turnIDs) as Array<{
      turn_id: number;
      kind: string;
      content_preview: string | null;
      original_length: number | null;
      truncated: number;
      mime_type: string | null;
    }>;

    const groupedCalls = Map.groupBy(calls, (call) => call.turn_id);
    const hydratedByCallID = new Map<number, ModelCall>();
    const turnOrder = [...groupedCalls.entries()].sort(([, a], [, b]) =>
      (a[0].source_order_start ?? a[0].turn_ordinal) -
      (b[0].source_order_start ?? b[0].turn_ordinal)
    );
    const turns = turnOrder.map(([turnID, turnCalls], turnIndex) => {
      const first = turnCalls[0];
      const hydratedCalls: ModelCall[] = turnCalls.map((call) => {
        const callContent = contentRows.filter((content) =>
          content.model_call_id === call.id
        );
        const text = callContent.find((content) => content.kind === "text");
        const callTools = tools.filter((tool) =>
          tool.model_call_id === call.id
        );
        const hydrated: ModelCall = {
          id: call.source_call_id ?? String(call.id),
          callWithinTurn: call.call_within_turn ?? 1,
          preview: optional(
            text?.content_preview ?? callTools[0]?.input_preview ?? null,
          ),
          ...(text === undefined ? {} : {
            responsePreview: text.content_preview!,
            responseOriginalLength: optional(text.original_length),
            responseTruncated: Boolean(text.truncated),
          }),
          provider: call.provider,
          model: call.model,
          startedAt: call.started_at,
          completedAt: optional(call.completed_at),
          reportedCost: optional(call.reported_cost),
          tokens: tokens(call),
          reasoningSetting: reasoningSetting(call),
          contextEventsBefore: [],
          activity: {
            finishReason: optional(call.finish_reason),
            images: optional(call.images),
            hasText: Boolean(call.has_text),
            hasReasoning: Boolean(call.has_reasoning),
            tools: callTools.map((tool) => ({
              name: tool.name,
              status: tool.status,
              startedAt: optional(tool.started_at),
              completedAt: optional(tool.completed_at),
              childSessionID: optional(
                tool.child_public_id ?? tool.child_external_id,
              ),
              inputPreview: optional(tool.input_preview),
              outputPreview: optional(tool.output_preview),
            })),
          },
        };
        hydratedByCallID.set(call.id, hydrated);
        return hydrated;
      });
      return {
        number: turnIndex + 1,
        startedAt: first.turn_started_at,
        inputs: inputs.filter((input) => input.turn_id === turnID).map((
          input,
        ) => ({
          kind: input.kind,
          preview: optional(input.content_preview),
          originalLength: optional(input.original_length),
          truncated: Boolean(input.truncated),
          mimeType: optional(input.mime_type),
        })),
        reasoningSetting: reasoningSetting({
          reasoning_setting_name: first.turn_reasoning_setting_name,
          reasoning_setting_value: first.turn_reasoning_setting_value,
          reasoning_source_field_path: first.turn_reasoning_source_field_path,
          reasoning_source_order: first.turn_reasoning_source_order,
          reasoning_observed_at: first.turn_reasoning_observed_at,
          reasoning_provenance: first.turn_reasoning_provenance,
        }),
        calls: hydratedCalls,
      };
    });

    const contextRows = branch === undefined ? [] : this.db.prepare(`
      SELECT entry.native_metadata_json, occurrence.source_order_start
      FROM conversation_entries entry
      JOIN artifact_entry_occurrences occurrence ON occurrence.entry_id = entry.id
      WHERE occurrence.branch_id = ? AND entry.kind = 'context-event'
      ORDER BY occurrence.source_order_start, entry.id
    `).all(branch.id) as Array<{
      native_metadata_json: string;
      source_order_start: number | null;
    }>;
    const sessionContextEvents: ContextEvent[] = [];
    for (const contextRow of contextRows) {
      const raw = JSON.parse(contextRow.native_metadata_json) as
        & ContextEvent
        & {
          affectedCall?: { turn: number; call: number };
        };
      const { affectedCall, ...event } = raw;
      let target = affectedCall === undefined
        ? undefined
        : turns[affectedCall.turn - 1]?.calls.find((call) =>
          call.callWithinTurn === affectedCall.call
        );
      if (target === undefined && contextRow.source_order_start !== null) {
        const nextCall = calls.find((call) =>
          call.source_order_start !== null &&
          call.source_order_start > contextRow.source_order_start!
        );
        target = nextCall === undefined
          ? undefined
          : hydratedByCallID.get(nextCall.id);
      }
      if (target === undefined) sessionContextEvents.push(event);
      else {target.contextEventsBefore = [
          ...(target.contextEventsBefore ?? []),
          event,
        ];}
    }

    const children = this.db.prepare(`
      SELECT ${conversationColumns}
      FROM conversation_subagent_launches launch
      JOIN conversations c ON c.id = launch.child_conversation_id
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE launch.parent_conversation_id = ?
      ORDER BY c.updated_at, c.id
    `).all(row.id) as ConversationRow[];
    const summary = this.#summary(row);
    return {
      ...summary,
      agent: optional(row.agent),
      parentID: this.#parentPublicID(row.id),
      userTurns: turns.length,
      modelCalls: turns.reduce((sum, turn) => sum + turn.calls.length, 0),
      turns,
      contextEvents: sessionContextEvents,
      subagents: children.map((child) => this.#detail(child, nextVisited)),
    };
  }

  #branchCalls(branchID: number): CallRow[] {
    return this.db.prepare(`
      SELECT call.id, call.turn_id, call.source_call_id, turn.source_turn_id,
        turn.ordinal AS turn_ordinal, turn.started_at AS turn_started_at,
        turn.reasoning_setting_name AS turn_reasoning_setting_name,
        turn.reasoning_setting_value AS turn_reasoning_setting_value,
        turn.reasoning_source_field_path AS turn_reasoning_source_field_path,
        turn.reasoning_source_order AS turn_reasoning_source_order,
        turn.reasoning_observed_at AS turn_reasoning_observed_at,
        turn.reasoning_provenance AS turn_reasoning_provenance,
        call.call_within_turn, call.provider, call.model, call.started_at,
        call.completed_at, call.reported_cost, call.uncached_input_tokens,
        call.cache_read_tokens, call.cache_write_tokens,
        call.cache_write_5m_tokens, call.cache_write_1h_tokens,
        call.fresh_prompt_tokens, call.output_tokens, call.reasoning_tokens,
        call.processed_tokens, call.finish_reason, call.images, call.has_text,
        call.has_reasoning, call.reasoning_setting_name,
        call.reasoning_setting_value, call.reasoning_source_field_path,
        call.reasoning_source_order, call.reasoning_observed_at,
        call.reasoning_provenance, occurrence.source_order_start
      FROM artifact_model_call_occurrences occurrence
      JOIN conversation_model_calls call ON call.id = occurrence.model_call_id
      JOIN conversation_turns turn ON turn.id = call.turn_id
      WHERE occurrence.branch_id = ?
        AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY occurrence.source_order_start, call.ordinal
    `).all(branchID) as CallRow[];
  }

  #canonicalUsageCalls(
    row: ConversationRow,
    root: ConversationRow = row,
    parentID?: string,
    includeChildren = true,
  ): UsageCall[] {
    const calls = this.db.prepare(`
      SELECT call.*, turn.source_turn_id, turn.ordinal AS turn_ordinal,
        turn.reasoning_setting_name AS turn_reasoning_setting_name,
        turn.reasoning_setting_value AS turn_reasoning_setting_value,
        turn.reasoning_source_field_path AS turn_reasoning_source_field_path,
        turn.reasoning_source_order AS turn_reasoning_source_order,
        turn.reasoning_observed_at AS turn_reasoning_observed_at,
        turn.reasoning_provenance AS turn_reasoning_provenance,
        turn.started_at AS turn_started_at,
        NULL AS source_order_start
      FROM conversation_model_calls call
      JOIN conversation_turns turn ON turn.id = call.turn_id
      WHERE call.conversation_id = ?
        AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY call.started_at, call.ordinal
    `).all(row.id) as CallRow[];
    const sessionID = row.public_id ?? row.external_id;
    const rootID = root.public_id ?? root.external_id;
    const own = calls.map((call) => ({
      modelCallID: call.id,
      previousModelCallID: this.#predecessorCallID(call.id),
      harness: row.harness,
      session: { id: sessionID, rootID, parentID },
      cacheChainID: row.external_id,
      turnID: `${sessionID}:${call.turn_ordinal}`,
      turnOrdinal: call.turn_ordinal,
      images: optional(call.images),
      sessionStartedAt: root.started_at ?? root.updated_at,
      provider: call.provider,
      model: call.model,
      startedAt: call.started_at,
      ...((reasoningSetting(call) ?? reasoningSetting({
          reasoning_setting_name: call.turn_reasoning_setting_name,
          reasoning_setting_value: call.turn_reasoning_setting_value,
          reasoning_source_field_path: call.turn_reasoning_source_field_path,
          reasoning_source_order: call.turn_reasoning_source_order,
          reasoning_observed_at: call.turn_reasoning_observed_at,
          reasoning_provenance: call.turn_reasoning_provenance,
        })) === undefined
        ? {}
        : {
          reasoningSetting: reasoningSetting(call) ?? reasoningSetting({
            reasoning_setting_name: call.turn_reasoning_setting_name,
            reasoning_setting_value: call.turn_reasoning_setting_value,
            reasoning_source_field_path: call.turn_reasoning_source_field_path,
            reasoning_source_order: call.turn_reasoning_source_order,
            reasoning_observed_at: call.turn_reasoning_observed_at,
            reasoning_provenance: call.turn_reasoning_provenance,
          }),
        }),
      tokens: tokens(call),
      reportedCost: optional(call.reported_cost),
      computedCost: computeModelCallCost(
        tokens(call),
        call.model,
        call.started_at,
      ),
      followsCompaction: this.#callFollowsCompaction(call.id),
    }));
    if (!includeChildren) return own;
    const children = this.db.prepare(`
      SELECT ${conversationColumns}
      FROM conversation_subagent_launches launch
      JOIN conversations c ON c.id = launch.child_conversation_id
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE launch.parent_conversation_id = ? ORDER BY c.id
    `).all(row.id) as ConversationRow[];
    return [
      ...own,
      ...children.flatMap((child) =>
        this.#canonicalUsageCalls(child, root, sessionID, true)
      ),
    ];
  }

  #conversationMisses(
    row: ConversationRow,
    root: ConversationRow,
    parentID?: string,
  ): StoredCacheMiss[] {
    const calls = this.#canonicalUsageCalls(
      row,
      root,
      parentID,
      false,
    );
    const byID = new Map(
      calls.flatMap((call) =>
        call.modelCallID === undefined
          ? []
          : [[call.modelCallID, call] as const]
      ),
    );
    const own = calls.flatMap((call) => {
      if (
        call.modelCallID === undefined || call.previousModelCallID === undefined
      ) return [];
      const previous = byID.get(call.previousModelCallID);
      if (previous === undefined) return [];
      const analysis = analyzeCacheMisses([previous, call].map((item) => ({
        id: String(item.modelCallID),
        provider: item.provider,
        model: item.model,
        tokens: item.tokens,
        startedAt: item.startedAt,
        reasoningSetting: item.reasoningSetting,
        followsCompaction: item.followsCompaction,
      })))[0];
      if (analysis === undefined) return [];
      const { callID: _callID, previousCallID: _previousCallID, ...miss } =
        analysis;
      const turn = this.db.prepare(`
        SELECT turn_id FROM conversation_model_calls WHERE id = ?
      `).get(call.modelCallID) as { turn_id: number };
      return [{
        harness: row.harness,
        sessionID: call.session.id,
        rootID: call.session.rootID,
        sessionStartedAt: root.started_at ?? root.updated_at,
        modelCallID: call.modelCallID,
        previousModelCallID: call.previousModelCallID,
        turnID: turn.turn_id,
        ...miss,
      }];
    });
    const sessionID = row.public_id ?? row.external_id;
    const children = this.db.prepare(`
      SELECT ${conversationColumns}
      FROM conversation_subagent_launches launch
      JOIN conversations c ON c.id = launch.child_conversation_id
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE launch.parent_conversation_id = ? ORDER BY c.id
    `).all(row.id) as ConversationRow[];
    return [
      ...own,
      ...children.flatMap((child) =>
        this.#conversationMisses(child, root, sessionID)
      ),
    ];
  }

  #rollups(harness?: Harness) {
    return this.#rootRows(harness).map((row) => {
      const tree = this.#canonicalImportTree(row.id);
      const root = tree.find((item) => item.parentExternalID === undefined)!;
      return { row, tree, root, rollup: buildSessionRollup(tree) };
    });
  }

  #canonicalImportTree(rootConversationID: number): SourceSessionImport[] {
    const pending: Array<{ id: number; parentExternalID?: string }> = [{
      id: rootConversationID,
    }];
    const result: SourceSessionImport[] = [];
    while (pending.length > 0) {
      const current = pending.shift()!;
      const row = this.db.prepare(`
        SELECT ${conversationColumns}
        FROM conversations c
        JOIN sources so ON so.id = c.source_id
        JOIN conversation_rollups cr ON cr.conversation_id = c.id
        WHERE c.id = ?
      `).get(current.id) as ConversationRow;
      const externalID = row.external_id;
      result.push(this.#canonicalSourceImport(row, current.parentExternalID));
      const children = this.db.prepare(`
        SELECT child_conversation_id AS id
        FROM conversation_subagent_launches
        WHERE parent_conversation_id = ? ORDER BY id
      `).all(current.id) as Array<{ id: number }>;
      pending.push(...children.map((child) => ({
        id: child.id,
        parentExternalID: externalID,
      })));
    }
    return result;
  }

  #canonicalSourceImport(
    row: ConversationRow,
    parentExternalID?: string,
  ): SourceSessionImport {
    const calls = this.db.prepare(`
      SELECT call.id, call.turn_id, call.source_call_id, turn.source_turn_id,
        turn.ordinal AS turn_ordinal, turn.started_at AS turn_started_at,
        turn.reasoning_setting_name AS turn_reasoning_setting_name,
        turn.reasoning_setting_value AS turn_reasoning_setting_value,
        turn.reasoning_source_field_path AS turn_reasoning_source_field_path,
        turn.reasoning_source_order AS turn_reasoning_source_order,
        turn.reasoning_observed_at AS turn_reasoning_observed_at,
        turn.reasoning_provenance AS turn_reasoning_provenance,
        call.call_within_turn, call.provider, call.model, call.started_at,
        call.completed_at, call.reported_cost, call.uncached_input_tokens,
        call.cache_read_tokens, call.cache_write_tokens,
        call.cache_write_5m_tokens, call.cache_write_1h_tokens,
        call.fresh_prompt_tokens, call.output_tokens, call.reasoning_tokens,
        call.processed_tokens, call.finish_reason, call.images, call.has_text,
        call.has_reasoning, call.reasoning_setting_name,
        call.reasoning_setting_value, call.reasoning_source_field_path,
        call.reasoning_source_order, call.reasoning_observed_at,
        call.reasoning_provenance, NULL AS source_order_start
      FROM conversation_model_calls call
      JOIN conversation_turns turn ON turn.id = call.turn_id
      WHERE call.conversation_id = ?
        AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY turn.ordinal, call.call_within_turn, call.ordinal
    `).all(row.id) as CallRow[];
    const callIDs = calls.map((call) => call.id);
    const placeholders = callIDs.map(() => "?").join(", ");
    const toolRows = callIDs.length === 0 ? [] : this.db.prepare(`
      SELECT model_call_id, source_tool_id, name, status, started_at,
        completed_at, input_preview, input_original_length, input_truncated,
        output_preview, output_original_length, output_truncated
      FROM conversation_tool_events
      WHERE model_call_id IN (${placeholders})
      ORDER BY model_call_id, ordinal
    `).all(...callIDs) as Array<{
      model_call_id: number;
      source_tool_id: string | null;
      name: string;
      status: string;
      started_at: number | null;
      completed_at: number | null;
      input_preview: string | null;
      input_original_length: number | null;
      input_truncated: number;
      output_preview: string | null;
      output_original_length: number | null;
      output_truncated: number;
    }>;
    const grouped = Map.groupBy(calls, (call) => call.turn_id);
    const turns = [...grouped.values()].map((turnCalls, index) => {
      const first = turnCalls[0];
      return {
        number: index + 1,
        startedAt: first.turn_started_at,
        reasoningSetting: reasoningSetting({
          reasoning_setting_name: first.turn_reasoning_setting_name,
          reasoning_setting_value: first.turn_reasoning_setting_value,
          reasoning_source_field_path: first.turn_reasoning_source_field_path,
          reasoning_source_order: first.turn_reasoning_source_order,
          reasoning_observed_at: first.turn_reasoning_observed_at,
          reasoning_provenance: first.turn_reasoning_provenance,
        }),
        calls: turnCalls.map((call) => ({
          id: call.source_call_id ?? String(call.id),
          callWithinTurn: call.call_within_turn ?? 1,
          provider: call.provider,
          model: call.model,
          startedAt: call.started_at,
          completedAt: optional(call.completed_at),
          reportedCost: optional(call.reported_cost),
          tokens: tokens(call),
          reasoningSetting: reasoningSetting(call),
          activity: {
            finishReason: optional(call.finish_reason),
            images: optional(call.images),
            hasText: Boolean(call.has_text),
            hasReasoning: Boolean(call.has_reasoning),
            tools: toolRows.filter((tool) => tool.model_call_id === call.id)
              .map(
                (tool) => ({
                  sourceID: optional(tool.source_tool_id),
                  name: tool.name,
                  status: tool.status,
                  startedAt: optional(tool.started_at),
                  completedAt: optional(tool.completed_at),
                  input: tool.input_preview === null ? undefined : {
                    preview: tool.input_preview,
                    originalLength: optional(tool.input_original_length),
                    truncated: Boolean(tool.input_truncated),
                  },
                  output: tool.output_preview === null ? undefined : {
                    preview: tool.output_preview,
                    originalLength: optional(tool.output_original_length),
                    truncated: Boolean(tool.output_truncated),
                  },
                }),
              ),
          },
        })),
      };
    });
    return {
      sourceID: 0,
      externalID: row.external_id,
      parentExternalID,
      observedAt: row.updated_at,
      checkpoint: {},
      session: {
        title: row.title,
        agent: optional(row.agent),
        updatedAt: row.updated_at,
        startedAt: optional(row.started_at),
        endedAt: optional(row.ended_at),
        providers: JSON.parse(row.providers_json),
        models: JSON.parse(row.models_json),
        userTurns: turns.length,
        modelCalls: calls.length,
        reportedCost: optional(row.reported_cost),
        tokens: tokens(row),
        turns,
      },
    };
  }

  #parentPublicID(conversationID: number) {
    const row = this.db.prepare(`
      SELECT COALESCE(parent.public_id, parent.external_id) AS id
      FROM conversation_subagent_launches launch
      JOIN conversations parent ON parent.id = launch.parent_conversation_id
      WHERE launch.child_conversation_id = ? LIMIT 1
    `).get(conversationID) as { id: string } | undefined;
    return row?.id;
  }

  #callStartedAt(callID: number) {
    return Number(
      (this.db.prepare(`
      SELECT started_at FROM conversation_model_calls WHERE id = ?
    `).get(callID) as { started_at: number }).started_at,
    );
  }

  #input(value: TokenUsage) {
    return value.uncachedInput + value.cacheRead + (value.cacheWrite ?? 0);
  }

  #date(value: number) {
    const date = new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  #conversationID(sourceID: number, externalID: string) {
    return Number(
      (this.db.prepare(`
      SELECT id FROM conversations
      WHERE source_id = ? AND external_id = ? LIMIT 1
    `).get(sourceID, externalID) as { id: number }).id,
    );
  }

  #predecessorCallID(modelCallID: number): number | undefined {
    const row = this.db.prepare(`
      WITH origin AS (
        SELECT branch_id, source_order_start
        FROM artifact_model_call_occurrences
        WHERE model_call_id = ? AND occurrence_kind = 'executed'
        ORDER BY source_order_start, branch_id LIMIT 1
      )
      SELECT previous.model_call_id AS id
      FROM origin
      JOIN artifact_model_call_occurrences previous
        ON previous.branch_id = origin.branch_id
       AND previous.source_order_start < origin.source_order_start
      JOIN conversation_model_calls call ON call.id = previous.model_call_id
      WHERE COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY previous.source_order_start DESC, call.ordinal DESC LIMIT 1
    `).get(modelCallID) as { id: number } | undefined;
    if (row !== undefined) return row.id;
    const fallback = this.db.prepare(`
      SELECT previous.id
      FROM conversation_model_calls current
      JOIN conversation_model_calls previous
        ON previous.conversation_id = current.conversation_id
       AND previous.ordinal < current.ordinal
      WHERE current.id = ?
        AND COALESCE(previous.source_call_id, '')
          NOT LIKE 'context-operation:%'
      ORDER BY previous.ordinal DESC LIMIT 1
    `).get(modelCallID) as { id: number } | undefined;
    return fallback?.id;
  }

  #callFollowsCompaction(modelCallID: number): boolean {
    const directlyLinked = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM conversation_model_calls call
        JOIN conversation_turns turn ON turn.id = call.turn_id
        JOIN conversation_entries entry
          ON entry.conversation_id = call.conversation_id
        WHERE call.id = ? AND entry.kind = 'context-event'
          AND json_extract(entry.native_metadata_json, '$.type') = 'compaction'
          AND json_extract(
            entry.native_metadata_json,
            '$.affectedCall.turn'
          ) = turn.ordinal
          AND json_extract(
            entry.native_metadata_json,
            '$.affectedCall.call'
          ) = call.call_within_turn
      ) AS follows
    `).get(modelCallID) as { follows: number };
    if (directlyLinked.follows === 1) return true;
    const row = this.db.prepare(`
      WITH origin AS (
        SELECT branch_id, source_order_start
        FROM artifact_model_call_occurrences
        WHERE model_call_id = ? AND occurrence_kind = 'executed'
        ORDER BY source_order_start, branch_id LIMIT 1
      ), predecessor AS (
        SELECT MAX(previous.source_order_end) AS source_order_end
        FROM origin
        LEFT JOIN artifact_model_call_occurrences previous
          ON previous.branch_id = origin.branch_id
         AND previous.source_order_start < origin.source_order_start
      )
      SELECT EXISTS (
        SELECT 1
        FROM origin, predecessor
        JOIN artifact_entry_occurrences occurrence
          ON occurrence.branch_id = origin.branch_id
        JOIN conversation_entries entry ON entry.id = occurrence.entry_id
        WHERE entry.kind = 'context-event'
          AND occurrence.source_order_start >
            COALESCE(predecessor.source_order_end, 0)
          AND occurrence.source_order_start <= origin.source_order_start
          AND json_extract(entry.native_metadata_json, '$.type') = 'compaction'
      ) AS follows
    `).get(modelCallID) as { follows: number };
    return row.follows === 1;
  }
}
