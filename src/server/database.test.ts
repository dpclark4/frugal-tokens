import { strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

Deno.test("opens an archive database with the required SQLite settings", () => {
  const directory = Deno.makeTempDirSync();
  const path = `${directory}/archive.sqlite`;
  try {
    const first = openArchiveDatabase(path);
    migrateTestDatabase(first);
    const tables = first.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN (
          'sources',
          'source_sessions',
          'sessions',
          'turns',
          'turn_inputs',
          'models',
          'model_calls',
          'call_content',
          'tool_events'
        )
    `).get() as { count: number };
    strictEqual(tables.count, 9);
    strictEqual(first.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    first.close();
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});
