import type { DatabaseSync } from "node:sqlite";

const migrations = [
  "../../db/migrations/20260714120000_create_initial_archive.sql",
  "../../db/migrations/20260714130000_add_source_session_public_and_tree_ids.sql",
  "../../db/migrations/20260714140000_add_source_session_change_hint.sql",
  "../../db/migrations/20260715120000_add_context_events.sql",
  "../../db/migrations/20260716120000_add_reasoning_settings.sql",
  "../../db/migrations/20260717120000_add_cache_misses.sql",
  "../../db/migrations/20260717130000_add_model_call_rollups.sql",
].map((path) => new URL(path, import.meta.url));

export function migrateTestDatabase(db: DatabaseSync) {
  for (const migration of migrations) {
    const sql = Deno.readTextFileSync(migration);
    const up = sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", "");
    db.exec(up);
  }
}
