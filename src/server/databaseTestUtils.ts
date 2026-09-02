import type { DatabaseSync } from "node:sqlite";

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
  "../../db/migrations/20260811120000_add_generated_session_titles.sql",
  "../../db/migrations/20260812120000_compact_conversation_summaries.sql",
  "../../db/migrations/20260813120000_canonicalize_conversation_checkpoint.sql",
  "../../db/migrations/20260814120000_remove_legacy_session_schema.sql",
  "../../db/migrations/20260902120000_add_tool_event_execution_idx.sql",
  "../../db/migrations/20260902121000_add_conversation_usage_idx.sql",
  "../../db/migrations/20260902122000_add_turn_execution_idx.sql",
  "../../db/migrations/20260902123000_add_turn_execution_cover_idx.sql",
].map((path) => new URL(path, import.meta.url));

export function migrateTestDatabase(db: DatabaseSync) {
  for (const migration of migrations) {
    const sql = Deno.readTextFileSync(migration);
    const up = sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", "");
    db.exec(up);
  }
}
