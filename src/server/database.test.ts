import { strictEqual } from "node:assert/strict";
import { join } from "node:path";
import {
  compactHomePath,
  expandHomePath,
  openArchiveDatabase,
  sqlitePath,
} from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

Deno.test("expands and compacts home-relative paths", () => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) throw new Error("Test requires a home directory");
  const expected = join(home, "data/archive.sqlite");
  strictEqual(expandHomePath("~/data/archive.sqlite"), expected);
  strictEqual(sqlitePath("sqlite:~/data/archive.sqlite"), expected);
  strictEqual(expandHomePath("/tmp/archive.sqlite"), "/tmp/archive.sqlite");
  const currentHome = home;
  strictEqual(compactHomePath(currentHome), "~");
  strictEqual(
    compactHomePath(join(currentHome, "project/archive.sqlite")),
    "~/project/archive.sqlite",
  );
  strictEqual(
    compactHomePath(`${currentHome}-other/archive.sqlite`),
    `${currentHome}-other/archive.sqlite`,
  );
});

Deno.test("opens an archive database with the required SQLite settings", () => {
  const directory = Deno.makeTempDirSync();
  const path = `${directory}/archive.sqlite`;
  try {
    const first = openArchiveDatabase(path);
    migrateTestDatabase(first);
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const tables = first.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN (
          'sources',
          'source_sessions',
          'artifact_import_projections',
          'conversations',
          'conversation_turns',
          'conversation_model_calls',
          'conversation_tool_events',
          'conversation_entries',
          'conversation_branches',
          'artifact_entry_occurrences',
          'artifact_model_call_occurrences',
          'conversation_subagent_launches',
          'conversation_rollups',
          'conversation_cache_misses',
          'source_artifact_identities',
          'source_artifact_lineage',
          'app_settings',
          'title_generation_runs'
        )
    `).get() as { count: number };
    strictEqual(tables.count, 18);
    strictEqual(first.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    first.close();
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});
