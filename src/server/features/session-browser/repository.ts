import type { DatabaseSync } from "node:sqlite";
import {
  type CacheIssue,
  sessionListItemSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  type SessionMissFilter,
  type SessionSortDirection,
  type SessionSortKey,
  type SessionSummary,
  sessionSummarySchema,
} from "../../../shared/sessionSchemas.ts";
import {
  baseSummary,
  conversationColumns,
  type ConversationRow,
} from "../../conversationRows.ts";

import {
  isHerdrProjectDirectory,
  sessionDirectoryGroup,
  type SessionDirectoryOption,
  type SessionModelOption,
} from "../../../shared/sessionBrowserSchemas.ts";

type Harness = SessionSummary["harness"];

const sessionTree = `
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
  )
`;

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

export class SessionBrowserRepository {
  constructor(private db: DatabaseSync) {}

  listDirectories(harness?: Harness): SessionDirectoryOption[] {
    // Directory attribution uses the root's recorded working directory, not its descendants'.
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const rows = this.db.prepare(`
      SELECT NULLIF(c.working_directory, '') AS path, COUNT(*) AS sessionCount
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      WHERE (? IS NULL OR so.harness = ?)
        AND (cr.uncached_input_tokens > 0 OR cr.cache_read_tokens > 0 OR
          COALESCE(cr.cache_write_tokens, 0) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches launch
          WHERE launch.child_conversation_id = c.id
        )
      GROUP BY NULLIF(c.working_directory, '')
      ORDER BY sessionCount DESC, path COLLATE NOCASE, path
    `).all(harness ?? null, harness ?? null) as SessionDirectoryOption[];
    const grouped = new Map<string | null, number>();
    for (const { path, sessionCount } of rows) {
      // Herdr's random worktree names are separate checkouts of the same project.
      // Preserve the prefix so projects under different Herdr homes stay distinct.
      const directory = sessionDirectoryGroup(path);
      grouped.set(directory, (grouped.get(directory) ?? 0) + sessionCount);
    }
    return [...grouped].map(([path, sessionCount]) => ({ path, sessionCount }))
      .sort((a, b) => {
        if (a.sessionCount !== b.sessionCount) {
          return b.sessionCount - a.sessionCount;
        }
        const left = a.path ?? "";
        const right = b.path ?? "";
        const foldedLeft = left.toLowerCase();
        const foldedRight = right.toLowerCase();
        if (foldedLeft !== foldedRight) {
          return foldedLeft < foldedRight ? -1 : 1;
        }
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }

  listModels(harness?: Harness): SessionModelOption[] {
    // Count each eligible root session once per model, including descendant calls.
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const rows = this.db.prepare(`
      ${sessionTree}
      SELECT call.model AS id, COUNT(DISTINCT c.id) AS sessionCount
      FROM conversations c
      JOIN sources so ON so.id = c.source_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
      JOIN tree ON tree.root_id = c.id
      JOIN conversation_model_calls call ON call.conversation_id = tree.conversation_id
      WHERE (? IS NULL OR so.harness = ?)
        AND (cr.uncached_input_tokens > 0 OR cr.cache_read_tokens > 0 OR
          COALESCE(cr.cache_write_tokens, 0) > 0)
        AND call.model <> ''
      GROUP BY call.model
      ORDER BY sessionCount DESC, call.model COLLATE NOCASE, call.model
    `).all(harness ?? null, harness ?? null) as SessionModelOption[];
    return rows.map(({ id, sessionCount }) => ({ id, sessionCount }));
  }

  listSessions(
    page: number,
    pageSize: number,
    harness?: Harness,
    missFilters?: SessionMissFilter[],
    sort?: { key: SessionSortKey; direction: SessionSortDirection },
    models: string[] = [],
    directories: Array<string | null> = [],
  ): SessionListResponse {
    if (
      !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) ||
      pageSize < 1
    ) {
      throw new RangeError("page and pageSize must be positive integers");
    }
    const totalItems = this.#rootCount(
      harness,
      missFilters,
      models,
      directories,
    );
    const rows = this.#rootRows(
      harness,
      missFilters,
      pageSize,
      (page - 1) * pageSize,
      sort,
      models,
      directories,
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

  #rootFilter(
    missFilters: SessionMissFilter[] | undefined,
    models: string[],
    directories: Array<string | null>,
  ) {
    const predicates = missFilters === undefined
      ? []
      : missPredicates(missFilters);
    const missClause = missFilters === undefined
      ? ""
      : predicates.length === 0
      ? " AND 0"
      : ` AND EXISTS (
          SELECT 1 FROM tree
          JOIN conversation_cache_misses miss ON miss.conversation_id = tree.conversation_id
          WHERE tree.root_id = c.id
            AND (${
        predicates.map((predicate) => `(${predicate})`).join(" OR ")
      })
        )`;
    const modelClause = models.length === 0 ? "" : ` AND EXISTS (
      SELECT 1 FROM tree
      JOIN conversation_model_calls call ON call.conversation_id = tree.conversation_id
      WHERE tree.root_id = c.id AND call.model IN (${
      models.map(() => "?").join(", ")
    })
    )`;
    const directoryParams: Array<string | null> = [];
    const directoryPredicates = directories.map((path) => {
      directoryParams.push(path);
      if (path !== null && isHerdrProjectDirectory(path)) {
        // Literal, case-sensitive prefix matching: '%' and '_' in paths are not wildcards.
        directoryParams.push(`${path}/`);
        return "(c.working_directory = ? OR instr(c.working_directory, ?) = 1)";
      }
      return "NULLIF(c.working_directory, '') IS ?";
    });
    const directoryClause = directoryPredicates.length
      ? ` AND (${directoryPredicates.join(" OR ")})`
      : "";
    return {
      cte: predicates.length > 0 || models.length > 0 ? sessionTree : "",
      clause: missClause + modelClause + directoryClause,
      params: [...models, ...directoryParams],
    };
  }

  #rootCount(
    harness: Harness | undefined,
    missFilters: SessionMissFilter[] | undefined,
    models: string[],
    directories: Array<string | null>,
  ) {
    const filter = this.#rootFilter(missFilters, models, directories);
    // SAFETY: The static SQL projection and migrated schema define this row contract.
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
    `).get(harness ?? null, harness ?? null, ...filter.params) as {
      count: number;
    };
    return Number(row.count);
  }

  #sortClause(sort?: { key: SessionSortKey; direction: SessionSortDirection }) {
    if (!sort) {
      return "ORDER BY c.updated_at DESC, COALESCE(c.public_id, c.external_id) DESC, so.harness DESC";
    }
    const direction = sort.direction === "asc" ? "ASC" : "DESC"; // allowlisted, not interpolated raw
    const keys = {
      timestamp: `c.updated_at ${direction}`,
      activity:
        `COALESCE(json_extract(cr.summary_json, '$.inclusiveUserTurns'), cr.user_turns) ${direction}`,
      input: `COALESCE(
        json_extract(cr.summary_json, '$.inclusiveTokens.uncachedInput')
          + json_extract(cr.summary_json, '$.inclusiveTokens.cacheRead')
          + COALESCE(json_extract(cr.summary_json, '$.inclusiveTokens.cacheWrite'), 0),
        cr.uncached_input_tokens + cr.cache_read_tokens + COALESCE(cr.cache_write_tokens, 0)
      ) ${direction}`,
      output:
        `COALESCE(json_extract(cr.summary_json, '$.inclusiveTokens.output'), cr.output_tokens) ${direction}`,
      cost: `COALESCE(
        json_extract(cr.summary_json, '$.inclusiveComputedCost'),
        json_extract(cr.summary_json, '$.computedCost'),
        json_extract(cr.summary_json, '$.inclusiveReportedCost'),
        cr.reported_cost
      ) ${direction}`,
      // Matches what the UI actually shows (session.cacheIssues.length in
      // RecentSessionsTable.tsx), rather than re-deriving a separate
      // full-misses/partial-misses heuristic that can disagree with it.
      cacheMisses:
        `COALESCE(json_array_length(cr.summary_json, '$.cacheIssues'), 0) ${direction}`,
    } satisfies Record<SessionSortKey, string>;
    return `ORDER BY ${
      keys[sort.key]
    }, c.updated_at DESC, COALESCE(c.public_id, c.external_id) DESC, so.harness DESC`;
  }

  #rootRows(
    harness: Harness | undefined,
    missFilters: SessionMissFilter[] | undefined,
    limit: number,
    offset: number,
    sort: { key: SessionSortKey; direction: SessionSortDirection } | undefined,
    models: string[],
    directories: Array<string | null>,
  ): ConversationRow[] {
    const filter = this.#rootFilter(missFilters, models, directories);
    // SAFETY: The static SQL projection and migrated schema define this row contract.
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
      ${this.#sortClause(sort)}
      LIMIT ? OFFSET ?
    `).all(
      harness ?? null,
      harness ?? null,
      ...filter.params,
      limit,
      offset,
    ) as ConversationRow[];
  }

  #storedCacheIssues(rootIDs: number[]): Map<number, CacheIssue[]> {
    if (rootIDs.length === 0) return new Map();
    const placeholders = rootIDs.map(() => "?").join(", ");
    // SAFETY: The static SQL projection and migrated schema define this row contract.
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
        turn: row.turn_ordinal,
      };
      if (row.cause !== null) issue.cause = row.cause;
      else if (row.reason !== null) issue.reason = row.reason;
      if (scope !== undefined) issue.scope = scope;
      const key = `${row.root_id}:${JSON.stringify(issue)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rootIssues = issues.get(row.root_id) ?? [];
      rootIssues.push(issue);
      issues.set(row.root_id, rootIssues);
    }
    return issues;
  }

  #summary(row: ConversationRow): SessionSummary {
    if (row.summary_json === null) {
      return baseSummary(row, undefined);
    }
    const stored = sessionListItemSchema.parse(JSON.parse(row.summary_json));
    const base = baseSummary(row, stored.thinking);
    return sessionSummarySchema.parse({ ...stored, ...base });
  }
}
