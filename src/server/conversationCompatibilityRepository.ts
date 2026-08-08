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
  sessionSummarySchema,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import type {
  InitialInputDistribution,
  InitialInputSample,
  ModelCallCostSummary,
  ReasoningSettingImport,
  StoredCacheMiss,
  StoredSessionShapeRollup,
} from "./sessionRepository.ts";
import {
  conciseSessionPreview,
  sessionToolTarget,
} from "./sessionRepository.ts";
import type { ToolCallObservation } from "./toolCallAnalytics.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import type {
  StoredSubagentUsage,
  StoredUsageRollup,
} from "./usageAnalytics.ts";
import type { UsageCall } from "./usage.ts";
import { compactHomePath } from "./database.ts";

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
  branch_id: number;
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
      const matchingRoots = new Set(
        this.listCacheMisses(undefined, harness).filter((miss) =>
          (missFilters.includes("compaction") &&
            miss.cause === "compaction") ||
          (missFilters.includes("ttl") && miss.cause === "ttl") ||
          (missFilters.includes("thinking-change") &&
            miss.cause === "thinking-change") ||
          (missFilters.includes("full-miss") && miss.cause === undefined &&
            miss.status === "full-miss") ||
          (missFilters.includes("partial-miss") &&
            miss.cause === undefined && miss.status === "partial-hit")
        ).map((miss) => `${miss.harness}:${miss.rootID}`),
      );
      rows = rows.filter((row) =>
        matchingRoots.has(
          `${row.harness}:${row.public_id ?? row.external_id}`,
        )
      );
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

  enrichSessionSummaries(items: SessionSummary[]): SessionSummary[] {
    if (items.length === 0) return [];
    const predicates = items.map(() =>
      "(so.harness = ? AND COALESCE(c.public_id, c.external_id) = ?)"
    ).join(" OR ");
    const rows = this.db.prepare(`
      SELECT so.harness,
        COALESCE(c.public_id, c.external_id) AS public_id,
        cr.summary_json
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE cr.summary_json IS NOT NULL AND (${predicates})
    `).all(...items.flatMap((item) => [item.harness, item.id])) as Array<{
      harness: Harness;
      public_id: string;
      summary_json: string;
    }>;
    const stored = new Map(rows.map((row) => [
      `${row.harness}:${row.public_id}`,
      sessionSummarySchema.parse(JSON.parse(row.summary_json)),
    ]));
    return items.map((item) => {
      const enrichment = stored.get(`${item.harness}:${item.id}`);
      return enrichment === undefined
        ? item
        : sessionSummarySchema.parse({ ...enrichment, ...item });
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
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(conversation_id, root_id, parent_id) AS (
        SELECT c.id, c.id, NULL
        FROM conversations c
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        UNION ALL
        SELECT launch.child_conversation_id, tree.root_id,
          launch.parent_conversation_id
        FROM conversation_subagent_launches launch
        JOIN tree ON tree.conversation_id = launch.parent_conversation_id
      ), path_calls AS (
        SELECT occurrence.model_call_id, occurrence.branch_id,
          occurrence.occurrence_kind, occurrence.source_order_start,
          LAG(occurrence.model_call_id) OVER (
            PARTITION BY occurrence.branch_id
            ORDER BY occurrence.source_order_start, call.ordinal
          ) AS previous_model_call_id,
          LAG(occurrence.source_order_end) OVER (
            PARTITION BY occurrence.branch_id
            ORDER BY occurrence.source_order_start, call.ordinal
          ) AS previous_source_order_end
        FROM artifact_model_call_occurrences occurrence
        JOIN conversation_model_calls call
          ON call.id = occurrence.model_call_id
        JOIN conversations occurrence_conversation
          ON occurrence_conversation.id = call.conversation_id
        JOIN sources occurrence_source
          ON occurrence_source.id = occurrence_conversation.source_id
        WHERE COALESCE(call.source_call_id, '')
          NOT LIKE 'context-operation:%'
          AND (? IS NULL OR occurrence_source.harness = ?)
      ), origins AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY model_call_id
          ORDER BY source_order_start, branch_id
        ) AS origin_rank
        FROM path_calls
        WHERE occurrence_kind = 'executed'
      ), compactions AS MATERIALIZED (
        SELECT entry.conversation_id, occurrence.branch_id,
          occurrence.source_order_start,
          json_extract(
            entry.native_metadata_json,
            '$.affectedCall.turn'
          ) AS affected_turn,
          json_extract(
            entry.native_metadata_json,
            '$.affectedCall.call'
          ) AS affected_call
        FROM conversation_entries entry
        LEFT JOIN artifact_entry_occurrences occurrence
          ON occurrence.entry_id = entry.id
        WHERE entry.kind = 'context-event'
          AND json_extract(entry.native_metadata_json, '$.type') = 'compaction'
      )
      SELECT call.*, turn.source_turn_id,
        turn.ordinal AS turn_ordinal,
        turn.reasoning_setting_name AS turn_reasoning_setting_name,
        turn.reasoning_setting_value AS turn_reasoning_setting_value,
        turn.reasoning_source_field_path AS turn_reasoning_source_field_path,
        turn.reasoning_source_order AS turn_reasoning_source_order,
        turn.reasoning_observed_at AS turn_reasoning_observed_at,
        turn.reasoning_provenance AS turn_reasoning_provenance,
        turn.started_at AS turn_started_at,
        origin.source_order_start, origin.previous_model_call_id,
        so.harness, c.external_id,
        COALESCE(c.public_id, c.external_id) AS public_id,
        COALESCE(root.public_id, root.external_id) AS root_public_id,
        COALESCE(parent.public_id, parent.external_id) AS parent_public_id,
        root.started_at AS root_started_at,
        root.updated_at AS root_updated_at,
        (
          EXISTS (
            SELECT 1 FROM compactions compaction
            WHERE compaction.conversation_id = call.conversation_id
              AND compaction.affected_turn = turn.ordinal
              AND compaction.affected_call = call.call_within_turn
          ) OR EXISTS (
            SELECT 1 FROM compactions compaction
            WHERE compaction.branch_id = origin.branch_id
              AND compaction.source_order_start >
                COALESCE(origin.previous_source_order_end, 0)
              AND compaction.source_order_start <= origin.source_order_start
          )
        ) AS follows_compaction
      FROM conversation_model_calls call
      JOIN conversation_turns turn ON turn.id = call.turn_id
      JOIN tree ON tree.conversation_id = call.conversation_id
      JOIN conversations c ON c.id = call.conversation_id
      JOIN conversations root ON root.id = tree.root_id
      LEFT JOIN conversations parent ON parent.id = tree.parent_id
      JOIN sources so ON so.id = c.source_id
      LEFT JOIN origins origin
        ON origin.model_call_id = call.id AND origin.origin_rank = 1
      WHERE COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
        AND (? IS NULL OR call.started_at >= ?)
        AND (? IS NULL OR so.harness = ?)
      ORDER BY call.started_at, call.id
    `).all(
      harness ?? null,
      harness ?? null,
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<
      CallRow & {
        harness: Harness;
        external_id: string;
        public_id: string;
        root_public_id: string;
        parent_public_id: string | null;
        root_started_at: number | null;
        root_updated_at: number;
        previous_model_call_id: number | null;
        follows_compaction: number;
      }
    >;
    return rows.map((row) => {
      const effectiveReasoning = reasoningSetting(row) ?? reasoningSetting({
        reasoning_setting_name: row.turn_reasoning_setting_name,
        reasoning_setting_value: row.turn_reasoning_setting_value,
        reasoning_source_field_path: row.turn_reasoning_source_field_path,
        reasoning_source_order: row.turn_reasoning_source_order,
        reasoning_observed_at: row.turn_reasoning_observed_at,
        reasoning_provenance: row.turn_reasoning_provenance,
      });
      return {
        modelCallID: row.id,
        previousModelCallID: optional(row.previous_model_call_id),
        turnRowID: row.turn_id,
        harness: row.harness,
        session: {
          id: row.public_id,
          rootID: row.root_public_id,
          parentID: optional(row.parent_public_id),
        },
        cacheChainID: row.external_id,
        turnID: `${row.public_id}:${row.turn_ordinal}`,
        turnOrdinal: row.turn_ordinal,
        images: optional(row.images),
        sessionStartedAt: row.root_started_at ?? row.root_updated_at,
        provider: row.provider,
        model: row.model,
        startedAt: row.started_at,
        ...(effectiveReasoning === undefined
          ? {}
          : { reasoningSetting: effectiveReasoning }),
        tokens: tokens(row),
        reportedCost: optional(row.reported_cost),
        computedCost: optional(row.computed_cost),
        followsCompaction: row.follows_compaction === 1,
      };
    });
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
    type CostRow = {
      total_cost: number | null;
      total_unpriced: number;
      root_cost: number | null;
      root_unpriced: number;
      harness: Harness;
      root_public_id: string;
      root_started_at: number | null;
      root_updated_at: number;
    };
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(conversation_id, root_id) AS (
        SELECT c.id, c.id FROM conversations c
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        UNION ALL
        SELECT launch.child_conversation_id, tree.root_id
        FROM conversation_subagent_launches launch
        JOIN tree ON tree.conversation_id = launch.parent_conversation_id
      ), scoped AS (
        SELECT call.conversation_id, tree.root_id, so.harness,
          COALESCE(root.public_id, root.external_id) AS root_public_id,
          root.started_at AS root_started_at,
          root.updated_at AS root_updated_at,
          COALESCE(call.computed_cost, call.reported_cost) AS cost
        FROM conversation_model_calls call
        JOIN tree ON tree.conversation_id = call.conversation_id
        JOIN conversations c ON c.id = call.conversation_id
        JOIN sources so ON so.id = c.source_id
        JOIN conversations root ON root.id = tree.root_id
        WHERE call.started_at >= ?
          AND COALESCE(call.source_call_id, '')
            NOT LIKE 'context-operation:%'
          AND (? IS NULL OR so.harness = ?)
      )
      SELECT harness, root_public_id, root_started_at, root_updated_at,
        SUM(cost) AS total_cost,
        MAX(cost IS NULL) AS total_unpriced,
        SUM(CASE WHEN conversation_id = root_id THEN cost ELSE 0 END)
          AS root_cost,
        MAX(CASE WHEN conversation_id = root_id AND cost IS NULL
          THEN 1 ELSE 0 END) AS root_unpriced
      FROM scoped
      GROUP BY harness, root_id, root_public_id,
        root_started_at, root_updated_at
      ORDER BY root_public_id
    `).all(startedAt, harness ?? null, harness ?? null) as CostRow[];
    const sessionRows = rows.filter((row) =>
      (row.root_started_at ?? row.root_updated_at) >= startedAt
    );
    return {
      totalCost: rows.reduce((sum, row) => sum + (row.total_cost ?? 0), 0),
      hasUnpricedTotalCost: rows.some((row) => row.total_unpriced === 1),
      totalSessionCost: sessionRows.reduce(
        (sum, row) => sum + (row.root_cost ?? 0),
        0,
      ),
      hasUnpricedSessionCost: sessionRows.some((row) =>
        row.root_unpriced === 1
      ),
      sessions: sessionRows.map((row) => ({
        harness: row.harness,
        rootID: row.root_public_id,
        sessionStartedAt: row.root_started_at ?? row.root_updated_at,
        rootCost: row.root_cost ?? 0,
        hasUnpricedRootCost: row.root_unpriced === 1,
      })),
    };
  }

  listCacheMisses(startedAt?: number, harness?: Harness): StoredCacheMiss[] {
    type Row = {
      model_call_id: number;
      previous_model_call_id: number | null;
      conversation_id: number;
      turn_id: number;
      started_at: number;
      gap_ms: number;
      status: StoredCacheMiss["status"];
      reason: StoredCacheMiss["reason"] | null;
      cause: StoredCacheMiss["cause"] | null;
      retained_ratio: number | null;
      previous_reusable_tokens: number | null;
      previous_context_tokens: number;
      current_context_tokens: number;
      actual_cache_read_tokens: number;
      missed_tokens: number;
      model_call_cost: number | null;
      actual_missed_cost: number | null;
      expected_read_cost: number | null;
      estimated_extra_cost: number | null;
      harness: Harness;
      session_public_id: string;
      root_public_id: string;
      root_started_at: number | null;
      root_updated_at: number;
    };
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(conversation_id, root_id) AS (
        SELECT c.id, c.id FROM conversations c
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        UNION ALL
        SELECT launch.child_conversation_id, tree.root_id
        FROM conversation_subagent_launches launch
        JOIN tree ON tree.conversation_id = launch.parent_conversation_id
      )
      SELECT miss.*, so.harness,
        COALESCE(c.public_id, c.external_id) AS session_public_id,
        COALESCE(root.public_id, root.external_id) AS root_public_id,
        root.started_at AS root_started_at, root.updated_at AS root_updated_at
      FROM conversation_cache_misses miss
      JOIN conversations c ON c.id = miss.conversation_id
      JOIN sources so ON so.id = c.source_id
      JOIN tree ON tree.conversation_id = c.id
      JOIN conversations root ON root.id = tree.root_id
      WHERE (? IS NULL OR miss.started_at >= ?)
        AND (? IS NULL OR so.harness = ?)
      ORDER BY miss.started_at, miss.model_call_id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Row[];
    return rows.map((row) => ({
      harness: row.harness,
      sessionID: row.session_public_id,
      rootID: row.root_public_id,
      sessionStartedAt: row.root_started_at ?? row.root_updated_at,
      modelCallID: row.model_call_id,
      ...(row.previous_model_call_id === null ? {} : {
        previousModelCallID: row.previous_model_call_id,
      }),
      turnID: row.turn_id,
      gap: row.gap_ms,
      status: row.status,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.cause === null ? {} : { cause: row.cause }),
      ...(row.retained_ratio === null ? {} : {
        retainedRatio: row.retained_ratio,
      }),
      ...(row.previous_reusable_tokens === null ? {} : {
        previousReusableTokens: row.previous_reusable_tokens,
      }),
      previousContextTokens: row.previous_context_tokens,
      currentContextTokens: row.current_context_tokens,
      actualCacheReadTokens: row.actual_cache_read_tokens,
      missedTokens: row.missed_tokens,
      ...(row.model_call_cost === null ? {} : {
        modelCallCost: row.model_call_cost,
      }),
      ...(row.actual_missed_cost === null ? {} : {
        actualMissedCost: row.actual_missed_cost,
      }),
      ...(row.expected_read_cost === null ? {} : {
        expectedReadCost: row.expected_read_cost,
      }),
      ...(row.estimated_extra_cost === null ? {} : {
        estimatedExtraCost: row.estimated_extra_cost,
      }),
    }));
  }

  listOverviewRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredOverviewRollup[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.title, so.harness, cr.overview_json,
        COALESCE((
          WITH RECURSIVE descendants(id) AS (
            SELECT launch.child_conversation_id
            FROM conversation_subagent_launches launch
            WHERE launch.parent_conversation_id = c.id
            UNION ALL
            SELECT launch.child_conversation_id
            FROM conversation_subagent_launches launch
            JOIN descendants parent
              ON launch.parent_conversation_id = parent.id
          )
          SELECT SUM(COALESCE(child.computed_cost, child.reported_cost, 0))
          FROM descendants
          JOIN conversation_rollups child
            ON child.conversation_id = descendants.id
        ), 0) AS subagent_spend,
        COALESCE(c.public_id, c.external_id) AS session_public_id,
        COALESCE((
          SELECT json_group_array(json_object(
            'startedAt', measured_turn.started_at,
            'executionEndAt', measured_turn.execution_end_at
          ))
          FROM (
            SELECT root_turn.started_at,
              MAX(
                root_turn.started_at,
                MAX(COALESCE(
                  root_tool.completed_at,
                  root_tool.started_at,
                  root_call.completed_at,
                  root_call.started_at
                ))
              ) AS execution_end_at
            FROM conversation_turns root_turn
            JOIN conversation_model_calls root_call
              ON root_call.turn_id = root_turn.id
            LEFT JOIN conversation_tool_events root_tool
              ON root_tool.model_call_id = root_call.id
            WHERE root_turn.conversation_id = c.id
              AND COALESCE(root_call.source_call_id, '')
                NOT LIKE 'context-operation:%'
              AND COALESCE(root_call.source_call_id, '')
                NOT LIKE 'unmeasured:%'
            GROUP BY root_turn.id
            ORDER BY root_turn.started_at, root_turn.ordinal
          ) measured_turn
        ), '[]') AS root_execution_intervals_json
      FROM conversation_rollups cr
      JOIN conversations c ON c.id = cr.conversation_id
      JOIN sources so ON so.id = c.source_id
      WHERE cr.last_activity_at >= ? AND cr.overview_json IS NOT NULL
        AND (? IS NULL OR so.harness = ?)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      ORDER BY c.id
    `).all(startedAt, harness ?? null, harness ?? null) as Array<{
      id: number;
      title: string;
      harness: Harness;
      overview_json: string;
      subagent_spend: number;
      session_public_id: string;
      root_execution_intervals_json: string;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.id,
      rootExecutionIntervals: JSON.parse(row.root_execution_intervals_json),
      sessionID: row.session_public_id,
      title: row.title,
      harness: row.harness,
      subagentSpend: row.subagent_spend,
      overview: JSON.parse(row.overview_json),
    }));
  }

  listSessionShapeRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredSessionShapeRollup[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.title, so.harness, cr.overview_json,
        (
          SELECT first_call.uncached_input_tokens +
            first_call.cache_read_tokens +
            COALESCE(first_call.cache_write_tokens, 0)
          FROM conversation_model_calls first_call
          WHERE first_call.conversation_id = c.id
            AND COALESCE(first_call.source_call_id, '')
              NOT LIKE 'context-operation:%'
          ORDER BY first_call.ordinal
          LIMIT 1
        ) AS initial_input
      FROM conversation_rollups cr
      JOIN conversations c ON c.id = cr.conversation_id
      JOIN sources so ON so.id = c.source_id
      WHERE cr.last_activity_at >= ? AND cr.overview_json IS NOT NULL
        AND (? IS NULL OR so.harness = ?)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      ORDER BY c.id
    `).all(startedAt, harness ?? null, harness ?? null) as Array<{
      id: number;
      title: string;
      harness: Harness;
      overview_json: string;
      initial_input: number | null;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.id,
      title: row.title,
      harness: row.harness,
      overview: JSON.parse(row.overview_json),
      initialInput: optional(row.initial_input),
    }));
  }

  listUsageRollups(
    startedAt?: number,
    harness?: Harness,
  ): StoredUsageRollup[] {
    const rows = this.db.prepare(`
      SELECT c.id, COALESCE(c.started_at, c.updated_at) AS session_started_at,
        cr.uncached_input_tokens + cr.cache_read_tokens +
          COALESCE(cr.cache_write_tokens, 0) AS direct_input,
        cr.subagent_uncached_input_tokens + cr.subagent_cache_read_tokens +
          COALESCE(cr.subagent_cache_write_tokens, 0) AS subagent_input,
        cr.subagent_model_calls, cr.overview_json
      FROM conversation_rollups cr
      JOIN conversations c ON c.id = cr.conversation_id
      JOIN sources so ON so.id = c.source_id
      WHERE (? IS NULL OR cr.last_activity_at >= ?)
        AND cr.overview_json IS NOT NULL
        AND (? IS NULL OR so.harness = ?)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      ORDER BY c.id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      id: number;
      session_started_at: number;
      direct_input: number;
      subagent_input: number;
      subagent_model_calls: number;
      overview_json: string;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.id,
      sessionStartedAt: row.session_started_at,
      directInput: row.direct_input,
      subagentInput: row.subagent_input,
      subagentModelCalls: row.subagent_model_calls,
      overview: JSON.parse(row.overview_json),
    }));
  }

  listSubagentUsage(
    startedAt?: number,
    harness?: Harness,
  ): StoredSubagentUsage[] {
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(conversation_id, root_id, depth) AS (
        SELECT c.id, c.id, 0
        FROM conversations c
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        UNION ALL
        SELECT launch.child_conversation_id, tree.root_id, tree.depth + 1
        FROM conversation_subagent_launches launch
        JOIN tree ON tree.conversation_id = launch.parent_conversation_id
      )
      SELECT tree.root_id, call.conversation_id AS subagent_id,
        date(call.started_at / 1000, 'unixepoch', 'localtime') AS date,
        SUM(
          call.uncached_input_tokens + call.cache_read_tokens +
          COALESCE(call.cache_write_tokens, 0)
        ) AS input,
        SUM(COALESCE(call.computed_cost, call.reported_cost)) AS cost,
        MAX(call.computed_cost IS NULL AND call.reported_cost IS NULL)
          AS has_unpriced_cost
      FROM tree
      JOIN conversation_model_calls call
        ON call.conversation_id = tree.conversation_id
      JOIN conversations root ON root.id = tree.root_id
      JOIN sources so ON so.id = root.source_id
      WHERE tree.depth > 0
        AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
        AND (? IS NULL OR call.started_at >= ?)
        AND (? IS NULL OR so.harness = ?)
      GROUP BY tree.root_id, call.conversation_id, date
      ORDER BY date, tree.root_id, call.conversation_id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      root_id: number;
      subagent_id: number;
      date: string;
      input: number;
      cost: number | null;
      has_unpriced_cost: number;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.root_id,
      subagentSessionID: row.subagent_id,
      date: row.date,
      input: row.input,
      cost: row.cost ?? 0,
      hasUnpricedCost: row.has_unpriced_cost === 1,
    }));
  }

  listInitialInputSamples(
    startedAt?: number,
    harness?: Harness,
  ): InitialInputSample[] {
    const rows = this.db.prepare(`
      SELECT so.harness,
        COALESCE(c.started_at, c.updated_at) AS session_started_at,
        first_call.uncached_input_tokens + first_call.cache_read_tokens +
          COALESCE(first_call.cache_write_tokens, 0) AS input
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_model_calls first_call ON first_call.id = (
        SELECT candidate.id
        FROM conversation_model_calls candidate
        WHERE candidate.conversation_id = c.id
          AND COALESCE(candidate.source_call_id, '')
            NOT LIKE 'context-operation:%'
        ORDER BY candidate.ordinal
        LIMIT 1
      )
      WHERE NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        AND (? IS NULL OR COALESCE(c.started_at, c.updated_at) >= ?)
        AND (? IS NULL OR so.harness = ?)
      ORDER BY session_started_at, c.id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      harness: Harness;
      session_started_at: number;
      input: number;
    }>;
    return rows.map((row) => ({
      harness: row.harness,
      sessionStartedAt: row.session_started_at,
      input: row.input,
    }));
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
    const workingDirectory = optional(row.working_directory);
    return {
      id: row.public_id ?? row.external_id,
      internalID: row.id,
      sourcePath: optional(source?.artifact_path ?? null),
      workingDirectory: workingDirectory === undefined
        ? undefined
        : compactHomePath(workingDirectory),
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
    const calls = this.#conversationCalls(row.id);
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
        tool.output_preview,
        COALESCE(direct_child.public_id, child.public_id) AS child_public_id,
        COALESCE(direct_child.external_id, child.external_id)
          AS child_external_id
      FROM conversation_tool_events tool
      LEFT JOIN conversations direct_child
        ON direct_child.id = tool.child_conversation_id
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
      WHERE entry.turn_id IN (${turnPlaceholders})
        AND entry.role = 'user'
        AND entry.producer_model_call_id IS NULL
        AND entry.producer_tool_event_id IS NULL
      ORDER BY entry.id
    `).all(...turnIDs) as Array<{
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
      a[0].turn_started_at - b[0].turn_started_at ||
      a[0].started_at - b[0].started_at ||
      a[0].branch_id - b[0].branch_id ||
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
        const textPreview = conciseSessionPreview(
          text?.content_preview ?? undefined,
        );
        const previewTool = callTools.find((tool) =>
          tool.input_preview !== null
        );
        const toolTarget = sessionToolTarget(
          previewTool?.input_preview ?? undefined,
        );
        const hydrated: ModelCall = {
          id: call.source_call_id ?? String(call.id),
          callWithinTurn: call.call_within_turn ?? 1,
          preview: textPreview ??
            (previewTool !== undefined && toolTarget !== undefined
              ? conciseSessionPreview(`${previewTool.name}: ${toolTarget}`)
              : undefined),
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

    const contextRows = this.db.prepare(`
      SELECT entry.native_metadata_json, occurrence.source_order_start,
        occurrence.branch_id
      FROM conversation_entries entry
      JOIN artifact_entry_occurrences occurrence ON occurrence.entry_id = entry.id
      JOIN conversation_branches branch ON branch.id = occurrence.branch_id
      WHERE branch.conversation_id = ?
        AND occurrence.occurrence_kind <> 'copied'
        AND entry.kind = 'context-event'
      ORDER BY occurrence.source_order_start, entry.id
    `).all(row.id) as Array<{
      native_metadata_json: string;
      source_order_start: number | null;
      branch_id: number;
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
          call.branch_id === contextRow.branch_id &&
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

  // TODO: Expose branch topology in the public detail contract instead of
  // presenting sibling continuations as a chronological activity feed.
  #conversationCalls(conversationID: number): CallRow[] {
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
        call.reasoning_provenance, occurrence.source_order_start,
        occurrence.branch_id
      FROM artifact_model_call_occurrences occurrence
      JOIN conversation_branches branch ON branch.id = occurrence.branch_id
      JOIN conversation_model_calls call ON call.id = occurrence.model_call_id
      JOIN conversation_turns turn ON turn.id = call.turn_id
      WHERE branch.conversation_id = ?
        AND occurrence.occurrence_kind <> 'copied'
        AND COALESCE(call.source_call_id, '') NOT LIKE 'context-operation:%'
      ORDER BY call.started_at, occurrence.branch_id,
        occurrence.source_order_start, call.ordinal
    `).all(conversationID) as CallRow[];
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
}
