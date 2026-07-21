import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

type Options = {
  source: string;
  target: string;
};

type Row = Record<string, string | number | null>;

function usage(): never {
  throw new Error(
    "Usage: deno task demo:db:merge -- --target <target.sqlite> --source <sanitized-source.sqlite>",
  );
}

function parseOptions(args: string[]): Options {
  let source: string | undefined;
  let target: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--source") {
      source = args[++index];
      if (!source) usage();
      continue;
    }
    if (argument === "--target") {
      target = args[++index];
      if (!target) usage();
      continue;
    }
    usage();
  }
  if (!source || !target) usage();
  return { source, target };
}

function requireFile(path: string, name: string) {
  try {
    if (!Deno.statSync(path).isFile) throw new Error();
  } catch {
    throw new Error(`${name} database does not exist: ${path}`);
  }
}

function schemaSignature(db: DatabaseSync) {
  return JSON.stringify(db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all());
}

function assertForeignKeys(db: DatabaseSync, name: string) {
  const failures = db.prepare("PRAGMA foreign_key_check").all();
  if (failures.length > 0) {
    throw new Error(`${name} database has foreign-key violations`);
  }
}

function countWhere(db: DatabaseSync, table: string, predicate: string) {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
    .get() as { count: number }).count);
}

function assertSanitized(db: DatabaseSync, name: string) {
  const checks = [
    ["sources", `location NOT GLOB 'demo-source-*' OR label NOT GLOB 'Demo *'`],
    [
      "source_sessions",
      `external_id NOT GLOB 'demo-session-*'
        OR public_id NOT GLOB 'demo-session-*'
        OR artifact_path IS NOT NULL
        OR change_hint IS NOT NULL
        OR last_error IS NOT NULL`,
    ],
    ["sessions", "title IS NULL OR title = '' OR agent IS NOT NULL"],
    [
      "turn_inputs",
      "content_hash IS NOT NULL OR (preview IS NOT NULL AND preview <> '[redacted]')",
    ],
    [
      "call_content",
      "content_hash IS NOT NULL OR (preview IS NOT NULL AND preview <> '[redacted]')",
    ],
    ["model_calls", "source_call_id IS NOT NULL"],
    [
      "tool_events",
      `source_tool_id IS NOT NULL
        OR (input_preview IS NOT NULL AND input_preview <> '[redacted]')
        OR (output_preview IS NOT NULL AND output_preview <> '[redacted]')`,
    ],
  ] as const;
  const failures = checks.map(([table, predicate]) => ({
    table,
    count: countWhere(db, table, predicate),
  })).filter(({ count }) => count > 0);
  if (failures.length > 0) {
    throw new Error(
      `${name} database is not a sanitized demo database: ${failures.map((
        { table, count },
      ) => `${table} (${count})`).join(", ")}`,
    );
  }
}

function assertChecksums(source: DatabaseSync) {
  const missing = countWhere(source, "source_sessions", "checksum IS NULL OR checksum = ''");
  if (missing > 0) {
    throw new Error(
      `Source database has ${missing} session${missing === 1 ? "" : "s"} without a checksum. Regenerate it with the current demo generator before merging.`,
    );
  }
}

function value(row: Row, name: string) {
  return row[name];
}

function copyContent(
  source: DatabaseSync,
  target: DatabaseSync,
  table: "turn_inputs" | "call_content",
  foreignKey: "turn_id" | "model_call_id",
  sourceID: number,
  targetID: number,
) {
  const rows = source.prepare(`
    SELECT ordinal, kind, preview, original_length, truncated, mime_type, content_hash
    FROM ${table} WHERE ${foreignKey} = ? ORDER BY ordinal
  `).all(sourceID) as Row[];
  const insert = target.prepare(`
    INSERT INTO ${table} (
      ${foreignKey}, ordinal, kind, preview, original_length, truncated, mime_type, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      targetID,
      value(row, "ordinal"),
      value(row, "kind"),
      value(row, "preview"),
      value(row, "original_length"),
      value(row, "truncated"),
      value(row, "mime_type"),
      value(row, "content_hash"),
    );
  }
}

function mergeSession(
  source: DatabaseSync,
  target: DatabaseSync,
  sourceSession: Row,
  targetSessionID: number,
  targetSessionIDs: Map<number, number>,
  modelIDs: Map<number, number>,
) {
  const sourceSessionID = Number(value(sourceSession, "id"));
  const session = source.prepare(`
    SELECT title, agent, updated_at, started_at, ended_at, providers_json, models_json,
      user_turns, model_calls, reported_cost, uncached_input_tokens, cache_read_tokens,
      cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
      fresh_prompt_tokens, output_tokens, reasoning_tokens, processed_tokens
    FROM sessions WHERE source_session_id = ?
  `).get(sourceSessionID) as Row;
  target.prepare(`
    INSERT INTO sessions (
      source_session_id, title, agent, updated_at, started_at, ended_at,
      providers_json, models_json, user_turns, model_calls, reported_cost,
      uncached_input_tokens, cache_read_tokens, cache_write_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens, fresh_prompt_tokens,
      output_tokens, reasoning_tokens, processed_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetSessionID,
    value(session, "title"), value(session, "agent"), value(session, "updated_at"),
    value(session, "started_at"), value(session, "ended_at"), value(session, "providers_json"),
    value(session, "models_json"), value(session, "user_turns"), value(session, "model_calls"),
    value(session, "reported_cost"), value(session, "uncached_input_tokens"),
    value(session, "cache_read_tokens"), value(session, "cache_write_tokens"),
    value(session, "cache_write_5m_tokens"), value(session, "cache_write_1h_tokens"),
    value(session, "fresh_prompt_tokens"), value(session, "output_tokens"),
    value(session, "reasoning_tokens"), value(session, "processed_tokens"),
  );

  const targetModelID = (sourceModelID: number) => {
    const cached = modelIDs.get(sourceModelID);
    if (cached !== undefined) return cached;
    const model = source.prepare("SELECT provider, name FROM models WHERE id = ?")
      .get(sourceModelID) as Row;
    target.prepare("INSERT OR IGNORE INTO models (provider, name) VALUES (?, ?)")
      .run(value(model, "provider"), value(model, "name"));
    const targetModel = target.prepare("SELECT id FROM models WHERE provider = ? AND name = ?")
      .get(value(model, "provider"), value(model, "name")) as { id: number };
    modelIDs.set(sourceModelID, targetModel.id);
    return targetModel.id;
  };

  const callIDs = new Map<number, number>();
  const turns = source.prepare(
    "SELECT id, ordinal, started_at FROM turns WHERE session_id = ? ORDER BY ordinal",
  ).all(sourceSessionID) as Row[];
  for (const turn of turns) {
    const targetTurn = target.prepare(`
      INSERT INTO turns (session_id, ordinal, started_at) VALUES (?, ?, ?) RETURNING id
    `).get(targetSessionID, value(turn, "ordinal"), value(turn, "started_at")) as {
      id: number;
    };
    const sourceTurnID = Number(value(turn, "id"));
    copyContent(source, target, "turn_inputs", "turn_id", sourceTurnID, targetTurn.id);

    const calls = source.prepare(`
      SELECT id, source_call_id, ordinal, model_id, started_at, completed_at,
        reported_cost, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, fresh_prompt_tokens,
        output_tokens, reasoning_tokens, processed_tokens, finish_reason, images,
        has_text, has_reasoning
      FROM model_calls WHERE turn_id = ? ORDER BY ordinal
    `).all(sourceTurnID) as Row[];
    for (const call of calls) {
      const targetCall = target.prepare(`
        INSERT INTO model_calls (
          turn_id, source_call_id, ordinal, model_id, started_at, completed_at,
          reported_cost, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
          cache_write_5m_tokens, cache_write_1h_tokens, fresh_prompt_tokens,
          output_tokens, reasoning_tokens, processed_tokens, finish_reason, images,
          has_text, has_reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).get(
        targetTurn.id, value(call, "source_call_id"), value(call, "ordinal"),
        targetModelID(Number(value(call, "model_id"))), value(call, "started_at"),
        value(call, "completed_at"), value(call, "reported_cost"),
        value(call, "uncached_input_tokens"), value(call, "cache_read_tokens"),
        value(call, "cache_write_tokens"), value(call, "cache_write_5m_tokens"),
        value(call, "cache_write_1h_tokens"), value(call, "fresh_prompt_tokens"),
        value(call, "output_tokens"), value(call, "reasoning_tokens"),
        value(call, "processed_tokens"), value(call, "finish_reason"), value(call, "images"),
        value(call, "has_text"), value(call, "has_reasoning"),
      ) as { id: number };
      const sourceCallID = Number(value(call, "id"));
      callIDs.set(sourceCallID, targetCall.id);
      copyContent(source, target, "call_content", "model_call_id", sourceCallID, targetCall.id);

      const tools = source.prepare(`
        SELECT source_tool_id, ordinal, name, status, started_at, completed_at,
          child_source_session_id, input_preview, input_original_length,
          input_truncated, output_preview, output_original_length, output_truncated
        FROM tool_events WHERE model_call_id = ? ORDER BY ordinal
      `).all(sourceCallID) as Row[];
      const insertTool = target.prepare(`
        INSERT INTO tool_events (
          model_call_id, source_tool_id, ordinal, name, status, started_at, completed_at,
          child_source_session_id, input_preview, input_original_length, input_truncated,
          output_preview, output_original_length, output_truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tool of tools) {
        const sourceChildID = value(tool, "child_source_session_id");
        const targetChildID = sourceChildID === null
          ? null
          : targetSessionIDs.get(Number(sourceChildID)) ?? null;
        insertTool.run(
          targetCall.id, value(tool, "source_tool_id"), value(tool, "ordinal"),
          value(tool, "name"), value(tool, "status"), value(tool, "started_at"),
          value(tool, "completed_at"), targetChildID, value(tool, "input_preview"),
          value(tool, "input_original_length"), value(tool, "input_truncated"),
          value(tool, "output_preview"), value(tool, "output_original_length"),
          value(tool, "output_truncated"),
        );
      }
    }
  }

  const contextEvents = source.prepare(`
    SELECT event_type, source_order, occurred_at, affected_model_call_id
    FROM context_events WHERE session_id = ? ORDER BY source_order
  `).all(sourceSessionID) as Row[];
  const insertContextEvent = target.prepare(`
    INSERT INTO context_events (
      session_id, event_type, source_order, occurred_at, affected_model_call_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const event of contextEvents) {
    const sourceCallID = value(event, "affected_model_call_id");
    const targetCallID = sourceCallID === null
      ? null
      : callIDs.get(Number(sourceCallID));
    if (sourceCallID !== null && targetCallID === undefined) {
      throw new Error(`Context event references a missing model call in session ${sourceSessionID}`);
    }
    insertContextEvent.run(
      targetSessionID, value(event, "event_type"), value(event, "source_order"),
      value(event, "occurred_at"), targetCallID ?? null,
    );
  }
}

const options = parseOptions(Deno.args);
const sourcePath = resolve(options.source);
const targetPath = resolve(options.target);
if (sourcePath === targetPath) {
  throw new Error("Source and target databases must be different files");
}
requireFile(sourcePath, "Source");
requireFile(targetPath, "Target");

const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new DatabaseSync(targetPath);
try {
  if (schemaSignature(source) !== schemaSignature(target)) {
    throw new Error("Source and target databases do not have the same schema");
  }
  assertForeignKeys(source, "Source");
  assertForeignKeys(target, "Target");
  assertSanitized(source, "Source");
  assertSanitized(target, "Target");
  assertChecksums(source);

  const sourceSessions = source.prepare(`
    SELECT ss.id, ss.source_id, ss.parent_id, ss.tree_root_id, ss.availability,
      ss.source_size, ss.source_modified_at, ss.checksum, ss.parser_version,
      ss.first_seen_at, ss.last_seen_at, ss.imported_at
    FROM source_sessions ss
    JOIN sessions s ON s.source_session_id = ss.id
    ORDER BY ss.id
  `).all() as Row[];
  const hasChecksum = target.prepare(
    "SELECT 1 FROM source_sessions WHERE checksum = ? LIMIT 1",
  );

  target.exec("PRAGMA foreign_keys = ON");
  target.exec("BEGIN IMMEDIATE");
  try {
    const retained = sourceSessions.filter((session) =>
      hasChecksum.get(value(session, "checksum")) === undefined
    );
    const skipped = sourceSessions.length - retained.length;
    const sourceIDs = new Map<number, number>();
    const sourceRows = new Map<number, Row>();
    for (const session of retained) {
      const sourceID = Number(value(session, "source_id"));
      if (sourceRows.has(sourceID)) continue;
      const sourceRow = source.prepare(
        "SELECT harness, kind, created_at FROM sources WHERE id = ?",
      ).get(sourceID) as Row;
      sourceRows.set(sourceID, sourceRow);
      const targetSource = target.prepare(`
        INSERT INTO sources (harness, kind, label, location, created_at)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).get(
        value(sourceRow, "harness"), value(sourceRow, "kind"),
        `Demo ${value(sourceRow, "harness")}`, "pending", value(sourceRow, "created_at"),
      ) as { id: number };
      sourceIDs.set(sourceID, targetSource.id);
      target.prepare("UPDATE sources SET location = ? WHERE id = ?")
        .run(`demo-source-${targetSource.id}`, targetSource.id);
    }

    const targetSessionIDs = new Map<number, number>();
    const insertSourceSession = target.prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, public_id, parent_id, tree_root_id, artifact_path,
        availability, source_size, source_modified_at, checksum, parser_version,
        first_seen_at, last_seen_at, imported_at, last_error, change_hint
      ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      RETURNING id
    `);
    for (const session of retained) {
      const targetSession = insertSourceSession.get(
        sourceIDs.get(Number(value(session, "source_id")))!, "pending", "pending",
        value(session, "availability"), value(session, "source_size"),
        value(session, "source_modified_at"), value(session, "checksum"),
        value(session, "parser_version"), value(session, "first_seen_at"),
        value(session, "last_seen_at"), value(session, "imported_at"),
      ) as { id: number };
      const sourceSessionID = Number(value(session, "id"));
      targetSessionIDs.set(sourceSessionID, targetSession.id);
      target.prepare(`
        UPDATE source_sessions SET external_id = ?, public_id = ? WHERE id = ?
      `).run(
        `demo-session-${targetSession.id}`,
        `demo-session-${targetSession.id}`,
        targetSession.id,
      );
    }

    const updateTree = target.prepare(`
      UPDATE source_sessions SET parent_id = ?, tree_root_id = ? WHERE id = ?
    `);
    for (const session of retained) {
      const sourceSessionID = Number(value(session, "id"));
      const targetSessionID = targetSessionIDs.get(sourceSessionID)!;
      const parentID = value(session, "parent_id");
      const targetParentID = parentID === null
        ? null
        : targetSessionIDs.get(Number(parentID)) ?? null;
      const treeRootID = value(session, "tree_root_id");
      const targetTreeRootID = targetParentID === null
        ? targetSessionID
        : treeRootID === null
        ? targetSessionID
        : targetSessionIDs.get(Number(treeRootID)) ?? targetSessionID;
      updateTree.run(targetParentID, targetTreeRootID, targetSessionID);
    }

    const modelIDs = new Map<number, number>();
    for (const session of retained) {
      mergeSession(
        source,
        target,
        session,
        targetSessionIDs.get(Number(value(session, "id")))!,
        targetSessionIDs,
        modelIDs,
      );
    }

    assertForeignKeys(target, "Merged target");
    target.exec("COMMIT");
    console.log(
      `Imported ${retained.length} session${retained.length === 1 ? "" : "s"}; skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
} finally {
  target.close();
  source.close();
}
