import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";

const migrations = [
  "../../db/migrations/20260714120000_create_initial_archive.sql",
  "../../db/migrations/20260714130000_add_source_session_public_and_tree_ids.sql",
  "../../db/migrations/20260714140000_add_source_session_change_hint.sql",
  "../../db/migrations/20260715120000_add_context_events.sql",
  "../../db/migrations/20260716120000_add_reasoning_settings.sql",
  "../../db/migrations/20260717120000_add_cache_misses.sql",
  "../../db/migrations/20260717130000_add_model_call_rollups.sql",
  "../../db/migrations/20260717140000_add_session_rollups.sql",
  "../../db/migrations/20260717150000_add_source_session_working_directory.sql",
  "../../db/migrations/20260804120000_add_compaction_details.sql",
  "../../db/migrations/20260810120000_create_conversation_projection.sql",
].map((path) => new URL(path, import.meta.url));

function migrate(db: ReturnType<typeof openArchiveDatabase>, migration: URL) {
  const sql = Deno.readTextFileSync(migration);
  db.exec(sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", ""));
}

Deno.test("projection checkpoint migration backfills legacy parser state", () => {
  const db = openArchiveDatabase(":memory:");
  try {
    for (const migration of migrations.slice(0, -1)) migrate(db, migration);
    const sourceID = Number(db.prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES ('codex', 'directory', 'Codex', '/sessions', 1)
      RETURNING id
    `).get()!.id);
    db.prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, public_id, artifact_path, availability,
        source_size, source_modified_at, checksum, parser_version,
        first_seen_at, last_seen_at, imported_at, last_error, change_hint
      ) VALUES (?, 'rollout', 'rollout', 'rollout.jsonl', 'available',
        123, 456, 'legacy-checksum', 'codex-12', 1, 2, 3, NULL,
        'legacy-hint')
    `).run(sourceID);

    migrate(db, migrations.at(-1)!);

    deepStrictEqual(
      { ...db.prepare(`
        SELECT projection_name, parser_version, source_checksum,
          source_change_hint, dependency_digest, imported_at, last_error
        FROM artifact_import_projections
      `).get()! },
      {
        projection_name: "legacy",
        parser_version: "codex-12",
        source_checksum: "legacy-checksum",
        source_change_hint: "legacy-hint",
        dependency_digest: null,
        imported_at: 3,
        last_error: null,
      },
    );

    const repository = new SessionRepository(db);
    repository.recordProjectionCheckpoint(sourceID, "rollout", "conversation-v2", {
      parserVersion: "codex-v2-1",
      checksum: "v2-checksum",
      changeHint: "v2-hint",
      dependencyDigest: "family-digest",
      importedAt: 4,
    });
    strictEqual(
      repository.checkpoint(sourceID, "rollout", "legacy")?.parserVersion,
      "codex-12",
    );
    deepStrictEqual(
      repository.checkpoint(sourceID, "rollout", "conversation-v2"),
      {
        changeHint: "v2-hint",
        sourceSize: 123,
        sourceModifiedAt: 456,
        checksum: "v2-checksum",
        parserVersion: "codex-v2-1",
        dependencyDigest: "family-digest",
        importedAt: 4,
        lastError: undefined,
      },
    );
  } finally {
    db.close();
  }
});
