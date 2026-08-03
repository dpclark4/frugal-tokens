import type { DatabaseSync } from "node:sqlite";
import { compactHomePath } from "./database.ts";
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
  type TurnInput,
} from "../shared/sessionSchemas.ts";
import {
  analyzeCacheMisses,
  type CacheAnalysisCall,
  type CacheMissRecord,
} from "./cacheAnalysis.ts";
import { computeModelCallCost } from "./pricing.ts";
import type { UsageCall } from "./usage.ts";
import type { ToolCallObservation } from "./toolCallAnalytics.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import type {
  StoredSubagentUsage,
  StoredUsageRollup,
} from "./usageAnalytics.ts";
import { buildSessionRollup, type SessionRollup } from "./sessionRollups.ts";

type Harness = SessionSummary["harness"];

export type StoredCacheMiss = CacheMissRecord & {
  harness: Harness;
  sessionID: string;
  rootID: string;
  sessionStartedAt: number;
  modelCallID: number;
  previousModelCallID?: number;
  turnID: number;
};

export type InitialInputSample = {
  harness: Harness;
  sessionStartedAt: number;
  input: number;
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

export type SourceSessionCheckpoint = {
  changeHint?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  checksum?: string;
  parserVersion?: string;
};

export type SessionContentImport = {
  kind: string;
  preview?: string;
  originalLength?: number;
  truncated?: boolean;
  mimeType?: string;
  contentHash?: string;
};

export type SessionToolImport =
  & Omit<
    ModelCall["activity"]["tools"][number],
    "childSessionID"
  >
  & {
    sourceID?: string;
    childExternalID?: string;
    input?: Omit<SessionContentImport, "kind" | "mimeType" | "contentHash">;
    output?: Omit<SessionContentImport, "kind" | "mimeType" | "contentHash">;
  };

export type ReasoningSettingImport = {
  settingName: string;
  settingValue: string;
  sourceFieldPath?: string;
  sourceOrder?: number;
  observedAt?: number;
  provenance: "explicit" | "inherited" | "session_fallback";
};

export type SessionCallImport =
  & Omit<
    ModelCall,
    "activity" | "contextEventsBefore"
  >
  & {
    activity: Omit<ModelCall["activity"], "tools"> & {
      tools: SessionToolImport[];
    };
    content?: SessionContentImport[];
    reasoningSetting?: ReasoningSettingImport;
  };

export type SessionContextEventImport = ContextEvent & {
  affectedCall?: {
    turn: number;
    call: number;
  };
};

export type SessionTurnImport = {
  number: number;
  startedAt: number;
  inputs?: SessionContentImport[];
  reasoningSetting?: ReasoningSettingImport;
  calls: SessionCallImport[];
};

/** A complete, already-normalized source session ready for canonical storage. */
export type SourceSessionImport = {
  sourceID: number;
  externalID: string;
  publicID?: string;
  parentExternalID?: string;
  artifactPath?: string;
  workingDirectory?: string;
  observedAt: number;
  checkpoint: {
    changeHint?: string;
    sourceSize?: number;
    sourceModifiedAt?: number;
    checksum?: string;
    parserVersion?: string;
    importedAt?: number;
  };
  session: {
    title: string;
    agent?: string;
    updatedAt: number;
    startedAt?: number;
    endedAt?: number;
    providers: string[];
    models: string[];
    userTurns: number;
    modelCalls: number;
    reportedCost?: number;
    tokens: TokenUsage;
    turns: SessionTurnImport[];
    contextEvents?: SessionContextEventImport[];
  };
};

type SummaryRow = {
  source_session_id: number;
  external_id: string;
  public_id: string;
  harness: Harness;
  artifact_path: string | null;
  working_directory: string | null;
  title: string;
  agent: string | null;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  providers_json: string;
  models_json: string;
  user_turns: number;
  model_calls: number;
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
  thinking_latest: string | null;
  thinking_values_json: string;
  thinking_classified_calls: number;
  parent_public_id: string | null;
};

type CallRow = {
  id: number;
  source_call_id: string | null;
  ordinal: number;
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
};

type ReasoningSettingRow = {
  reasoning_setting_name: string | null;
  reasoning_setting_value: string | null;
  reasoning_source_field_path: string | null;
  reasoning_source_order: number | null;
  reasoning_observed_at: number | null;
  reasoning_provenance: ReasoningSettingImport["provenance"] | null;
};

type DetailCallRow = CallRow & ReasoningSettingRow & {
  turn_id: number;
};

type ToolRow = {
  model_call_id: number;
  name: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  child_public_id: string | null;
  input_preview: string | null;
  output_preview: string | null;
};

type ContentRow = {
  model_call_id: number;
  kind: string;
  preview: string | null;
  original_length: number | null;
  truncated: number;
};

type TurnInputRow = {
  turn_id: number;
  kind: string;
  preview: string | null;
  original_length: number | null;
  truncated: number;
  mime_type: string | null;
};

type ContextEventRow = {
  event_type: string;
  source_order: number;
  occurred_at: number | null;
  affected_model_call_id: number | null;
};

const summaryColumns = `
  ss.id AS source_session_id, ss.external_id,
  COALESCE(ss.public_id, ss.external_id) AS public_id, so.harness,
  ss.artifact_path, ss.working_directory,
  s.title, s.agent, s.updated_at, s.started_at, s.ended_at,
  s.providers_json, s.models_json, s.user_turns, s.model_calls,
  s.reported_cost, s.uncached_input_tokens, s.cache_read_tokens,
  s.cache_write_tokens, s.cache_write_5m_tokens,
  s.cache_write_1h_tokens, s.fresh_prompt_tokens, s.output_tokens,
  s.reasoning_tokens, s.processed_tokens,
  (
    SELECT rse.setting_value
    FROM model_calls thinking_mc
    JOIN turns thinking_t ON thinking_t.id = thinking_mc.turn_id
    JOIN model_call_reasoning_settings thinking_mcrs
      ON thinking_mcrs.model_call_id = thinking_mc.id
    JOIN reasoning_setting_events rse
      ON rse.id = thinking_mcrs.setting_event_id
    WHERE thinking_t.session_id = s.source_session_id
      AND COALESCE(thinking_mc.source_call_id, '')
        NOT LIKE 'context-operation:%'
    ORDER BY thinking_t.ordinal DESC, thinking_mc.ordinal DESC
    LIMIT 1
  ) AS thinking_latest,
  COALESCE((
    SELECT json_group_array(thinking_value)
    FROM (
      SELECT rse.setting_value AS thinking_value
      FROM model_calls thinking_mc
      JOIN turns thinking_t ON thinking_t.id = thinking_mc.turn_id
      JOIN model_call_reasoning_settings thinking_mcrs
        ON thinking_mcrs.model_call_id = thinking_mc.id
      JOIN reasoning_setting_events rse
        ON rse.id = thinking_mcrs.setting_event_id
      WHERE thinking_t.session_id = s.source_session_id
        AND COALESCE(thinking_mc.source_call_id, '')
          NOT LIKE 'context-operation:%'
      GROUP BY rse.setting_value
      ORDER BY MIN(printf(
        '%020d:%020d', thinking_t.ordinal, thinking_mc.ordinal
      ))
      LIMIT -1
    )
  ), '[]') AS thinking_values_json,
  (
    SELECT COUNT(*)
    FROM model_calls thinking_mc
    JOIN turns thinking_t ON thinking_t.id = thinking_mc.turn_id
    JOIN model_call_reasoning_settings thinking_mcrs
      ON thinking_mcrs.model_call_id = thinking_mc.id
    WHERE thinking_t.session_id = s.source_session_id
      AND COALESCE(thinking_mc.source_call_id, '')
        NOT LIKE 'context-operation:%'
  ) AS thinking_classified_calls,
  COALESCE(parent.public_id, parent.external_id) AS parent_public_id
`;

function missFilterClause(filters: SessionMissFilter[]) {
  if (filters.length === 0) return " AND 0";
  const predicates: string[] = [];
  if (filters.includes("compaction")) {
    predicates.push("cm.cause = 'compaction'");
  }
  if (filters.includes("ttl")) predicates.push("cm.cause = 'ttl'");
  if (filters.includes("thinking-change")) {
    predicates.push("cm.cause = 'thinking-change'");
  }
  if (filters.includes("full-miss")) {
    predicates.push("cm.status = 'full-miss' AND cm.cause IS NULL");
  }
  if (filters.includes("partial-miss")) {
    predicates.push("cm.status = 'partial-hit' AND cm.cause IS NULL");
  }
  if (predicates.length === 0) return " AND 0";
  return `
    AND EXISTS (
      SELECT 1
      FROM cache_misses cm
      JOIN model_call_rollups mcr ON mcr.model_call_id = cm.model_call_id
      WHERE mcr.root_session_id = ss.id
        AND (${predicates.join(" OR ")})
    )
  `;
}

const callColumns = `
  mc.id, mc.source_call_id, mc.ordinal, m.provider, m.name AS model,
  mc.started_at, mc.completed_at, mc.reported_cost,
  mc.uncached_input_tokens, mc.cache_read_tokens, mc.cache_write_tokens,
  mc.cache_write_5m_tokens, mc.cache_write_1h_tokens,
  mc.fresh_prompt_tokens, mc.output_tokens, mc.reasoning_tokens,
  mc.processed_tokens, mc.finish_reason, mc.images, mc.has_text,
  mc.has_reasoning
`;

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function concisePreview(value?: string) {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 63).trimEnd()}…`;
}

function toolTarget(value?: string) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return concisePreview(parsed);
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
        if (typeof candidate === "string") return concisePreview(candidate);
      }
    }
  } catch {
    // Non-JSON tool inputs are useful as-is.
  }
  return concisePreview(value);
}

function callPreview(contents: ContentRow[], tools: ToolRow[]) {
  const text = contents.find((content) =>
    content.kind === "text" && content.preview !== null
  )?.preview;
  const contentPreview = concisePreview(text ?? undefined);
  if (contentPreview !== undefined) return contentPreview;
  const tool = tools.find((item) => item.input_preview !== null);
  const target = toolTarget(tool?.input_preview ?? undefined);
  return tool && target ? concisePreview(`${tool.name}: ${target}`) : undefined;
}

function reasoningSetting(row: ReasoningSettingRow) {
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

function tokens(row: SummaryRow | CallRow): TokenUsage {
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

function summary(row: SummaryRow): SessionSummary {
  const workingDirectory = optional(row.working_directory);
  return {
    id: row.public_id,
    internalID: row.source_session_id,
    sourcePath: optional(row.artifact_path),
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
      latest: optional(row.thinking_latest),
      values: JSON.parse(row.thinking_values_json),
      classifiedCalls: row.thinking_classified_calls,
    },
    reportedCost: optional(row.reported_cost),
    tokens: tokens(row),
  };
}

export class SessionRepository {
  constructor(private db: DatabaseSync) {}

  ensureSource(
    harness: Harness,
    kind: string,
    label: string,
    location: string,
  ) {
    return Number(
      (this.db.prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (harness, location) DO UPDATE SET
        kind = excluded.kind, label = excluded.label, enabled = 1
      RETURNING id
    `).get(harness, kind, label, location, Date.now()) as { id: number }).id,
    );
  }

  checkpoint(
    sourceID: number,
    externalID: string,
  ): SourceSessionCheckpoint | undefined {
    const row = this.db.prepare(`
      SELECT change_hint, source_size, source_modified_at, checksum, parser_version
      FROM source_sessions WHERE source_id = ? AND external_id = ?
    `).get(sourceID, externalID) as {
      change_hint: string | null;
      source_size: number | null;
      source_modified_at: number | null;
      checksum: string | null;
      parser_version: string | null;
    } | undefined;
    return row && {
      changeHint: optional(row.change_hint),
      sourceSize: optional(row.source_size),
      sourceModifiedAt: optional(row.source_modified_at),
      checksum: optional(row.checksum),
      parserVersion: optional(row.parser_version),
    };
  }

  recordUnchangedSourceSession(
    sourceID: number,
    externalID: string,
    artifactPath: string,
    observedAt: number,
    checkpoint?: SourceSessionCheckpoint,
  ) {
    this.db.prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, public_id, artifact_path, availability,
        change_hint, source_size, source_modified_at, checksum, parser_version,
        first_seen_at, last_seen_at, last_error
      ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        artifact_path = excluded.artifact_path,
        availability = 'available',
        change_hint = COALESCE(excluded.change_hint, source_sessions.change_hint),
        source_size = COALESCE(excluded.source_size, source_sessions.source_size),
        source_modified_at = COALESCE(
          excluded.source_modified_at, source_sessions.source_modified_at
        ),
        checksum = COALESCE(excluded.checksum, source_sessions.checksum),
        parser_version = COALESCE(
          excluded.parser_version, source_sessions.parser_version
        ),
        last_seen_at = excluded.last_seen_at,
        last_error = NULL
    `).run(
      sourceID,
      externalID,
      externalID,
      artifactPath,
      checkpoint?.changeHint ?? null,
      checkpoint?.sourceSize ?? null,
      checkpoint?.sourceModifiedAt ?? null,
      checkpoint?.checksum ?? null,
      checkpoint?.parserVersion ?? null,
      observedAt,
      observedAt,
    );
  }

  recordSourceSessionError(
    sourceID: number,
    externalID: string,
    artifactPath: string,
    observedAt: number,
    error: unknown,
  ) {
    this.db.prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, public_id, artifact_path, availability, first_seen_at,
        last_seen_at, last_error
      ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        artifact_path = excluded.artifact_path,
        availability = 'available',
        last_seen_at = excluded.last_seen_at,
        last_error = excluded.last_error
    `).run(
      sourceID,
      externalID,
      externalID,
      artifactPath,
      observedAt,
      observedAt,
      error instanceof Error ? error.message : String(error),
    );
  }

  markMissingSourceSessions(sourceID: number, observedAt: number) {
    this.db.prepare(`
      UPDATE source_sessions SET availability = 'missing'
      WHERE source_id = ? AND last_seen_at <> ?
    `).run(sourceID, observedAt);
  }

  markSourceSessionsSeen(
    sourceID: number,
    externalIDs: string[],
    observedAt: number,
  ) {
    if (externalIDs.length === 0) return;
    this.db.prepare(`
      UPDATE source_sessions SET availability = 'available', last_seen_at = ?
      WHERE source_id = ? AND external_id IN (${
      externalIDs.map(() => "?").join(", ")
    })
    `).run(observedAt, sourceID, ...externalIDs);
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
    const filter = harness === undefined ? "" : " AND so.harness = ?";
    const missFilter = missFilters === undefined
      ? ""
      : missFilterClause(missFilters);
    const hasInput = `
      AND (
        s.uncached_input_tokens > 0 OR s.cache_read_tokens > 0 OR
        COALESCE(s.cache_write_tokens, 0) > 0
      )
    `;
    const parameters = harness === undefined ? [] : [harness];
    const totalItems = Number(
      (this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      WHERE ss.parent_id IS NULL${hasInput}${filter}${missFilter}
    `).get(...parameters) as { count: number }).count,
    );
    const rows = this.db.prepare(`
      SELECT ${summaryColumns}
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      LEFT JOIN source_sessions parent ON parent.id = ss.parent_id
      WHERE ss.parent_id IS NULL${hasInput}${filter}${missFilter}
      ORDER BY s.updated_at DESC, public_id DESC, so.harness DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize) as SummaryRow[];

    return sessionListResponseSchema.parse({
      items: rows.map(summary),
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
      SELECT ${summaryColumns}
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      LEFT JOIN source_sessions parent ON parent.id = ss.parent_id
       WHERE so.harness = ? AND ss.parent_id IS NULL
         AND COALESCE(ss.public_id, ss.external_id) = ?
      ORDER BY ss.id
      LIMIT 1
    `).get(harness, id) as SummaryRow | undefined;
    if (!row) return undefined;
    return sessionDetailSchema.parse(this.#detail(row, new Set()));
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
    const harnessFilter = harness === undefined
      ? ""
      : "\n          AND so.harness = ?";
    const rows = this.db.prepare(`
      WITH scoped AS (
        SELECT mcr.session_id, mcr.root_session_id, mcr.cost,
          so.harness,
          COALESCE(root.public_id, root.external_id) AS root_public_id,
          root_session.started_at AS root_started_at,
          root_session.updated_at AS root_updated_at
        FROM model_call_rollups mcr
        JOIN source_sessions ss ON ss.id = mcr.session_id
        JOIN sources so ON so.id = ss.source_id
        JOIN source_sessions root ON root.id = mcr.root_session_id
        JOIN sessions root_session
          ON root_session.source_session_id = mcr.root_session_id
        WHERE mcr.started_at >= ?${harnessFilter}
      )
      SELECT harness, root_public_id, root_started_at, root_updated_at,
        SUM(cost) AS total_cost,
        MAX(cost IS NULL) AS total_unpriced,
        SUM(CASE WHEN session_id = root_session_id THEN cost ELSE 0 END)
          AS root_cost,
        MAX(CASE WHEN session_id = root_session_id AND cost IS NULL
          THEN 1 ELSE 0 END) AS root_unpriced
      FROM scoped
      GROUP BY harness, root_session_id, root_public_id,
        root_started_at, root_updated_at
      ORDER BY root_public_id
    `).all(
      startedAt,
      ...(harness === undefined ? [] : [harness]),
    ) as CostRow[];

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
    type CacheMissRow = {
      model_call_id: number;
      previous_model_call_id: number | null;
      session_id: number;
      turn_id: number;
      started_at: number;
      gap_ms: number;
      status: StoredCacheMiss["status"];
      reason: CacheMissRecord["reason"] | null;
      cause: CacheMissRecord["cause"] | null;
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
    const filters: string[] = [];
    const params: Array<number | string> = [];
    if (startedAt !== undefined) {
      filters.push("cm.started_at >= ?");
      params.push(startedAt);
    }
    if (harness !== undefined) {
      filters.push("so.harness = ?");
      params.push(harness);
    }
    const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
    const rows = this.db.prepare(`
      SELECT cm.model_call_id, cm.previous_model_call_id, cm.session_id,
        cm.turn_id, cm.started_at, cm.gap_ms, cm.status, cm.reason, cm.cause,
        cm.retained_ratio, cm.previous_reusable_tokens,
        cm.previous_context_tokens, cm.current_context_tokens,
        cm.actual_cache_read_tokens, cm.missed_tokens, cm.model_call_cost,
        cm.actual_missed_cost, cm.expected_read_cost,
        cm.estimated_extra_cost,
        so.harness,
        COALESCE(ss.public_id, ss.external_id) AS session_public_id,
        COALESCE(root.public_id, root.external_id) AS root_public_id,
        root_session.started_at AS root_started_at,
        root_session.updated_at AS root_updated_at
      FROM cache_misses cm
      JOIN model_call_rollups mcr ON mcr.model_call_id = cm.model_call_id
      JOIN source_sessions ss ON ss.id = cm.session_id
      JOIN sources so ON so.id = ss.source_id
      JOIN source_sessions root ON root.id = mcr.root_session_id
      JOIN sessions root_session
        ON root_session.source_session_id = mcr.root_session_id
      ${where}
      ORDER BY cm.started_at, cm.model_call_id
    `).all(...params) as CacheMissRow[];

    return rows.map((row) => ({
      harness: row.harness,
      sessionID: row.session_public_id,
      rootID: row.root_public_id,
      sessionStartedAt: row.root_started_at ?? row.root_updated_at,
      modelCallID: row.model_call_id,
      ...(row.previous_model_call_id === null
        ? {}
        : { previousModelCallID: row.previous_model_call_id }),
      turnID: row.turn_id,
      gap: row.gap_ms,
      status: row.status,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.cause === null ? {} : { cause: row.cause }),
      ...(row.retained_ratio === null
        ? {}
        : { retainedRatio: row.retained_ratio }),
      ...(row.previous_reusable_tokens === null
        ? {}
        : { previousReusableTokens: row.previous_reusable_tokens }),
      previousContextTokens: row.previous_context_tokens,
      currentContextTokens: row.current_context_tokens,
      actualCacheReadTokens: row.actual_cache_read_tokens,
      missedTokens: row.missed_tokens,
      ...(row.model_call_cost === null
        ? {}
        : { modelCallCost: row.model_call_cost }),
      ...(row.actual_missed_cost === null
        ? {}
        : { actualMissedCost: row.actual_missed_cost }),
      ...(row.expected_read_cost === null
        ? {}
        : { expectedReadCost: row.expected_read_cost }),
      ...(row.estimated_extra_cost === null
        ? {}
        : { estimatedExtraCost: row.estimated_extra_cost }),
    }));
  }

  listToolCalls(
    startedAt: number,
    endedAt: number,
    harness?: Harness,
  ): ToolCallObservation[] {
    type ToolCallRow = {
      model_call_id: number;
      name: string;
      input_preview: string | null;
      tool_started_at: number | null;
      tool_completed_at: number | null;
      model_started_at: number;
      model_completed_at: number | null;
    };
    const harnessFilter = harness === undefined ? "" : " AND so.harness = ?";
    const rows = this.db.prepare(`
      SELECT mc.id AS model_call_id, te.name, te.input_preview,
        te.started_at AS tool_started_at,
        te.completed_at AS tool_completed_at,
        mc.started_at AS model_started_at,
        mc.completed_at AS model_completed_at
      FROM tool_events te
      JOIN model_calls mc ON mc.id = te.model_call_id
      JOIN turns t ON t.id = mc.turn_id
      JOIN sessions s ON s.source_session_id = t.session_id
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      WHERE mc.started_at >= ? AND mc.started_at <= ?${harnessFilter}
      ORDER BY te.id
    `).all(
      startedAt,
      endedAt,
      ...(harness === undefined ? [] : [harness]),
    ) as ToolCallRow[];
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

  listOverviewRollups(
    startedAt: number,
    harness?: Harness,
  ): StoredOverviewRollup[] {
    const rows = this.db.prepare(`
      SELECT sr.root_session_id, sr.overview_json, s.title, so.harness
      FROM session_rollups sr
      JOIN sessions s ON s.source_session_id = sr.root_session_id
      JOIN source_sessions ss ON ss.id = sr.root_session_id
      JOIN sources so ON so.id = ss.source_id
      WHERE sr.last_activity_at >= ?
        AND (? IS NULL OR so.harness = ?)
      ORDER BY sr.root_session_id
    `).all(startedAt, harness ?? null, harness ?? null) as Array<{
      root_session_id: number;
      overview_json: string;
      title: string;
      harness: Harness;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.root_session_id,
      title: row.title,
      harness: row.harness,
      overview: JSON.parse(row.overview_json),
    }));
  }

  listUsageRollups(
    startedAt?: number,
    harness?: Harness,
  ): StoredUsageRollup[] {
    const rows = this.db.prepare(`
      SELECT sr.root_session_id,
        COALESCE(s.started_at, s.updated_at) AS session_started_at,
        s.uncached_input_tokens + s.cache_read_tokens +
          COALESCE(s.cache_write_tokens, 0) AS direct_input,
        sr.subagent_uncached_input_tokens + sr.subagent_cache_read_tokens +
          COALESCE(sr.subagent_cache_write_tokens, 0) AS subagent_input,
        sr.subagent_model_calls, sr.overview_json
      FROM session_rollups sr
      JOIN sessions s ON s.source_session_id = sr.root_session_id
      JOIN source_sessions ss ON ss.id = sr.root_session_id
      JOIN sources so ON so.id = ss.source_id
      WHERE (? IS NULL OR sr.last_activity_at >= ?)
        AND (? IS NULL OR so.harness = ?)
      ORDER BY sr.root_session_id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      root_session_id: number;
      session_started_at: number;
      direct_input: number;
      subagent_input: number;
      subagent_model_calls: number;
      overview_json: string;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.root_session_id,
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
      SELECT mcr.root_session_id, mcr.session_id AS subagent_session_id,
        date(t.started_at / 1000, 'unixepoch', 'localtime') AS date,
        SUM(
          mc.uncached_input_tokens + mc.cache_read_tokens +
          COALESCE(mc.cache_write_tokens, 0)
        ) AS input,
        SUM(mcr.cost) AS cost,
        MAX(mcr.cost IS NULL) AS has_unpriced_cost
      FROM model_call_rollups mcr
      JOIN model_calls mc ON mc.id = mcr.model_call_id
      JOIN turns t ON t.id = mc.turn_id
      JOIN session_rollups sr ON sr.root_session_id = mcr.root_session_id
      JOIN source_sessions root ON root.id = mcr.root_session_id
      JOIN sources so ON so.id = root.source_id
      WHERE mcr.session_id <> mcr.root_session_id
        AND sr.subagent_model_calls > 0
        AND (? IS NULL OR t.started_at >= ?)
        AND (? IS NULL OR so.harness = ?)
        AND NOT (
          so.harness = 'codex' AND
          COALESCE(mc.source_call_id, '') LIKE 'context-operation:%'
        )
      GROUP BY mcr.root_session_id, mcr.session_id, date
      ORDER BY date, mcr.root_session_id, mcr.session_id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as Array<{
      root_session_id: number;
      subagent_session_id: number;
      date: string;
      input: number;
      cost: number | null;
      has_unpriced_cost: number;
    }>;
    return rows.map((row) => ({
      rootSessionID: row.root_session_id,
      subagentSessionID: row.subagent_session_id,
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
    type InitialInputRow = {
      harness: Harness;
      session_started_at: number;
      input: number;
    };
    const rows = this.db.prepare(`
      SELECT so.harness,
        COALESCE(s.started_at, s.updated_at) AS session_started_at,
        mc.uncached_input_tokens + mc.cache_read_tokens +
          COALESCE(mc.cache_write_tokens, 0) AS input
      FROM source_sessions ss
      JOIN sources so ON so.id = ss.source_id
      JOIN sessions s ON s.source_session_id = ss.id
      JOIN model_calls mc ON mc.id = (
        SELECT first_mc.id
        FROM turns first_t
        JOIN model_calls first_mc ON first_mc.turn_id = first_t.id
        WHERE first_t.session_id = ss.id
          AND NOT (
            so.harness = 'codex' AND
            COALESCE(first_mc.source_call_id, '')
              LIKE 'context-operation:%'
          )
        ORDER BY first_t.ordinal, first_mc.ordinal
        LIMIT 1
      )
      WHERE ss.parent_id IS NULL
        AND (? IS NULL OR COALESCE(s.started_at, s.updated_at) >= ?)
        AND (? IS NULL OR so.harness = ?)
      ORDER BY session_started_at, ss.id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as InitialInputRow[];
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
    type DistributionRow = {
      average: number | null;
      median: number | null;
      p90: number | null;
    };
    const row = this.db.prepare(`
      WITH samples AS (
        SELECT mc.uncached_input_tokens + mc.cache_read_tokens +
          COALESCE(mc.cache_write_tokens, 0) AS input
        FROM source_sessions ss
        JOIN sources so ON so.id = ss.source_id
        JOIN sessions s ON s.source_session_id = ss.id
        JOIN model_calls mc ON mc.id = (
          SELECT first_mc.id
          FROM turns first_t
          JOIN model_calls first_mc ON first_mc.turn_id = first_t.id
          WHERE first_t.session_id = ss.id
            AND NOT (
              so.harness = 'codex' AND
              COALESCE(first_mc.source_call_id, '')
                LIKE 'context-operation:%'
            )
          ORDER BY first_t.ordinal, first_mc.ordinal
          LIMIT 1
        )
        WHERE ss.parent_id IS NULL
          AND COALESCE(s.started_at, s.updated_at) >= ?
          AND (? IS NULL OR so.harness = ?)
      ),
      ranked AS (
        SELECT input, ROW_NUMBER() OVER (ORDER BY input) - 1 AS index_value
        FROM samples
      ),
      positions AS (
        SELECT COUNT(*) AS sample_count, AVG(input) AS average,
          (COUNT(*) - 1) * 0.5 AS median_position,
          (COUNT(*) - 1) * 0.9 AS p90_position
        FROM samples
      ),
      selected AS (
        SELECT positions.*,
          MAX(CASE
            WHEN ranked.index_value = CAST(median_position AS INTEGER)
            THEN ranked.input
          END) AS median_lower,
          MAX(CASE
            WHEN ranked.index_value = CAST(median_position AS INTEGER) +
              (median_position > CAST(median_position AS INTEGER))
            THEN ranked.input
          END) AS median_upper,
          MAX(CASE
            WHEN ranked.index_value = CAST(p90_position AS INTEGER)
            THEN ranked.input
          END) AS p90_lower,
          MAX(CASE
            WHEN ranked.index_value = CAST(p90_position AS INTEGER) +
              (p90_position > CAST(p90_position AS INTEGER))
            THEN ranked.input
          END) AS p90_upper
        FROM positions
        LEFT JOIN ranked ON ranked.index_value IN (
          CAST(median_position AS INTEGER),
          CAST(median_position AS INTEGER) +
            (median_position > CAST(median_position AS INTEGER)),
          CAST(p90_position AS INTEGER),
          CAST(p90_position AS INTEGER) +
            (p90_position > CAST(p90_position AS INTEGER))
        )
      )
      SELECT average,
        median_lower + (median_upper - median_lower) *
          (median_position - CAST(median_position AS INTEGER)) AS median,
        p90_lower + (p90_upper - p90_lower) *
          (p90_position - CAST(p90_position AS INTEGER)) AS p90
      FROM selected
    `).get(startedAt, harness ?? null, harness ?? null) as DistributionRow;
    return row.average === null || row.median === null || row.p90 === null
      ? undefined
      : { average: row.average, median: row.median, p90: row.p90 };
  }

  listUsageCalls(startedAt?: number, harness?: Harness): UsageCall[] {
    type UsageRow = CallRow & {
      harness: Harness;
      external_id: string;
      public_id: string;
      root_public_id: string;
      parent_public_id: string | null;
      root_started_at: number | null;
      root_updated_at: number;
      follows_compaction: number;
      turn_ordinal: number;
      reasoning_setting_name: string | null;
      reasoning_setting_value: string | null;
      reasoning_source_field_path: string | null;
      reasoning_source_order: number | null;
      reasoning_observed_at: number | null;
      reasoning_provenance: ReasoningSettingImport["provenance"] | null;
    };
    const rows = this.db.prepare(`
      WITH RECURSIVE session_tree(id, root_id) AS (
        SELECT ss.id, ss.id
        FROM source_sessions ss
        JOIN sessions s ON s.source_session_id = ss.id
        WHERE ss.parent_id IS NULL
        UNION ALL
        SELECT child.id, session_tree.root_id
        FROM source_sessions child
        JOIN sessions child_session ON child_session.source_session_id = child.id
        JOIN session_tree ON session_tree.id = child.parent_id
      )
      SELECT ${callColumns}, t.ordinal AS turn_ordinal, so.harness, ss.external_id,
        COALESCE(rse.setting_name, trse.setting_name) AS reasoning_setting_name,
        COALESCE(rse.setting_value, trse.setting_value) AS reasoning_setting_value,
        COALESCE(rse.source_field_path, trse.source_field_path) AS reasoning_source_field_path,
        COALESCE(rse.source_order, trse.source_order) AS reasoning_source_order,
        COALESCE(rse.observed_at, trse.observed_at) AS reasoning_observed_at,
        COALESCE(mcrs.provenance, trs.provenance) AS reasoning_provenance,
        COALESCE(ss.public_id, ss.external_id) AS public_id,
        COALESCE(root.public_id, root.external_id) AS root_public_id,
        COALESCE(parent.public_id, parent.external_id) AS parent_public_id,
        root_session.started_at AS root_started_at,
        root_session.updated_at AS root_updated_at,
        EXISTS (
          SELECT 1 FROM context_events ce
          WHERE ce.affected_model_call_id = mc.id
            AND ce.event_type = 'compaction'
        ) AS follows_compaction
      FROM model_calls mc
      JOIN turns t ON t.id = mc.turn_id
      JOIN sessions s ON s.source_session_id = t.session_id
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      JOIN models m ON m.id = mc.model_id
      LEFT JOIN model_call_reasoning_settings mcrs
        ON mcrs.model_call_id = mc.id
      LEFT JOIN reasoning_setting_events rse
        ON rse.id = mcrs.setting_event_id
      LEFT JOIN turn_reasoning_settings trs ON trs.turn_id = t.id
      LEFT JOIN reasoning_setting_events trse
        ON trse.id = trs.setting_event_id
      JOIN session_tree tree ON tree.id = ss.id
      JOIN source_sessions root ON root.id = tree.root_id
      JOIN sessions root_session ON root_session.source_session_id = root.id
      LEFT JOIN source_sessions parent ON parent.id = ss.parent_id
      WHERE (? IS NULL OR mc.started_at >= ?)
        AND (? IS NULL OR so.harness = ?)
        -- TODO: Persist an operation kind instead of overloading source_call_id.
        -- It is source provenance, so it remains nullable and is redacted in
        -- demo archives.
        AND NOT (
          so.harness = 'codex' AND
          COALESCE(mc.source_call_id, '') LIKE 'context-operation:%'
        )
      ORDER BY mc.started_at, mc.id
    `).all(
      startedAt ?? null,
      startedAt ?? null,
      harness ?? null,
      harness ?? null,
    ) as UsageRow[];

    return rows.map((row) => ({
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
      ...(row.reasoning_setting_name === null ||
          row.reasoning_setting_value === null ||
          row.reasoning_provenance === null
        ? {}
        : {
          reasoningSetting: {
            settingName: row.reasoning_setting_name,
            settingValue: row.reasoning_setting_value,
            sourceFieldPath: optional(row.reasoning_source_field_path),
            sourceOrder: optional(row.reasoning_source_order),
            observedAt: optional(row.reasoning_observed_at),
            provenance: row.reasoning_provenance,
          },
        }),
      tokens: tokens(row),
      reportedCost: optional(row.reported_cost),
      followsCompaction: row.follows_compaction === 1,
    }));
  }

  replaceSourceSession(value: SourceSessionImport): void {
    const rollup = value.parentExternalID === undefined
      ? buildSessionRollup([value])
      : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#replaceSourceSession(value, null);
      if (rollup !== undefined) {
        this.#insertSessionRollup(
          this.#sourceSessionID(value.sourceID, value.externalID),
          rollup,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceSourceSessionTree(values: SourceSessionImport[]): void {
    if (values.length === 0) {
      throw new Error("A source session tree must not be empty");
    }
    const sourceID = values[0].sourceID;
    const externalIDs = new Set(values.map((value) => value.externalID));
    if (externalIDs.size !== values.length) {
      throw new Error("A source session tree must have unique external IDs");
    }
    if (values.some((value) => value.sourceID !== sourceID)) {
      throw new Error("A source session tree must belong to one source");
    }
    const roots = values.filter((value) =>
      value.parentExternalID === undefined
    );
    if (roots.length !== 1) {
      throw new Error("A source session tree must have exactly one root");
    }
    for (const value of values) {
      if (
        value.parentExternalID !== undefined &&
        !externalIDs.has(value.parentExternalID)
      ) {
        throw new Error(`Unknown tree parent: ${value.parentExternalID}`);
      }
    }

    const rollup = buildSessionRollup(values);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsertIdentity = this.db.prepare(`
        INSERT INTO source_sessions (
          source_id, external_id, public_id, artifact_path, working_directory,
          availability, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          public_id = excluded.public_id,
          artifact_path = excluded.artifact_path,
          working_directory = excluded.working_directory,
          availability = 'available',
          last_seen_at = excluded.last_seen_at
      `);
      for (const value of values) {
        upsertIdentity.run(
          value.sourceID,
          value.externalID,
          value.publicID ?? value.externalID,
          value.artifactPath ?? null,
          value.workingDirectory ?? null,
          value.observedAt,
          value.observedAt,
        );
      }

      const rootID = this.#sourceSessionID(sourceID, roots[0].externalID);
      for (const value of values) {
        const parentID = value.parentExternalID === undefined
          ? null
          : this.#sourceSessionID(sourceID, value.parentExternalID);
        this.db.prepare(`
          UPDATE source_sessions SET parent_id = ?, tree_root_id = ?
          WHERE source_id = ? AND external_id = ?
        `).run(parentID, rootID, sourceID, value.externalID);
      }

      // Root sessions must be materialized before children because derived
      // rollups reference the canonical root session row.
      const orderedValues = [
        roots[0],
        ...values.filter((value) => value !== roots[0]),
      ];
      for (const value of orderedValues) {
        this.#replaceSourceSession(value, rootID);
      }

      const currentIDs = values.map((value) =>
        this.#sourceSessionID(sourceID, value.externalID)
      );
      this.db.prepare(`
        DELETE FROM source_sessions
        WHERE tree_root_id = ? AND id NOT IN (${
        currentIDs.map(() => "?").join(",")
      })
      `).run(rootID, ...currentIDs);
      this.#insertSessionRollup(rootID, rollup);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #replaceSourceSession(
    value: SourceSessionImport,
    treeRootID: number | null,
  ): void {
    const parentID = value.parentExternalID === undefined
      ? null
      : this.#sourceSessionID(value.sourceID, value.parentExternalID);
    const sourceSessionID = Number(
      (this.db.prepare(`
        INSERT INTO source_sessions (
          source_id, external_id, public_id, parent_id, tree_root_id,
          artifact_path, working_directory, availability, first_seen_at,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          public_id = excluded.public_id,
          parent_id = excluded.parent_id,
          tree_root_id = excluded.tree_root_id,
          artifact_path = excluded.artifact_path,
          working_directory = excluded.working_directory,
          availability = 'available',
          last_seen_at = excluded.last_seen_at
        RETURNING id
      `).get(
        value.sourceID,
        value.externalID,
        value.publicID ?? value.externalID,
        parentID,
        treeRootID,
        value.artifactPath ?? null,
        value.workingDirectory ?? null,
        value.observedAt,
        value.observedAt,
      ) as { id: number }).id,
    );

    this.db.prepare("DELETE FROM sessions WHERE source_session_id = ?").run(
      sourceSessionID,
    );
    const session = value.session;
    const tokenValues = this.#tokenValues(session.tokens);
    this.db.prepare(`
        INSERT INTO sessions (
          source_session_id, title, agent, updated_at, started_at, ended_at,
          providers_json, models_json, user_turns, model_calls, reported_cost,
          uncached_input_tokens, cache_read_tokens, cache_write_tokens,
          cache_write_5m_tokens, cache_write_1h_tokens, fresh_prompt_tokens,
          output_tokens, reasoning_tokens, processed_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      sourceSessionID,
      session.title,
      session.agent ?? null,
      session.updatedAt,
      session.startedAt ?? null,
      session.endedAt ?? null,
      JSON.stringify(session.providers),
      JSON.stringify(session.models),
      session.userTurns,
      session.modelCalls,
      session.reportedCost ?? null,
      ...tokenValues,
    );

    const reasoningSettingIDs = new Map<string, number>();
    const reasoningSettingID = (setting: ReasoningSettingImport) => {
      const key = JSON.stringify([
        setting.settingName,
        setting.settingValue,
        setting.sourceFieldPath ?? null,
        setting.sourceOrder ?? null,
        setting.observedAt ?? null,
      ]);
      const existing = reasoningSettingIDs.get(key);
      if (existing !== undefined) return existing;
      const id = Number(
        (this.db.prepare(`
          INSERT INTO reasoning_setting_events (
            session_id, setting_name, setting_value, source_field_path,
            source_order, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          RETURNING id
        `).get(
          sourceSessionID,
          setting.settingName,
          setting.settingValue,
          setting.sourceFieldPath ?? null,
          setting.sourceOrder ?? null,
          setting.observedAt ?? null,
        ) as { id: number }).id,
      );
      reasoningSettingIDs.set(key, id);
      return id;
    };

    const callIDs = new Map<string, number>();
    const turnIDs = new Map<number, number>();
    const rootSessionID = treeRootID ?? sourceSessionID;
    const insertModelCallRollup = this.db.prepare(`
      INSERT INTO model_call_rollups (
        model_call_id, session_id, root_session_id, started_at, cost,
        cost_source
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const turn of session.turns) {
      const turnID = Number(
        (this.db.prepare(`
          INSERT INTO turns (session_id, ordinal, started_at)
          VALUES (?, ?, ?) RETURNING id
        `).get(sourceSessionID, turn.number, turn.startedAt) as { id: number })
          .id,
      );
      turnIDs.set(turn.number, turnID);
      this.#insertContent(
        "turn_inputs",
        "turn_id",
        turnID,
        turn.inputs ?? [],
      );
      if (turn.reasoningSetting !== undefined) {
        this.db.prepare(`
          INSERT INTO turn_reasoning_settings (
            turn_id, setting_event_id, provenance
          ) VALUES (?, ?, ?)
        `).run(
          turnID,
          reasoningSettingID(turn.reasoningSetting),
          turn.reasoningSetting.provenance,
        );
      }

      for (const call of turn.calls) {
        const modelID = this.#modelID(call.provider, call.model);
        const callID = Number(
          (this.db.prepare(`
            INSERT INTO model_calls (
              turn_id, source_call_id, ordinal, model_id, started_at,
              completed_at, reported_cost, uncached_input_tokens,
              cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
              reasoning_tokens, processed_tokens, finish_reason, images,
              has_text, has_reasoning
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).get(
            turnID,
            call.id,
            call.callWithinTurn,
            modelID,
            call.startedAt,
            call.completedAt ?? null,
            call.reportedCost ?? null,
            ...this.#tokenValues(call.tokens),
            call.activity.finishReason ?? null,
            call.activity.images ?? null,
            Number(call.activity.hasText),
            Number(call.activity.hasReasoning),
          ) as { id: number }).id,
        );
        callIDs.set(`${turn.number}:${call.callWithinTurn}`, callID);
        const computedCost = computeModelCallCost(
          call.tokens,
          call.model,
          call.startedAt,
        );
        insertModelCallRollup.run(
          callID,
          sourceSessionID,
          rootSessionID,
          call.startedAt,
          computedCost ?? call.reportedCost ?? null,
          computedCost !== undefined
            ? "computed"
            : call.reportedCost !== undefined
            ? "inferred"
            : null,
        );
        if (call.reasoningSetting !== undefined) {
          this.db.prepare(`
            INSERT INTO model_call_reasoning_settings (
              model_call_id, setting_event_id, provenance
            ) VALUES (?, ?, ?)
          `).run(
            callID,
            reasoningSettingID(call.reasoningSetting),
            call.reasoningSetting.provenance,
          );
        }
        this.#insertContent(
          "call_content",
          "model_call_id",
          callID,
          call.content ?? [],
        );
        call.activity.tools.forEach((tool, index) => {
          const childID = tool.childExternalID === undefined
            ? null
            : this.#sourceSessionID(value.sourceID, tool.childExternalID);
          this.db.prepare(`
              INSERT INTO tool_events (
                model_call_id, source_tool_id, ordinal, name, status,
                started_at, completed_at, child_source_session_id,
                input_preview, input_original_length, input_truncated,
                output_preview, output_original_length, output_truncated
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
            callID,
            tool.sourceID ?? null,
            index + 1,
            tool.name,
            tool.status,
            tool.startedAt ?? null,
            tool.completedAt ?? null,
            childID,
            tool.input?.preview ?? null,
            tool.input?.originalLength ?? null,
            Number(tool.input?.truncated ?? false),
            tool.output?.preview ?? null,
            tool.output?.originalLength ?? null,
            Number(tool.output?.truncated ?? false),
          );
        });
      }
    }

    const insertContextEvent = this.db.prepare(`
      INSERT INTO context_events (
        session_id, event_type, source_order, occurred_at,
        affected_model_call_id
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const event of session.contextEvents ?? []) {
      const affectedCallID = event.affectedCall === undefined
        ? null
        : callIDs.get(
          `${event.affectedCall.turn}:${event.affectedCall.call}`,
        );
      if (event.affectedCall !== undefined && affectedCallID === undefined) {
        throw new Error(
          `Unknown affected call: turn ${event.affectedCall.turn}, call ${event.affectedCall.call}`,
        );
      }
      insertContextEvent.run(
        sourceSessionID,
        event.type,
        event.sourceOrder,
        event.occurredAt ?? null,
        affectedCallID ?? null,
      );
    }

    const compactionCallKeys = new Set(
      (session.contextEvents ?? []).filter((event) =>
        event.type === "compaction" && event.affectedCall !== undefined
      ).map((event) =>
        `${event.affectedCall!.turn}:${event.affectedCall!.call}`
      ),
    );
    const cacheCalls: CacheAnalysisCall[] = session.turns.flatMap((turn) =>
      turn.calls.map((call) => ({
        id: `${turn.number}:${call.callWithinTurn}`,
        provider: call.provider,
        model: call.model,
        startedAt: call.startedAt,
        tokens: call.tokens,
        reasoningSetting: call.reasoningSetting ?? turn.reasoningSetting,
        followsCompaction: compactionCallKeys.has(
          `${turn.number}:${call.callWithinTurn}`,
        ),
      }))
    );
    const cacheMisses = analyzeCacheMisses(cacheCalls);
    const insertCacheMiss = this.db.prepare(`
      INSERT INTO cache_misses (
        model_call_id, previous_model_call_id, session_id, turn_id,
        started_at, gap_ms, status, reason, cause, retained_ratio,
        previous_reusable_tokens, previous_context_tokens, current_context_tokens,
        actual_cache_read_tokens, missed_tokens, model_call_cost,
        actual_missed_cost, expected_read_cost, estimated_extra_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const miss of cacheMisses) {
      const currentTurn = Number(miss.callID.split(":")[0]);
      const modelCallID = callIDs.get(miss.callID);
      const previousModelCallID = callIDs.get(miss.previousCallID);
      const turnID = turnIDs.get(currentTurn);
      if (
        modelCallID === undefined || previousModelCallID === undefined ||
        turnID === undefined
      ) {
        throw new Error(`Unknown cache miss call: ${miss.callID}`);
      }
      insertCacheMiss.run(
        modelCallID,
        previousModelCallID,
        sourceSessionID,
        turnID,
        cacheCalls.find((call) => call.id === miss.callID)!.startedAt,
        miss.gap,
        miss.status,
        miss.reason ?? null,
        miss.cause ?? null,
        miss.retainedRatio ?? null,
        miss.previousReusableTokens ?? null,
        miss.previousContextTokens,
        miss.currentContextTokens,
        miss.actualCacheReadTokens,
        miss.missedTokens,
        miss.modelCallCost ?? null,
        miss.actualMissedCost ?? null,
        miss.expectedReadCost ?? null,
        miss.estimatedExtraCost ?? null,
      );
    }

    const checkpoint = value.checkpoint;
    this.db.prepare(`
        UPDATE source_sessions SET
          change_hint = ?, source_size = ?, source_modified_at = ?, checksum = ?,
          parser_version = ?, imported_at = ?, last_error = NULL
        WHERE id = ?
      `).run(
      checkpoint.changeHint ?? null,
      checkpoint.sourceSize ?? null,
      checkpoint.sourceModifiedAt ?? null,
      checkpoint.checksum ?? null,
      checkpoint.parserVersion ?? null,
      checkpoint.importedAt ?? Date.now(),
      sourceSessionID,
    );
  }

  #detail(row: SummaryRow, visited: Set<number>): SessionDetail {
    const base = summary(row);
    if (visited.has(row.source_session_id)) {
      return {
        ...base,
        parentID: optional(row.parent_public_id),
        turns: [],
        contextEvents: [],
        subagents: [],
      };
    }
    const nextVisited = new Set(visited).add(row.source_session_id);
    const contextEventRows = this.db.prepare(`
      SELECT event_type, source_order, occurred_at, affected_model_call_id
      FROM context_events
      WHERE session_id = ?
      ORDER BY source_order
    `).all(row.source_session_id) as ContextEventRow[];
    const contextEventsByCall = Map.groupBy(
      contextEventRows.filter((event) => event.affected_model_call_id !== null),
      (event) => event.affected_model_call_id!,
    );
    const contextEvent = (event: ContextEventRow): ContextEvent => ({
      type: event.event_type,
      sourceOrder: event.source_order,
      occurredAt: optional(event.occurred_at),
    });
    const calls = this.db.prepare(`
      SELECT mc.turn_id, ${callColumns},
        rse.setting_name AS reasoning_setting_name,
        rse.setting_value AS reasoning_setting_value,
        rse.source_field_path AS reasoning_source_field_path,
        rse.source_order AS reasoning_source_order,
        rse.observed_at AS reasoning_observed_at,
        mcrs.provenance AS reasoning_provenance
      FROM model_calls mc
      JOIN turns t ON t.id = mc.turn_id
      JOIN models m ON m.id = mc.model_id
      LEFT JOIN model_call_reasoning_settings mcrs
        ON mcrs.model_call_id = mc.id
      LEFT JOIN reasoning_setting_events rse
        ON rse.id = mcrs.setting_event_id
      WHERE t.session_id = ?
      ORDER BY t.ordinal, mc.ordinal
    `).all(row.source_session_id) as DetailCallRow[];
    const visibleCalls = row.harness === "codex"
      ? calls.filter((call) =>
        !call.source_call_id?.startsWith("context-operation:")
      )
      : calls;
    const tools = visibleCalls.length === 0 ? [] : this.db.prepare(`
      SELECT te.model_call_id, te.name, te.status, te.started_at,
        te.completed_at,
        COALESCE(child.public_id, child.external_id) AS child_public_id,
        te.input_preview, te.output_preview
      FROM tool_events te
      LEFT JOIN source_sessions child ON child.id = te.child_source_session_id
      WHERE te.model_call_id IN (${visibleCalls.map(() => "?").join(",")})
      ORDER BY te.model_call_id, te.ordinal
    `).all(...visibleCalls.map((call) => call.id)) as ToolRow[];
    const toolsByCall = Map.groupBy(tools, (tool) => tool.model_call_id);
    const contents = visibleCalls.length === 0 ? [] : this.db.prepare(`
      SELECT model_call_id, kind, preview, original_length, truncated
      FROM call_content
      WHERE model_call_id IN (${visibleCalls.map(() => "?").join(",")})
      ORDER BY model_call_id, ordinal
    `).all(...visibleCalls.map((call) => call.id)) as ContentRow[];
    const contentsByCall = Map.groupBy(
      contents,
      (content) => content.model_call_id,
    );
    const callsByTurn = Map.groupBy(visibleCalls, (call) => call.turn_id);
    const turnInputRows = this.db.prepare(`
      SELECT turn_id, kind, preview, original_length, truncated, mime_type
      FROM turn_inputs
      WHERE turn_id IN (
        SELECT id FROM turns WHERE session_id = ?
      )
      ORDER BY turn_id, ordinal
    `).all(row.source_session_id) as TurnInputRow[];
    const inputsByTurn = Map.groupBy(turnInputRows, (input) => input.turn_id);
    const turns = (this.db.prepare(`
      SELECT t.id, t.ordinal, t.started_at,
        rse.setting_name AS reasoning_setting_name,
        rse.setting_value AS reasoning_setting_value,
        rse.source_field_path AS reasoning_source_field_path,
        rse.source_order AS reasoning_source_order,
        rse.observed_at AS reasoning_observed_at,
        trs.provenance AS reasoning_provenance
      FROM turns t
      LEFT JOIN turn_reasoning_settings trs ON trs.turn_id = t.id
      LEFT JOIN reasoning_setting_events rse
        ON rse.id = trs.setting_event_id
      WHERE t.session_id = ? ORDER BY t.ordinal
    `).all(row.source_session_id) as Array<
      ReasoningSettingRow & {
        id: number;
        ordinal: number;
        started_at: number;
      }
    >).map((turn) => {
      const turnCalls = callsByTurn.get(turn.id) ?? [];
      const turnInputs = inputsByTurn.get(turn.id) ?? [];
      return {
        number: turn.ordinal,
        startedAt: turn.started_at,
        inputs: turnInputs.map((input): TurnInput => ({
          kind: input.kind,
          preview: optional(input.preview),
          originalLength: optional(input.original_length),
          truncated: input.truncated === 1,
          mimeType: optional(input.mime_type),
        })),
        reasoningSetting: reasoningSetting(turn),
        calls: turnCalls.map((call) => {
          const callTools = toolsByCall.get(call.id) ?? [];
          const callContents = contentsByCall.get(call.id) ?? [];
          const response = callContents.find((content) =>
            content.kind === "text" && content.preview !== null
          );
          return {
            id: call.source_call_id ?? String(call.id),
            callWithinTurn: call.ordinal,
            preview: callPreview(callContents, callTools),
            ...(response === undefined ? {} : {
              responsePreview: response.preview!,
              responseOriginalLength: optional(response.original_length),
              responseTruncated: response.truncated === 1,
            }),
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
              tools: callTools.map((tool) => ({
                name: tool.name,
                status: tool.status,
                startedAt: optional(tool.started_at),
                completedAt: optional(tool.completed_at),
                childSessionID: optional(tool.child_public_id),
                inputPreview: optional(tool.input_preview),
                outputPreview: optional(tool.output_preview),
              })),
            },
            contextEventsBefore: (contextEventsByCall.get(call.id) ?? []).map(
              contextEvent,
            ),
          };
        }),
      };
    }).filter((turn) => turn.calls.length > 0).map((turn, index) => ({
      ...turn,
      number: index + 1,
    }));
    const children = this.db.prepare(`
      SELECT ${summaryColumns}
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      LEFT JOIN source_sessions parent ON parent.id = ss.parent_id
      WHERE ss.parent_id = ?
      ORDER BY s.updated_at, ss.id
    `).all(row.source_session_id) as SummaryRow[];

    return {
      ...base,
      parentID: optional(row.parent_public_id),
      agent: optional(row.agent),
      userTurns: turns.length,
      modelCalls: turns.reduce((total, turn) => total + turn.calls.length, 0),
      turns,
      contextEvents: contextEventRows.filter((event) =>
        event.affected_model_call_id === null
      ).map(contextEvent),
      subagents: children.map((child) => this.#detail(child, nextVisited)),
    };
  }

  #insertSessionRollup(rootSessionID: number, rollup: SessionRollup) {
    const subagentTokens = this.#tokenValues(rollup.subagentTokens);
    this.db.prepare(`
      INSERT INTO session_rollups (
        root_session_id, rollup_version, first_activity_at, last_activity_at,
        computed_cost, thinking_latest, thinking_values_json,
        thinking_classified_calls, context_latest, context_peak,
        context_peak_turn, context_peak_call, subagent_count,
        subagent_user_turns, subagent_model_calls, subagent_image_inputs,
        subagent_uncached_input_tokens, subagent_cache_read_tokens,
        subagent_cache_write_tokens, subagent_cache_write_5m_tokens,
        subagent_cache_write_1h_tokens, subagent_fresh_prompt_tokens,
        subagent_output_tokens, subagent_reasoning_tokens,
        subagent_processed_tokens, subagent_reported_cost,
        subagent_computed_cost, overview_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT (root_session_id) DO UPDATE SET
        rollup_version = excluded.rollup_version,
        first_activity_at = excluded.first_activity_at,
        last_activity_at = excluded.last_activity_at,
        computed_cost = excluded.computed_cost,
        thinking_latest = excluded.thinking_latest,
        thinking_values_json = excluded.thinking_values_json,
        thinking_classified_calls = excluded.thinking_classified_calls,
        context_latest = excluded.context_latest,
        context_peak = excluded.context_peak,
        context_peak_turn = excluded.context_peak_turn,
        context_peak_call = excluded.context_peak_call,
        subagent_count = excluded.subagent_count,
        subagent_user_turns = excluded.subagent_user_turns,
        subagent_model_calls = excluded.subagent_model_calls,
        subagent_image_inputs = excluded.subagent_image_inputs,
        subagent_uncached_input_tokens = excluded.subagent_uncached_input_tokens,
        subagent_cache_read_tokens = excluded.subagent_cache_read_tokens,
        subagent_cache_write_tokens = excluded.subagent_cache_write_tokens,
        subagent_cache_write_5m_tokens = excluded.subagent_cache_write_5m_tokens,
        subagent_cache_write_1h_tokens = excluded.subagent_cache_write_1h_tokens,
        subagent_fresh_prompt_tokens = excluded.subagent_fresh_prompt_tokens,
        subagent_output_tokens = excluded.subagent_output_tokens,
        subagent_reasoning_tokens = excluded.subagent_reasoning_tokens,
        subagent_processed_tokens = excluded.subagent_processed_tokens,
        subagent_reported_cost = excluded.subagent_reported_cost,
        subagent_computed_cost = excluded.subagent_computed_cost,
        overview_json = excluded.overview_json
    `).run(
      rootSessionID,
      rollup.version,
      rollup.firstActivityAt ?? null,
      rollup.lastActivityAt ?? null,
      rollup.computedCost ?? null,
      rollup.thinkingLatest ?? null,
      JSON.stringify(rollup.thinkingValues),
      rollup.thinkingClassifiedCalls,
      rollup.contextLatest ?? null,
      rollup.contextPeak ?? null,
      rollup.contextPeakTurn ?? null,
      rollup.contextPeakCall ?? null,
      rollup.subagentCount,
      rollup.subagentUserTurns,
      rollup.subagentModelCalls,
      rollup.subagentImageInputs,
      ...subagentTokens,
      rollup.subagentReportedCost ?? null,
      rollup.subagentComputedCost ?? null,
      JSON.stringify(rollup.overview),
    );
  }

  #sourceSessionID(sourceID: number, externalID: string): number {
    const row = this.db.prepare(`
      SELECT id FROM source_sessions WHERE source_id = ? AND external_id = ?
    `).get(sourceID, externalID) as { id: number } | undefined;
    if (!row) throw new Error(`Unknown source session: ${externalID}`);
    return Number(row.id);
  }

  #modelID(provider: string, name: string): number {
    return Number(
      (this.db.prepare(`
      INSERT INTO models (provider, name) VALUES (?, ?)
      ON CONFLICT (provider, name) DO UPDATE SET name = excluded.name
      RETURNING id
    `).get(provider, name) as { id: number }).id,
    );
  }

  #tokenValues(value: TokenUsage) {
    return [
      value.uncachedInput,
      value.cacheRead,
      value.cacheWrite ?? null,
      value.cacheWrite5m ?? null,
      value.cacheWrite1h ?? null,
      value.freshPrompt,
      value.output,
      value.reasoning,
      value.processed,
    ];
  }

  #insertContent(
    table: "turn_inputs" | "call_content",
    foreignKey: "turn_id" | "model_call_id",
    ownerID: number,
    content: SessionContentImport[],
  ) {
    const statement = this.db.prepare(`
      INSERT INTO ${table} (
        ${foreignKey}, ordinal, kind, preview, original_length, truncated,
        mime_type, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    content.forEach((item, index) =>
      statement.run(
        ownerID,
        index + 1,
        item.kind,
        item.preview ?? null,
        item.originalLength ?? null,
        Number(item.truncated ?? false),
        item.mimeType ?? null,
        item.contentHash ?? null,
      )
    );
  }
}
