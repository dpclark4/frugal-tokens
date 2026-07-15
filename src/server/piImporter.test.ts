import { strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { syncPiSessions } from "./piImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

function transcript(prompt: string) {
  return `
{"type":"session","version":3,"id":"session","timestamp":"2026-07-11T13:36:32.689Z","cwd":"/Users/test/project"}
{"type":"message","id":"user-1","timestamp":"2026-07-11T13:36:55.000Z","message":{"role":"user","content":[{"type":"text","text":"${prompt}"}]}}
{"type":"message","id":"assistant-1","timestamp":"2026-07-11T13:36:59.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Stored answer"}],"provider":"anthropic","model":"claude-opus","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"stop"}}
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
      1,
    );
    strictEqual(
      (db.prepare("SELECT COUNT(*) AS count FROM call_content").get() as {
        count: number;
      }).count,
      1,
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
