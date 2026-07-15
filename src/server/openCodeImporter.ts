import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeOpenCodeSessionTree,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
  type OpenCodeSessionRow,
} from "./opencodeRepository.ts";
import {
  SessionRepository,
  type SourceSessionCheckpoint,
} from "./sessionRepository.ts";

const parserVersion = "opencode-1";

type AggregateRow = {
  session_id: string;
  row_count: number;
  max_updated: number | null;
  update_sum: string | null;
};

type OpenCodeCandidate = {
  id: string;
  sessions: OpenCodeSessionRow[];
  changeHint: string;
  rowCount: number;
  updatedAt: number;
};

type OpenCodeSnapshot = {
  sessions: OpenCodeSessionRow[];
  messages: OpenCodeMessageRow[];
  parts: OpenCodePartRow[];
};

const sessionColumns = `
  id, parent_id, title, model, agent, time_created, time_updated
`;

function digest(values: unknown[]) {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(JSON.stringify(value));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function aggregates(db: DatabaseSync, table: "message" | "part") {
  return new Map(
    (db.prepare(`
      SELECT session_id, COUNT(*) AS row_count,
        MAX(time_updated) AS max_updated,
        CAST(SUM(time_updated) AS TEXT) AS update_sum
      FROM ${table}
      GROUP BY session_id
      ORDER BY session_id
    `).all() as AggregateRow[]).map((row) => [row.session_id, row]),
  );
}

function candidate(
  sessions: OpenCodeSessionRow[],
  messages: Map<string, AggregateRow>,
  parts: Map<string, AggregateRow>,
): OpenCodeCandidate {
  const ordered = sessions.toSorted((a, b) => a.id.localeCompare(b.id));
  const hintValues = ordered.map((session) => ({
    session,
    messages: messages.get(session.id) ?? null,
    parts: parts.get(session.id) ?? null,
  }));
  return {
    id: ordered.find((session) => session.parent_id === null)?.id ??
      ordered[0].id,
    sessions: ordered,
    changeHint: digest(hintValues),
    rowCount: ordered.reduce(
      (total, session) =>
        total + 1 + (messages.get(session.id)?.row_count ?? 0) +
        (parts.get(session.id)?.row_count ?? 0),
      0,
    ),
    updatedAt: ordered.reduce(
      (latest, session) =>
        Math.max(
          latest,
          session.time_updated,
          messages.get(session.id)?.max_updated ?? 0,
          parts.get(session.id)?.max_updated ?? 0,
        ),
      0,
    ),
  };
}

function discover(db: DatabaseSync) {
  const sessions = db.prepare(`
    SELECT ${sessionColumns} FROM session ORDER BY id
  `).all() as OpenCodeSessionRow[];
  const messages = aggregates(db, "message");
  const parts = aggregates(db, "part");
  const children = Map.groupBy(
    sessions.filter((session) => session.parent_id !== null),
    (session) => session.parent_id!,
  );

  function tree(root: OpenCodeSessionRow) {
    const result: OpenCodeSessionRow[] = [];
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const session = pending.shift()!;
      if (visited.has(session.id)) continue;
      visited.add(session.id);
      result.push(session);
      pending.push(...(children.get(session.id) ?? []));
    }
    return result;
  }

  return sessions.filter((session) => session.parent_id === null)
    .map((root) => candidate(tree(root), messages, parts))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(", ");
}

function snapshot(db: DatabaseSync, rootID: string): OpenCodeSnapshot {
  const sessions = db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM session WHERE id = ?
      UNION ALL
      SELECT child.id FROM session child JOIN tree ON child.parent_id = tree.id
    )
    SELECT ${sessionColumns} FROM session
    WHERE id IN (SELECT id FROM tree)
    ORDER BY id
  `).all(rootID) as OpenCodeSessionRow[];
  if (sessions.length === 0) {
    throw new Error("OpenCode session tree disappeared");
  }
  const sessionIDs = sessions.map((session) => session.id);
  const ids = placeholders(sessionIDs);
  const messages = db.prepare(`
    SELECT id, session_id, time_created, time_updated, data
    FROM message WHERE session_id IN (${ids})
    ORDER BY session_id, time_created, id
  `).all(...sessionIDs) as OpenCodeMessageRow[];
  const parts = db.prepare(`
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part WHERE session_id IN (${ids})
    ORDER BY session_id, time_created, id
  `).all(...sessionIDs) as OpenCodePartRow[];
  return { sessions, messages, parts };
}

function snapshotCandidate(value: OpenCodeSnapshot) {
  function aggregate<T extends { session_id: string; time_updated: number }>(
    rows: T[],
  ) {
    return new Map(
      [...Map.groupBy(rows, (row) => row.session_id)].map((
        [sessionID, values],
      ) => [
        sessionID,
        {
          session_id: sessionID,
          row_count: values.length,
          max_updated: Math.max(...values.map((row) => row.time_updated)),
          update_sum: values.reduce(
            (sum, row) => sum + BigInt(row.time_updated),
            0n,
          ).toString(),
        },
      ]),
    );
  }
  return candidate(
    value.sessions,
    aggregate(value.messages),
    aggregate(value.parts),
  );
}

function checksum(value: OpenCodeSnapshot) {
  return digest([
    ...value.sessions.map((row) => [
      row.id,
      row.parent_id,
      row.title,
      row.model,
      row.agent,
      row.time_created,
      row.time_updated,
    ]),
    ...value.messages.map((row) => [
      row.id,
      row.session_id,
      row.time_created,
      row.data,
    ]),
    ...value.parts.map((row) => [
      row.id,
      row.message_id,
      row.session_id,
      row.time_created,
      row.data,
    ]),
  ]);
}

function recordUnchangedTree(
  repository: SessionRepository,
  sourceID: number,
  value: OpenCodeCandidate,
  observedAt: number,
  checkpoint?: SourceSessionCheckpoint,
) {
  for (const session of value.sessions) {
    repository.recordUnchangedSourceSession(
      sourceID,
      session.id,
      `session:${session.id}`,
      observedAt,
      checkpoint,
    );
  }
}

export function syncOpenCodeSessions(
  path: string,
  repository: SessionRepository,
) {
  const source = new DatabaseSync(path, { readOnly: true });
  const observedAt = Date.now();
  const sourceID = repository.ensureSource(
    "opencode",
    "database",
    "OpenCode",
    path,
  );
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let candidates: OpenCodeCandidate[] = [];

  try {
    candidates = discover(source);
    for (const initial of candidates) {
      const previous = repository.checkpoint(sourceID, initial.id);
      if (
        previous?.parserVersion === parserVersion &&
        previous.changeHint === initial.changeHint
      ) {
        skipped++;
        continue;
      }

      let transaction = false;
      try {
        source.exec("BEGIN");
        transaction = true;
        const rows = snapshot(source, initial.id);
        const fresh = snapshotCandidate(rows);
        const contentChecksum = checksum(rows);
        const checkpoint: SourceSessionCheckpoint = {
          changeHint: fresh.changeHint,
          sourceSize: fresh.rowCount,
          sourceModifiedAt: fresh.updatedAt,
          checksum: contentChecksum,
          parserVersion,
        };
        const normalized = normalizeOpenCodeSessionTree({
          ...rows,
          sourceID,
          observedAt,
          checkpoint,
        });
        source.exec("COMMIT");
        transaction = false;

        if (
          previous?.parserVersion === parserVersion &&
          previous.checksum === contentChecksum
        ) {
          recordUnchangedTree(
            repository,
            sourceID,
            fresh,
            observedAt,
            checkpoint,
          );
          skipped++;
          continue;
        }
        repository.replaceSourceSessionTree(normalized);
        imported++;
      } catch (error) {
        if (transaction) source.exec("ROLLBACK");
        console.warn(
          `[sync] harness=opencode session=${initial.id} failed`,
          error,
        );
        repository.recordSourceSessionError(
          sourceID,
          initial.id,
          `session:${initial.id}`,
          observedAt,
          error,
        );
        failed++;
      }
    }
    repository.markSourceSessionsSeen(
      sourceID,
      candidates.flatMap((value) =>
        value.sessions.map((session) => session.id)
      ),
      observedAt,
    );
    repository.markMissingSourceSessions(sourceID, observedAt);
    return { discovered: candidates.length, imported, skipped, failed };
  } finally {
    source.close();
  }
}
