import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import {
  titleGenerationCandidates,
  titleGenerationEligible,
} from "./titleGeneration.ts";

Deno.test("uses the session start time rather than import time for title fences", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  try {
    const sourceID = Number(
      db.prepare(`
        INSERT INTO sources (harness, kind, label, location, created_at)
        VALUES ('codex', 'directory', 'Codex', '/sessions', 1)
        RETURNING id
      `).get()!.id,
    );
    const sourceSessionID = Number(
      db.prepare(`
        INSERT INTO source_sessions (
          source_id, external_id, availability, first_seen_at, last_seen_at
        ) VALUES (?, 'old-session', 'available', 2_000, 2_000)
        RETURNING id
      `).get(sourceID)!.id,
    );
    const conversationID = Number(
      db.prepare(`
        INSERT INTO conversations (
          source_id, external_id, title, updated_at, started_at,
          providers_json, models_json
        ) VALUES (?, 'old-session', 'Old prompt', 100, 100, '[]', '[]')
        RETURNING id
      `).get(sourceID)!.id,
    );
    db.prepare(`
      INSERT INTO conversation_branches (
        conversation_id, source_session_id, external_id,
        fork_point_provenance, updated_at
      ) VALUES (?, ?, 'old-session', 'explicit', 100)
    `).run(conversationID, sourceSessionID);
    db.prepare(`
      INSERT INTO conversation_entries (
        conversation_id, kind, role, content_kind, content_preview
      ) VALUES (?, 'message', 'user', 'text', 'Old prompt')
    `).run(conversationID);
    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('generate_session_titles_enabled_at', '1000')
    `).run();

    deepStrictEqual(
      titleGenerationCandidates(db, "new").map((candidate) => candidate.id),
      [],
    );
    deepStrictEqual(
      titleGenerationCandidates(db, "backfill").map((candidate) =>
        candidate.id
      ),
      [sourceSessionID],
    );
  } finally {
    db.close();
  }
});

Deno.test("generates a title when the imported title is the first user prompt", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Inspect sessions and summarize the results",
      input: "  Inspect sessions\nand summarize the results  ",
    }),
    true,
  );
});

Deno.test("does not generate over an authoritative imported title", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Build Python Robot Arena",
      input: "Look at ROBOT.cpp and port it to Python",
    }),
    false,
  );
});

Deno.test("generates over known generic harness fallback titles", () => {
  strictEqual(
    titleGenerationEligible({
      imported_title: "Pi session project",
      input: "Inspect sessions",
    }),
    true,
  );
  strictEqual(
    titleGenerationEligible({
      imported_title: "OpenCode session abc123",
      input: "Inspect sessions",
    }),
    true,
  );
});
