import type { DatabaseSync } from "node:sqlite";
import {
  type ContextEvent,
  type ModelCall,
  type SessionDetail,
  sessionDetailSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import type { UsageCall } from "./usage.ts";

type Harness = SessionSummary["harness"];

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
  calls: SessionCallImport[];
};

/** A complete, already-normalized source session ready for canonical storage. */
export type SourceSessionImport = {
  sourceID: number;
  externalID: string;
  publicID?: string;
  parentExternalID?: string;
  artifactPath?: string;
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
  s.title, s.agent, s.updated_at, s.started_at, s.ended_at,
  s.providers_json, s.models_json, s.user_turns, s.model_calls,
  s.reported_cost, s.uncached_input_tokens, s.cache_read_tokens,
  s.cache_write_tokens, s.cache_write_5m_tokens,
  s.cache_write_1h_tokens, s.fresh_prompt_tokens, s.output_tokens,
  s.reasoning_tokens, s.processed_tokens,
  COALESCE(parent.public_id, parent.external_id) AS parent_public_id
`;

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
  return {
    id: row.public_id,
    harness: row.harness,
    title: row.title,
    updatedAt: row.updated_at,
    startedAt: optional(row.started_at),
    endedAt: optional(row.ended_at),
    providers: JSON.parse(row.providers_json),
    models: JSON.parse(row.models_json),
    userTurns: row.user_turns,
    modelCalls: row.model_calls,
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
  ): SessionListResponse {
    if (
      !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) ||
      pageSize < 1
    ) {
      throw new RangeError("page and pageSize must be positive integers");
    }
    const filter = harness === undefined ? "" : " AND so.harness = ?";
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
      WHERE ss.parent_id IS NULL${hasInput}${filter}
    `).get(...parameters) as { count: number }).count,
    );
    const rows = this.db.prepare(`
      SELECT ${summaryColumns}
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN sources so ON so.id = ss.source_id
      LEFT JOIN source_sessions parent ON parent.id = ss.parent_id
      WHERE ss.parent_id IS NULL${hasInput}${filter}
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
      SELECT ${callColumns}, so.harness, ss.external_id,
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
      sessionStartedAt: row.root_started_at ?? row.root_updated_at,
      provider: row.provider,
      model: row.model,
      startedAt: row.started_at,
      tokens: tokens(row),
      reportedCost: optional(row.reported_cost),
      followsCompaction: row.follows_compaction === 1,
    }));
  }

  replaceSourceSession(value: SourceSessionImport): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#replaceSourceSession(value, null);
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

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsertIdentity = this.db.prepare(`
        INSERT INTO source_sessions (
          source_id, external_id, public_id, artifact_path, availability,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          public_id = excluded.public_id,
          artifact_path = excluded.artifact_path,
          availability = 'available',
          last_seen_at = excluded.last_seen_at
      `);
      for (const value of values) {
        upsertIdentity.run(
          value.sourceID,
          value.externalID,
          value.publicID ?? value.externalID,
          value.artifactPath ?? null,
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

      for (const value of values) {
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
          artifact_path, availability, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          public_id = excluded.public_id,
          parent_id = excluded.parent_id,
          tree_root_id = excluded.tree_root_id,
          artifact_path = excluded.artifact_path,
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

    const callIDs = new Map<string, number>();
    for (const turn of session.turns) {
      const turnID = Number(
        (this.db.prepare(`
          INSERT INTO turns (session_id, ordinal, started_at)
          VALUES (?, ?, ?) RETURNING id
        `).get(sourceSessionID, turn.number, turn.startedAt) as { id: number })
          .id,
      );
      this.#insertContent(
        "turn_inputs",
        "turn_id",
        turnID,
        turn.inputs ?? [],
      );

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
    const turns = (this.db.prepare(`
      SELECT id, ordinal, started_at FROM turns
      WHERE session_id = ? ORDER BY ordinal
    `).all(row.source_session_id) as Array<{
      id: number;
      ordinal: number;
      started_at: number;
    }>).map((turn) => {
      const calls = this.db.prepare(`
        SELECT ${callColumns}
        FROM model_calls mc
        JOIN models m ON m.id = mc.model_id
        WHERE mc.turn_id = ? ORDER BY mc.ordinal
      `).all(turn.id) as CallRow[];
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
        SELECT model_call_id, kind, preview
        FROM call_content
        WHERE model_call_id IN (${visibleCalls.map(() => "?").join(",")})
        ORDER BY model_call_id, ordinal
      `).all(...visibleCalls.map((call) => call.id)) as ContentRow[];
      const contentsByCall = Map.groupBy(
        contents,
        (content) => content.model_call_id,
      );
      return {
        number: turn.ordinal,
        startedAt: turn.started_at,
        calls: visibleCalls.map((call) => {
          const callTools = toolsByCall.get(call.id) ?? [];
          return {
            id: call.source_call_id ?? String(call.id),
            callWithinTurn: call.ordinal,
            preview: callPreview(contentsByCall.get(call.id) ?? [], callTools),
            provider: call.provider,
            model: call.model,
            startedAt: call.started_at,
            completedAt: optional(call.completed_at),
            reportedCost: optional(call.reported_cost),
            tokens: tokens(call),
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
