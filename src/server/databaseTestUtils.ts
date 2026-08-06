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
  "../../db/migrations/20260805120000_add_artifact_import_projections.sql",
  "../../db/migrations/20260806120000_add_conversation_projection.sql",
  "../../db/migrations/20260807120000_add_source_artifact_identity_lineage.sql",
  "../../db/migrations/20260808120000_add_conversation_entry_turn.sql",
  "../../db/migrations/20260809120000_add_conversation_analytics_rollups.sql",
  "../../db/migrations/20260809130000_add_conversation_read_indexes.sql",
  "../../db/migrations/20260809140000_materialize_conversation_session_reads.sql",
  "../../db/migrations/20260809150000_add_conversation_replacement_indexes.sql",
  "../../db/migrations/20260809160000_materialize_conversation_call_cost.sql",
  "../../db/migrations/20260809170000_link_conversation_tools_to_children.sql",
].map((path) => new URL(path, import.meta.url));

export function migrateTestDatabase(db: DatabaseSync) {
  for (const migration of migrations) {
    const sql = Deno.readTextFileSync(migration);
    const up = sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", "");
    db.exec(up);
  }
}
