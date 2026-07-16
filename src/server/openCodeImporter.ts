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

const parserVersion = "opencode-3";

type AggregateRow = {
  session_id: string;
  row_count: number;
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

const sessionColumns = "*";

function digest(values: unknown[]) {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(JSON.stringify(value));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Selecting part.time_updated forces SQLite to visit rows spread across the
// large JSON payload table. The complete session row plus indexed child counts
// is the cheap hint; changed trees still receive a full content checksum below.
function aggregates(db: DatabaseSync, table: "message" | "part") {
  return new Map(
    (db.prepare(`
      SELECT session_id, COUNT(*) AS row_count
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
    session: Object.entries(session).toSorted(([a], [b]) => a.localeCompare(b)),
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
      (latest, session) => Math.max(latest, session.time_updated),
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
    -- OpenCode can store enormous generated diffs in message.summary. The
    -- archive does not use that field, so keep it out of V8 and the checksum.
    SELECT id, session_id, time_created, time_updated,
      json_remove(data, '$.summary') AS data
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
  function aggregate<T extends { session_id: string }>(rows: T[]) {
    return new Map(
      [...Map.groupBy(rows, (row) => row.session_id)].map((
        [sessionID, values],
      ) => [
        sessionID,
        {
          session_id: sessionID,
          row_count: values.length,
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
  let discoveryDuration = 0;
  let checkpointDuration = 0;
  let sourceReadDuration = 0;
  let normalizeDuration = 0;
  let archiveWriteDuration = 0;

  try {
    const discoveryStartedAt = performance.now();
    candidates = discover(source);
    discoveryDuration = performance.now() - discoveryStartedAt;
    for (const initial of candidates) {
      const checkpointStartedAt = performance.now();
      const previous = repository.checkpoint(sourceID, initial.id);
      checkpointDuration += performance.now() - checkpointStartedAt;
      if (
        previous?.parserVersion === parserVersion &&
        previous.changeHint === initial.changeHint
      ) {
        skipped++;
        continue;
      }

      let transaction = false;
      try {
        const sourceReadStartedAt = performance.now();
        source.exec("BEGIN");
        transaction = true;
        const rows = snapshot(source, initial.id);
        const fresh = snapshotCandidate(rows);
        const contentChecksum = checksum(rows);
        sourceReadDuration += performance.now() - sourceReadStartedAt;
        const checkpoint: SourceSessionCheckpoint = {
          changeHint: fresh.changeHint,
          sourceSize: fresh.rowCount,
          sourceModifiedAt: fresh.updatedAt,
          checksum: contentChecksum,
          parserVersion,
        };
        const normalizeStartedAt = performance.now();
        const normalized = normalizeOpenCodeSessionTree({
          ...rows,
          sourceID,
          observedAt,
          checkpoint,
        });
        normalizeDuration += performance.now() - normalizeStartedAt;
        source.exec("COMMIT");
        transaction = false;

        if (
          previous?.parserVersion === parserVersion &&
          previous.checksum === contentChecksum
        ) {
          const archiveWriteStartedAt = performance.now();
          recordUnchangedTree(
            repository,
            sourceID,
            fresh,
            observedAt,
            checkpoint,
          );
          archiveWriteDuration += performance.now() - archiveWriteStartedAt;
          skipped++;
          continue;
        }
        const archiveWriteStartedAt = performance.now();
        repository.replaceSourceSessionTree(normalized);
        archiveWriteDuration += performance.now() - archiveWriteStartedAt;
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
    const finalizeStartedAt = performance.now();
    repository.markSourceSessionsSeen(
      sourceID,
      candidates.flatMap((value) =>
        value.sessions.map((session) => session.id)
      ),
      observedAt,
    );
    repository.markMissingSourceSessions(sourceID, observedAt);
    const finalizeDuration = performance.now() - finalizeStartedAt;
    return {
      discovered: candidates.length,
      imported,
      skipped,
      failed,
      timings: {
        discovery: discoveryDuration,
        checkpoints: checkpointDuration,
        sourceRead: sourceReadDuration,
        normalize: normalizeDuration,
        archiveWrite: archiveWriteDuration,
        finalize: finalizeDuration,
      },
    };
  } finally {
    source.close();
  }
}
