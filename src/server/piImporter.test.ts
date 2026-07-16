import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { syncPiSessions } from "./piImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

function transcript(prompt: string) {
  return `
{"type":"session","version":3,"id":"session","timestamp":"2026-07-11T13:36:32.689Z","cwd":"/Users/test/project"}
{"type":"message","id":"user-1","timestamp":"2026-07-11T13:36:55.000Z","message":{"role":"user","content":[{"type":"text","text":"${prompt}"}]}}
{"type":"message","id":"assistant-1","timestamp":"2026-07-11T13:36:59.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Stored answer"}],"provider":"anthropic","model":"claude-opus","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"stop"}}
{"type":"compaction","id":"compact-1","parentId":"assistant-1","timestamp":"2026-07-11T13:37:00.000Z","summary":"Sensitive generated summary"}
{"type":"message","id":"user-2","parentId":"compact-1","timestamp":"2026-07-11T13:37:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Continue"}]}}
{"type":"message","id":"assistant-2","parentId":"user-2","timestamp":"2026-07-11T13:37:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Continued answer"}],"provider":"anthropic","model":"claude-opus","usage":{"input":4,"output":3,"cacheRead":1,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"stop"}}
`.trim();
}

Deno.test("incrementally imports PI sessions and preserves the last good archive", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/sessions`;
  const project = `${sessions}/project`;
  const transcriptPath = `${project}/session.jsonl`;
  Deno.mkdirSync(project, { recursive: true });
  Deno.writeTextFileSync(transcriptPath, transcript("Initial prompt"));

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const initial = await syncPiSessions(sessions, repository);
    strictEqual(initial.imported, 1);
    strictEqual(
      repository.getSession("pi", "project/session")?.title,
      "Initial prompt",
    );
    strictEqual(
      (db.prepare("SELECT COUNT(*) AS count FROM turn_inputs").get() as {
        count: number;
      }).count,
      2,
    );
    strictEqual(
      (db.prepare("SELECT COUNT(*) AS count FROM call_content").get() as {
        count: number;
      }).count,
      2,
    );
    deepStrictEqual(
      repository.getSession("pi", "project/session")?.turns[1].calls[0]
        .contextEventsBefore,
      [{
        type: "compaction",
        sourceOrder: 4,
        occurredAt: Date.parse("2026-07-11T13:37:00.000Z"),
      }],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM call_content
        WHERE preview LIKE '%Sensitive generated summary%'
      `).get()!.count,
      0,
    );

    const unchanged = await syncPiSessions(sessions, repository);
    strictEqual(unchanged.skipped, 1);

    Deno.writeTextFileSync(
      transcriptPath,
      `${transcript("Broken replacement")}\n{`,
    );
    const failed = await syncPiSessions(sessions, repository);
    strictEqual(failed.failed, 1);
    strictEqual(
      repository.getSession("pi", "project/session")?.title,
      "Initial prompt",
    );

    Deno.removeSync(transcriptPath);
    await syncPiSessions(sessions, repository);
    strictEqual(repository.listSessions(1, 10, "pi").pagination.totalItems, 1);
    strictEqual(
      db.prepare(`
        SELECT availability FROM source_sessions WHERE external_id = 'project/session'
      `).get()!.availability,
      "missing",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
