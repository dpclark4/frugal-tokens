import type { DatabaseSync } from "node:sqlite";

const migration = new URL(
  "../../db/migrations/20260714120000_create_initial_archive.sql",
  import.meta.url,
);

export function migrateTestDatabase(db: DatabaseSync) {
  const sql = Deno.readTextFileSync(migration);
  const up = sql.split("-- migrate:down", 1)[0].replace("-- migrate:up", "");
  db.exec(up);
}
