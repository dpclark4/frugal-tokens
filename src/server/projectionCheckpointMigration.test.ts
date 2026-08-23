import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";

const migrations = [
  "20260714120000_create_initial_archive.sql",
  "20260714130000_add_source_session_public_and_tree_ids.sql",
  "20260714140000_add_source_session_change_hint.sql",
  "20260715120000_add_context_events.sql",
  "20260716120000_add_reasoning_settings.sql",
  "20260717120000_add_cache_misses.sql",
  "20260717130000_add_model_call_rollups.sql",
  "20260717140000_add_session_rollups.sql",
  "20260717150000_add_source_session_working_directory.sql",
  "20260804120000_add_compaction_details.sql",
  "20260810120000_create_conversation_projection.sql",
  "20260811120000_add_generated_session_titles.sql",
  "20260812120000_compact_conversation_summaries.sql",
  "20260813120000_canonicalize_conversation_checkpoint.sql",
  "20260814120000_remove_legacy_session_schema.sql",
].map((name) => new URL(`../../db/migrations/${name}`, import.meta.url));

function migrate(db: ReturnType<typeof openArchiveDatabase>, migration: URL) {
  const sql = Deno.readTextFileSync(migration);
  db.exec(sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", ""));
}

Deno.test("cleanup migrations preserve canonical checkpoints and remove V1 tables", () => {
  const db = openArchiveDatabase(":memory:");
  try {
    for (const migration of migrations.slice(0, -2)) migrate(db, migration);
    const sourceID = Number(
      db.prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES ('codex', 'directory', 'Codex', '/sessions', 1)
      RETURNING id
    `).get()!.id,
    );
    const artifactID = Number(
      db.prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, public_id, availability,
        first_seen_at, last_seen_at
      ) VALUES (?, 'rollout', 'rollout', 'available', 1, 2)
      RETURNING id
    `).get(sourceID)!.id,
    );
    db.prepare(`
      INSERT INTO artifact_import_projections (
        source_session_id, projection_name, parser_version, source_checksum,
        imported_at
      ) VALUES (?, 'conversation-v2', 'codex-conversation-family-7',
        'checksum', 3), (?, 'legacy', 'codex-12', 'old-checksum', 2)
    `).run(artifactID, artifactID);

    migrate(db, migrations.at(-2)!);
    migrate(db, migrations.at(-1)!);

    deepStrictEqual(
      db.prepare(`
        SELECT projection_name, parser_version, source_checksum, imported_at
        FROM artifact_import_projections
      `).all().map((row) => ({ ...row })),
      [{
        projection_name: "conversation",
        parser_version: "codex-conversation-family-7",
        source_checksum: "checksum",
        imported_at: 3,
      }],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name IN (
          'sessions', 'turns', 'model_calls', 'models', 'tool_events'
        )
      `).get()!.count,
      0,
    );
    const columns =
      // SAFETY: The static SQL projection and migrated schema define this row contract.
      (db.prepare("PRAGMA table_info(source_sessions)").all() as Array<{
        name: string;
      }>).map((column) => column.name);
    strictEqual(columns.includes("parent_id"), false);
    strictEqual(columns.includes("checksum"), false);
    strictEqual(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
});
