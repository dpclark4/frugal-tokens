import { strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { expandHomePath, openArchiveDatabase, sqlitePath } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

Deno.test("expands home-relative paths", () => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) throw new Error("Test requires a home directory");
  const expected = join(home, "data/archive.sqlite");
  strictEqual(expandHomePath("~/data/archive.sqlite"), expected);
  strictEqual(sqlitePath("sqlite:~/data/archive.sqlite"), expected);
  strictEqual(expandHomePath("/tmp/archive.sqlite"), "/tmp/archive.sqlite");
});

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
          'tool_events',
          'context_events'
        )
    `).get() as { count: number };
    strictEqual(tables.count, 10);
    strictEqual(first.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    first.close();
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});
