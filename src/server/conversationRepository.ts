import type { DatabaseSync } from "node:sqlite";
import {
  type CacheIssue,
  type ContextEvent,
  type ModelCall,
  type SessionDetail,
  sessionDetailSchema,
  sessionListItemSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  type SessionMissFilter,
  type SessionSummary,
  sessionSummarySchema,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import type { ReasoningSettingImport } from "./conversationImportTypes.ts";
import type { CacheMissRecord } from "./cacheAnalysis.ts";

export type StoredCacheMiss = CacheMissRecord & {
  harness: Harness;
  sessionID: string;
  rootID: string;
  sessionStartedAt: number;
  modelCallID: number;
  previousModelCallID?: number;
  turnID: number;
};

export type StoredCacheMissAggregate = {
  harness: Harness;
  rootID: string;
  scope: "root" | "subagent";
  status: StoredCacheMiss["status"];
  reason?: StoredCacheMiss["reason"];
  cause?: StoredCacheMiss["cause"];
  gapBucket: "under-thirty" | "thirty-to-two" | "two-to-eight" | "eight-plus";
  misses: number;
  attributedCost: number;
  expectedReadCost: number;
  estimatedExtraCost: number;
  missedTokens: number;
  unpriced: number;
};

export type InitialInputSample = {
  harness: Harness;
  sessionStartedAt: number;
  input: number;
};

export type StoredSessionShapeRollup = StoredOverviewRollup & {
  initialInput?: number;
};

export type InitialInputDistribution = {
  average: number;
  median: number;
  p90: number;
};

export type ModelCallCostSummary = {
  totalCost: number;
  hasUnpricedTotalCost: boolean;
  totalSessionCost: number;
  hasUnpricedSessionCost: boolean;
  sessions: Array<{
    harness: Harness;
    rootID: string;
    sessionStartedAt: number;
    rootCost: number;
    hasUnpricedRootCost: boolean;
  }>;
};
import type { ToolCallObservation } from "./toolCallAnalytics.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import type {
  StoredSubagentUsage,
  StoredUsageRollup,
} from "./usageAnalytics.ts";
import type { UsageCall } from "./usage.ts";
import { compactHomePath } from "./database.ts";

type Harness = SessionSummary["harness"];

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

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
  fork_count: number;
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
  summary_json: string | null;
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
  previous_model_call_id: number | null;
  predecessor_resolved: number;
};

const effectiveConversationTitle = `
  CASE WHEN so.harness = 'opencode' THEN c.title ELSE COALESCE((
    SELECT ss.generated_title
    FROM conversation_branches title_branch
    JOIN source_sessions ss ON ss.id = title_branch.source_session_id
    WHERE title_branch.conversation_id = c.id
      AND ss.generated_title IS NOT NULL
    ORDER BY title_branch.updated_at DESC, title_branch.id DESC
    LIMIT 1
  ), c.title) END
`;

const conversationColumns = `
  c.id, c.source_id, c.external_id, c.public_id, so.harness,
  ${effectiveConversationTitle} AS title,
  c.agent, c.working_directory, c.updated_at, c.started_at, c.ended_at,
  c.providers_json, c.models_json, cr.user_turns, cr.model_calls,
  MAX(0, (SELECT COUNT(*) FROM conversation_branches branch_count
    WHERE branch_count.conversation_id = c.id) - 1) AS fork_count,
  cr.reported_cost, cr.computed_cost, cr.uncached_input_tokens,
  cr.cache_read_tokens, cr.cache_write_tokens, cr.cache_write_5m_tokens,
  cr.cache_write_1h_tokens, cr.fresh_prompt_tokens, cr.output_tokens,
  cr.reasoning_tokens, cr.processed_tokens, cr.summary_json
`;

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function conciseSessionPreview(value?: string) {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 63).trimEnd()}…`;
}

export function sessionToolTarget(value?: string) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return conciseSessionPreview(parsed);
    if (parsed && typeof parsed === "object") {
      for (
        const key of [
          "description",
          "prompt",
          "task",
          "command",
          "filePath",
          "path",
          "pattern",
          "query",
        ]
      ) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (typeof candidate === "string") {
          return conciseSessionPreview(candidate);
        }
      }
    }
  } catch {
    // Non-JSON tool inputs are useful as-is.
  }
  return conciseSessionPreview(value);
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

function missPredicates(filters: SessionMissFilter[]) {
  const predicates: string[] = [];
  if (filters.includes("compaction")) {
    predicates.push("miss.cause = 'compaction'");
  }
  if (filters.includes("ttl")) predicates.push("miss.cause = 'ttl'");
  if (filters.includes("thinking-change")) {
    predicates.push("miss.cause = 'thinking-change'");
  }
  if (filters.includes("model-change")) {
    predicates.push(
      "miss.reason = 'model-change' AND miss.cause IS NULL",
    );
  }
  if (filters.includes("full-miss")) {
    predicates.push(
      "miss.status = 'full-miss' AND miss.cause IS NULL " +
        "AND (miss.reason IS NULL OR miss.reason <> 'model-change')",
    );
  }
  if (filters.includes("partial-miss")) {
    predicates.push(
      "miss.status = 'partial-hit' AND miss.cause IS NULL " +
        "AND (miss.reason IS NULL OR miss.reason <> 'model-change')",
    );
  }
  return predicates;
}

/** Existing session/analytics contracts reconstructed from conversation tables. */
export class ConversationRepository {
  constructor(private db: DatabaseSync) {}

  listHarnesses(): Harness[] {
    return (this.db.prepare(`
      SELECT DISTINCT so.harness
      FROM sources so
      JOIN conversations c ON c.source_id = so.id
    `).all() as Array<{ harness: Harness }>)
      .map(({ harness }) => harness);
  }

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
    const totalItems = this.#rootCount(harness, missFilters);
    const rows = this.#rootRows(
      harness,
      missFilters,
      pageSize,
      (page - 1) * pageSize,
    );
    const cacheIssues = this.#storedCacheIssues(rows.map((row) => row.id));
    const items = rows.map((row) => ({
      ...this.#summary(row),
      cacheIssues: cacheIssues.get(row.id) ?? [],
    }));
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
    const candidates = items.filter((item) =>
      item.cacheSummary === undefined || item.inclusiveTokens === undefined ||
      item.compactionCount === undefined
    );
    if (candidates.length === 0) return items;
    const predicates = candidates.map(() =>
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
    `).all(...candidates.flatMap((item) => [item.harness, item.id])) as Array<{
      harness: Harness;
      public_id: string;
      summary_json: string;
    }>;
    const stored = new Map(rows.map((row) => [
      `${row.harness}:${row.public_id}`,
      sessionListItemSchema.parse(JSON.parse(row.summary_json)),
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

  summarizeCacheMisses(
    startedAt: number,
    harness?: Harness,
  ): StoredCacheMissAggregate[] {
    type Row = {
      harness: Harness;
      root_public_id: string;
      scope: StoredCacheMissAggregate["scope"];
      status: StoredCacheMissAggregate["status"];
      reason: StoredCacheMissAggregate["reason"] | null;
      cause: StoredCacheMissAggregate["cause"] | null;
      gap_bucket: StoredCacheMissAggregate["gapBucket"];
      misses: number;
      attributed_cost: number;
      expected_read_cost: number;
      estimated_extra_cost: number;
      missed_tokens: number;
      unpriced: number;
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
        SELECT so.harness,
          COALESCE(root.public_id, root.external_id) AS root_public_id,
          CASE WHEN miss.conversation_id = tree.root_id
            THEN 'root' ELSE 'subagent' END AS scope,
          miss.status, miss.reason, miss.cause,
          CASE
            WHEN miss.gap_ms < ${THIRTY_MINUTES_MS} THEN 'under-thirty'
            WHEN miss.gap_ms < ${TWO_HOURS_MS} THEN 'thirty-to-two'
            WHEN miss.gap_ms < ${EIGHT_HOURS_MS} THEN 'two-to-eight'
            ELSE 'eight-plus'
          END AS gap_bucket,
          miss.actual_missed_cost, miss.expected_read_cost,
          miss.estimated_extra_cost, miss.missed_tokens
        FROM conversation_cache_misses miss
        JOIN tree ON tree.conversation_id = miss.conversation_id
        JOIN conversations root ON root.id = tree.root_id
        JOIN sources so ON so.id = root.source_id
        WHERE miss.started_at >= ?
          AND COALESCE(root.started_at, root.updated_at) >= ?
          AND (? IS NULL OR so.harness = ?)
      )
      SELECT harness, root_public_id, scope, status, reason, cause, gap_bucket,
        COUNT(*) AS misses,
        SUM(COALESCE(actual_missed_cost, 0)) AS attributed_cost,
        SUM(COALESCE(expected_read_cost, 0)) AS expected_read_cost,
        SUM(COALESCE(estimated_extra_cost, 0)) AS estimated_extra_cost,
        SUM(missed_tokens) AS missed_tokens,
        SUM(actual_missed_cost IS NULL) AS unpriced
      FROM scoped
      GROUP BY harness, root_public_id, scope, status, reason, cause, gap_bucket
      ORDER BY harness, root_public_id, scope, status, reason, cause, gap_bucket
    `).all(
      startedAt,
      startedAt,
      harness ?? null,
      harness ?? null,
    ) as Row[];
    return rows.map((row) => ({
      harness: row.harness,
      rootID: row.root_public_id,
      scope: row.scope,
      status: row.status,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.cause === null ? {} : { cause: row.cause }),
      gapBucket: row.gap_bucket,
      misses: Number(row.misses),
      attributedCost: row.attributed_cost,
      expectedReadCost: row.expected_read_cost,
      estimatedExtraCost: row.estimated_extra_cost,
      missedTokens: Number(row.missed_tokens),
      unpriced: Number(row.unpriced),
    }));
  }

  listOverviewRollups(
    startedAt: number,
    harness?: Harness,
    options: {
      includeSubagentSpend?: boolean;
      includeRootExecutionIntervals?: boolean;
      recordTiming?: (name: string, duration: number) => void;
    } = {},
  ): StoredOverviewRollup[] {
    const {
      includeSubagentSpend = true,
      includeRootExecutionIntervals = true,
      recordTiming,
    } = options;
    const measured = <T>(name: string, operation: () => T): T => {
      const started = performance.now();
      const result = operation();
      recordTiming?.(name, performance.now() - started);
      return result;
    };
    const parameters = [startedAt, harness ?? null, harness ?? null] as const;
    const rows = measured("root-rollups", () =>
      this.db.prepare(`
        SELECT c.id, ${effectiveConversationTitle} AS title, so.harness,
          c.started_at, c.ended_at, cr.overview_json,
          COALESCE(c.public_id, c.external_id) AS session_public_id
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
      `).all(...parameters) as Array<{
        id: number;
        title: string;
        harness: Harness;
        started_at: number | null;
        ended_at: number | null;
        overview_json: string;
        session_public_id: string;
      }>);
    const spendRows = includeSubagentSpend
      ? measured("descendant-spend", () =>
        this.db.prepare(`
        SELECT c.id, COALESCE((
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
        ), 0) AS subagent_spend
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
        `).all(...parameters) as Array<{
          id: number;
          subagent_spend: number;
        }>)
      : [];
    const intervalRows = includeRootExecutionIntervals
      ? measured(
        "root-execution-intervals",
        () =>
          this.db.prepare(`
          WITH selected_roots(id) AS MATERIALIZED (
            SELECT c.id
            FROM conversation_rollups cr
            JOIN conversations c ON c.id = cr.conversation_id
            JOIN sources so ON so.id = c.source_id
            WHERE cr.last_activity_at >= ? AND cr.overview_json IS NOT NULL
              AND (? IS NULL OR so.harness = ?)
              AND NOT EXISTS (
                SELECT 1 FROM conversation_subagent_launches launch
                WHERE launch.child_conversation_id = c.id
              )
          )
          SELECT measured_turn.root_id AS id,
            json_group_array(json_object(
              'startedAt', measured_turn.started_at,
              'executionEndAt', measured_turn.execution_end_at
            )) AS root_execution_intervals_json
          FROM (
            SELECT root_turn.conversation_id AS root_id,
              root_turn.id AS turn_id, root_turn.started_at, root_turn.ordinal,
              MAX(
                root_turn.started_at,
                MAX(COALESCE(
                  root_tool.completed_at,
                  root_tool.started_at,
                  root_call.completed_at,
                  root_call.started_at
                ))
              ) AS execution_end_at
            FROM selected_roots root
            CROSS JOIN conversation_turns root_turn
              ON root_turn.conversation_id = root.id
            CROSS JOIN conversation_model_calls root_call
              ON root_call.turn_id = root_turn.id
            LEFT JOIN conversation_tool_events root_tool
              ON root_tool.model_call_id = root_call.id
            WHERE COALESCE(root_call.source_call_id, '')
                NOT LIKE 'context-operation:%'
              AND COALESCE(root_call.source_call_id, '')
                NOT LIKE 'unmeasured:%'
            GROUP BY root_turn.conversation_id, root_turn.id
            ORDER BY root_turn.conversation_id, root_turn.started_at,
              root_turn.ordinal
          ) measured_turn
          GROUP BY measured_turn.root_id
          ORDER BY measured_turn.root_id
          `).all(...parameters) as Array<{
            id: number;
            root_execution_intervals_json: string;
          }>,
      )
      : [];
    return measured("hydrate-rollups", () => {
      const spendByRoot = new Map(
        spendRows.map((row) => [row.id, row.subagent_spend]),
      );
      const intervalsByRoot = new Map(
        intervalRows.map((row) => [
          row.id,
          row.root_execution_intervals_json,
        ]),
      );
      return rows.map((row) => ({
        rootSessionID: row.id,
        ...(includeRootExecutionIntervals
          ? {
            rootExecutionIntervals: JSON.parse(
              intervalsByRoot.get(row.id) ?? "[]",
            ),
          }
          : {}),
        sessionID: row.session_public_id,
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        title: row.title,
        harness: row.harness,
        ...(includeSubagentSpend
          ? { subagentSpend: spendByRoot.get(row.id) ?? 0 }
          : {}),
        overview: JSON.parse(row.overview_json),
      }));
    });
  }

  listSessionShapeRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredSessionShapeRollup[] {
    const rows = this.db.prepare(`
      SELECT c.id, ${effectiveConversationTitle} AS title, so.harness,
        cr.overview_json,
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

  #rootFilter(missFilters?: SessionMissFilter[]) {
    const predicates = missFilters === undefined
      ? []
      : missPredicates(missFilters);
    return {
      cte: predicates.length === 0 ? "" : `
        WITH RECURSIVE tree(conversation_id, root_id) AS (
          SELECT root.id, root.id FROM conversations root
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_subagent_launches root_launch
            WHERE root_launch.child_conversation_id = root.id
          )
          UNION ALL
          SELECT launch.child_conversation_id, tree.root_id
          FROM conversation_subagent_launches launch
          JOIN tree ON tree.conversation_id = launch.parent_conversation_id
        ), matching_roots AS (
          SELECT DISTINCT tree.root_id
          FROM tree
          JOIN conversation_cache_misses miss
            ON miss.conversation_id = tree.conversation_id
          WHERE ${predicates.map((predicate) => `(${predicate})`).join(" OR ")}
        )
      `,
      clause: missFilters === undefined
        ? ""
        : predicates.length === 0
        ? " AND 0"
        : " AND c.id IN (SELECT root_id FROM matching_roots)",
    };
  }

  #rootCount(harness?: Harness, missFilters?: SessionMissFilter[]) {
    const filter = this.#rootFilter(missFilters);
    const row = this.db.prepare(`
      ${filter.cte}
      SELECT COUNT(*) AS count
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE (? IS NULL OR so.harness = ?)${filter.clause}
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        AND (
          cr.uncached_input_tokens > 0 OR cr.cache_read_tokens > 0 OR
          COALESCE(cr.cache_write_tokens, 0) > 0
        )
    `).get(harness ?? null, harness ?? null) as { count: number };
    return Number(row.count);
  }

  #rootRows(
    harness: Harness | undefined,
    missFilters: SessionMissFilter[] | undefined,
    limit: number,
    offset: number,
  ): ConversationRow[] {
    const filter = this.#rootFilter(missFilters);
    return this.db.prepare(`
      ${filter.cte}
      SELECT ${conversationColumns}
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE (? IS NULL OR so.harness = ?)${filter.clause}
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
        AND (
          cr.uncached_input_tokens > 0 OR cr.cache_read_tokens > 0 OR
          COALESCE(cr.cache_write_tokens, 0) > 0
        )
      ORDER BY c.updated_at DESC, COALESCE(c.public_id, c.external_id) DESC,
        so.harness DESC
      LIMIT ? OFFSET ?
    `).all(
      harness ?? null,
      harness ?? null,
      limit,
      offset,
    ) as ConversationRow[];
  }

  #storedCacheIssues(rootIDs: number[]): Map<number, CacheIssue[]> {
    if (rootIDs.length === 0) return new Map();
    const placeholders = rootIDs.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(conversation_id, root_id, nested) AS (
        SELECT c.id, c.id, 0 FROM conversations c
        WHERE c.id IN (${placeholders})
        UNION ALL
        SELECT launch.child_conversation_id, tree.root_id, 1
        FROM conversation_subagent_launches launch
        JOIN tree ON tree.conversation_id = launch.parent_conversation_id
      )
      SELECT tree.root_id, tree.nested, miss.status, miss.cause, miss.reason,
        turn.ordinal AS turn_ordinal, c.title, c.agent
      FROM tree
      JOIN conversation_cache_misses miss
        ON miss.conversation_id = tree.conversation_id
      JOIN conversation_turns turn ON turn.id = miss.turn_id
      JOIN conversations c ON c.id = tree.conversation_id
      WHERE miss.cause IS NULL OR miss.cause <> 'compaction'
      ORDER BY tree.root_id, tree.nested, miss.started_at, miss.model_call_id
    `).all(...rootIDs) as Array<{
      root_id: number;
      nested: number;
      status: CacheIssue["status"];
      cause: CacheIssue["cause"] | null;
      reason: CacheIssue["reason"] | null;
      turn_ordinal: number;
      title: string;
      agent: string | null;
    }>;
    const issues = new Map<number, CacheIssue[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      const scope = row.nested === 0
        ? undefined
        : row.agent === null
        ? row.title
        : `${row.agent}: ${row.title}`;
      const issue: CacheIssue = {
        status: row.status,
        ...(row.cause === null ? {} : { cause: row.cause }),
        ...(row.cause === null && row.reason !== null
          ? { reason: row.reason }
          : {}),
        turn: row.turn_ordinal,
        ...(scope === undefined ? {} : { scope }),
      };
      const key = `${row.root_id}:${JSON.stringify(issue)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rootIssues = issues.get(row.root_id) ?? [];
      rootIssues.push(issue);
      issues.set(row.root_id, rootIssues);
    }
    return issues;
  }

  #storedThinking(row: ConversationRow) {
    return row.summary_json === null
      ? undefined
      : sessionListItemSchema.parse(JSON.parse(row.summary_json)).thinking;
  }

  #baseSummary(
    row: ConversationRow,
    thinking: SessionSummary["thinking"],
  ): SessionSummary {
    const workingDirectory = optional(row.working_directory);
    return {
      id: row.public_id ?? row.external_id,
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
      ...(row.fork_count > 0 ? { forkCount: row.fork_count } : {}),
      thinking: thinking ?? {
        latest: undefined,
        values: [],
        classifiedCalls: 0,
      },
      reportedCost: optional(row.reported_cost),
      tokens: tokens(row),
    };
  }

  #summary(row: ConversationRow): SessionSummary {
    if (row.summary_json === null) {
      return this.#baseSummary(row, undefined);
    }
    const stored = sessionListItemSchema.parse(JSON.parse(row.summary_json));
    const base = this.#baseSummary(row, stored.thinking);
    return sessionSummarySchema.parse({ ...stored, ...base });
  }

  #sourcePath(conversationID: number) {
    const row = this.db.prepare(`
      SELECT ss.artifact_path
      FROM conversation_branches branch
      JOIN source_sessions ss ON ss.id = branch.source_session_id
      WHERE branch.conversation_id = ?
      ORDER BY branch.updated_at DESC, branch.id DESC LIMIT 1
    `).get(conversationID) as { artifact_path: string | null } | undefined;
    return optional(row?.artifact_path ?? null);
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
    const publicCallIDs = new Map(calls.map((call) => [
      call.id,
      call.source_call_id ?? String(call.id),
    ]));
    const branchRows = this.#conversationBranches(row.id);
    const publicBranchIDs = new Map(
      branchRows.map((branch) => [branch.id, branch.external_id]),
    );
    const branchNumbers = new Map(
      branchRows.slice(1).map((branch, index) => [branch.id, index + 1]),
    );
    const hydratedByCallID = new Map<number, ModelCall>();
    const turnOrder = [...groupedCalls.entries()].sort(([, a], [, b]) =>
      a[0].turn_started_at - b[0].turn_started_at ||
      a[0].started_at - b[0].started_at ||
      a[0].branch_id - b[0].branch_id ||
      (a[0].source_order_start ?? a[0].turn_ordinal) -
        (b[0].source_order_start ?? b[0].turn_ordinal)
    );
    const turnNumbersByID = new Map(
      turnOrder.map(([turnID], turnIndex) => [turnID, turnIndex + 1]),
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
          ...(call.previous_model_call_id === null ? {} : {
            previousCallID: publicCallIDs.get(call.previous_model_call_id),
          }),
          predecessorResolved: Boolean(call.predecessor_resolved),
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
        ...(branchNumbers.has(first.branch_id)
          ? { branchNumber: branchNumbers.get(first.branch_id)! }
          : {}),
        ...(publicBranchIDs.has(first.branch_id)
          ? { branchID: publicBranchIDs.get(first.branch_id)! }
          : {}),
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
    const summary = this.#baseSummary(row, this.#storedThinking(row));
    const branches = branchRows.map((branch, index) => {
      const branchTurns = turns.filter((turn) =>
        turn.branchID === branch.external_id
      );
      const firstText = branchTurns.flatMap((turn) => turn.inputs ?? [])
        .find((input) => input.kind === "text" && input.preview)?.preview;
      return {
        id: branch.external_id,
        ...(branch.parent_external_id === null
          ? {}
          : { parentID: branch.parent_external_id }),
        ...(branch.fork_turn_id === null
          ? {}
          : { forkedFromTurn: turnNumbersByID.get(branch.fork_turn_id) }),
        turnNumbers: branchTurns.map((turn) => turn.number),
        label: index === 0
          ? "Original path"
          : conciseSessionPreview(firstText) ?? `Path ${index + 1}`,
        updatedAt: branch.updated_at,
      };
    });
    return {
      ...summary,
      sourcePath: this.#sourcePath(row.id),
      agent: optional(row.agent),
      parentID: this.#parentPublicID(row.id),
      userTurns: turns.length,
      modelCalls: turns.reduce((sum, turn) => sum + turn.calls.length, 0),
      turns,
      ...(branches.length > 1 ? { branches } : {}),
      contextEvents: sessionContextEvents,
      subagents: children.map((child) => this.#detail(child, nextVisited)),
    };
  }

  #conversationBranches(conversationID: number) {
    return this.db.prepare(`
      SELECT branch.id, branch.external_id, branch.updated_at,
        parent.external_id AS parent_external_id,
        fork_entry.turn_id AS fork_turn_id
      FROM conversation_branches branch
      JOIN conversations conversation ON conversation.id = branch.conversation_id
      LEFT JOIN conversation_branches parent
        ON parent.id = branch.forked_from_branch_id
      LEFT JOIN conversation_entries fork_entry
        ON fork_entry.id = branch.fork_point_entry_id
      WHERE branch.conversation_id = ?
      ORDER BY CASE
        WHEN branch.external_id = conversation.external_id THEN 0
        WHEN branch.forked_from_branch_id IS NULL THEN 1
        ELSE 2
      END, branch.external_id
    `).all(conversationID) as Array<{
      id: number;
      external_id: string;
      updated_at: number;
      parent_external_id: string | null;
      fork_turn_id: number | null;
    }>;
  }

  // The transcript remains chronological by default; branch topology lets the
  // client focus one conversational path without duplicating stored usage.
  #conversationCalls(conversationID: number): CallRow[] {
    return this.db.prepare(`
      WITH ordered_path_calls AS (
        SELECT occurrence.*,
          branch.forked_from_branch_id,
          LAG(occurrence.model_call_id) OVER (
            PARTITION BY occurrence.branch_id
            ORDER BY occurrence.source_order_start, call.ordinal
          ) AS local_previous_model_call_id
        FROM artifact_model_call_occurrences occurrence
        JOIN conversation_branches branch ON branch.id = occurrence.branch_id
        JOIN conversation_model_calls call
          ON call.id = occurrence.model_call_id
        WHERE branch.conversation_id = ?
          AND COALESCE(call.source_call_id, '')
            NOT LIKE 'context-operation:%'
      ), path_calls AS (
        SELECT occurrence.*,
          COALESCE(
            occurrence.local_previous_model_call_id,
            (
              SELECT parent_occurrence.model_call_id
              FROM artifact_model_call_occurrences parent_occurrence
              JOIN conversation_model_calls parent_call
                ON parent_call.id = parent_occurrence.model_call_id
              WHERE parent_occurrence.branch_id =
                  occurrence.forked_from_branch_id
                AND parent_call.started_at <= current_call.started_at
                AND COALESCE(parent_call.source_call_id, '')
                  NOT LIKE 'context-operation:%'
              ORDER BY parent_call.started_at DESC,
                parent_occurrence.source_order_start DESC,
                parent_call.ordinal DESC
              LIMIT 1
            )
          ) AS previous_model_call_id
        FROM ordered_path_calls occurrence
        JOIN conversation_model_calls current_call
          ON current_call.id = occurrence.model_call_id
      )
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
        occurrence.branch_id,
        CASE WHEN occurrence.occurrence_kind = 'executed'
          THEN occurrence.previous_model_call_id ELSE NULL
        END AS previous_model_call_id,
        occurrence.occurrence_kind = 'executed' AS predecessor_resolved
      FROM path_calls occurrence
      JOIN conversation_model_calls call ON call.id = occurrence.model_call_id
      JOIN conversation_turns turn ON turn.id = call.turn_id
      WHERE occurrence.occurrence_kind <> 'copied'
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
