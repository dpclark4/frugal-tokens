import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { openArchiveDatabase } from "./database.ts";
import { syncOpenCodeSessions } from "./openCodeImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { analyzeSessionCache } from "./cacheAnalysis.ts";

function sourceDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      model TEXT,
      agent TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

Deno.test("incrementally imports OpenCode session trees", () => {
  const directory = Deno.makeTempDirSync();
  const sourcePath = `${directory}/opencode.sqlite`;
  const source = sourceDatabase(sourcePath);
  const insertSession = source.prepare(`
    INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run("root", null, "Root", null, "build", 1, 10);
  insertSession.run("child", "root", "Child", null, "explore", 2, 9);
  const insertMessage = source.prepare(`
    INSERT INTO message VALUES (?, ?, ?, ?, ?)
  `);
  insertMessage.run("user", "root", 1, 1, JSON.stringify({ role: "user" }));
  insertMessage.run(
    "assistant",
    "root",
    2,
    2,
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude",
      time: { created: 2, completed: 3 },
      cost: 0.1,
      tokens: {
        input: 2,
        output: 3,
        reasoning: 0,
        cache: { read: 4, write: 0 },
      },
    }),
  );
  insertMessage.run(
    "compaction-user",
    "root",
    5,
    5,
    JSON.stringify({ role: "user" }),
  );
  insertMessage.run(
    "compaction-summary",
    "root",
    6,
    6,
    JSON.stringify({
      role: "assistant",
      summary: true,
      providerID: "anthropic",
      modelID: "claude",
      cost: 0.2,
      tokens: {
        input: 100,
        output: 10,
        reasoning: 0,
        cache: { read: 100, write: 0 },
      },
    }),
  );
  insertMessage.run(
    "post-user",
    "root",
    7,
    7,
    JSON.stringify({ role: "user" }),
  );
  insertMessage.run(
    "post-assistant",
    "root",
    8,
    8,
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude",
      cost: 0.1,
      tokens: {
        input: 80,
        output: 5,
        reasoning: 0,
        cache: { read: 20, write: 0 },
      },
    }),
  );
  insertMessage.run(
    "child-user",
    "child",
    2,
    2,
    JSON.stringify({ role: "user" }),
  );
  insertMessage.run(
    "child-assistant",
    "child",
    3,
    3,
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude",
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  insertMessage.run(
    "invalid-assistant",
    "root",
    4,
    4,
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude",
      tokens: {
        input: 1,
        output: -1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  const insertPart = source.prepare(`
    INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertPart.run(
    "user-text",
    "user",
    "root",
    1,
    1,
    JSON.stringify({ type: "text", text: "Inspect archive" }),
  );
  insertPart.run(
    "assistant-text",
    "assistant",
    "root",
    2,
    2,
    JSON.stringify({ type: "text", text: "Working" }),
  );
  insertPart.run(
    "tool",
    "assistant",
    "root",
    2,
    2,
    JSON.stringify({
      type: "tool",
      callID: "tool-1",
      tool: "task",
      state: {
        status: "completed",
        input: { prompt: "inspect" },
        output: "done",
        metadata: { sessionId: "child" },
        time: { start: 2, end: 3 },
      },
    }),
  );
  insertPart.run(
    "compaction",
    "compaction-user",
    "root",
    5,
    5,
    JSON.stringify({
      type: "compaction",
      auto: false,
      tail_start_id: "assistant",
    }),
  );
  insertPart.run(
    "summary-text",
    "compaction-summary",
    "root",
    6,
    6,
    JSON.stringify({ type: "text", text: "Sensitive generated summary" }),
  );

  const archive = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(archive);
  const repository = new SessionRepository(archive);
  try {
    const first = syncOpenCodeSessions(sourcePath, repository);
    strictEqual(first.imported, 1);
    const detail = repository.getSession("opencode", "root")!;
    strictEqual(detail.subagents[0].id, "child");
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    strictEqual(
      archive.prepare("SELECT preview FROM turn_inputs").get()!.preview,
      "Inspect archive",
    );
    strictEqual(
      archive.prepare("SELECT preview FROM call_content").get()!.preview,
      "Working",
    );
    const tool = archive.prepare(`
      SELECT input_preview, output_preview FROM tool_events
    `).get()!;
    strictEqual(tool.input_preview, '{"prompt":"inspect"}');
    strictEqual(tool.output_preview, "done");
    const compacted = detail.turns[2].calls[0];
    strictEqual(compacted.id, "post-assistant");
    deepStrictEqual(compacted.contextEventsBefore, [{
      type: "compaction",
      sourceOrder: 4,
      occurredAt: 5,
    }]);
    strictEqual(
      analyzeSessionCache(detail).turns[2].calls[0].cacheAssessment?.cause,
      "compaction",
    );
    strictEqual(detail.contextEvents?.length, 0);
    strictEqual(
      archive.prepare(`
        SELECT COUNT(*) AS count FROM call_content cc
        JOIN model_calls mc ON mc.id = cc.model_call_id
        WHERE mc.source_call_id = 'compaction-summary'
      `).get()!.count,
      0,
    );

    source.prepare(`
      UPDATE message SET data = json_set(
        data,
        '$.summary',
        json_object('diffs', json_array('unused generated diff'))
      )
      WHERE id = 'user'
    `).run();
    // Force the importer past its cheap change hint without changing any
    // archived content. The full checksum should ignore both unknown session
    // metadata and the unused message summary.
    source.exec("ALTER TABLE session ADD COLUMN ignored_metadata TEXT");
    source.prepare(`
      UPDATE session SET ignored_metadata = 'changed' WHERE id = 'root'
    `).run();
    strictEqual(syncOpenCodeSessions(sourcePath, repository).skipped, 1);

    strictEqual(syncOpenCodeSessions(sourcePath, repository).skipped, 1);
    source.prepare("UPDATE part SET time_updated = 20 WHERE id = 'tool'").run();
    strictEqual(syncOpenCodeSessions(sourcePath, repository).skipped, 1);

    source.prepare(`
      UPDATE part SET time_updated = 21,
        data = json_set(data, '$.state.output', 'changed')
      WHERE id = 'tool'
    `).run();
    source.prepare("UPDATE session SET time_updated = 21 WHERE id = 'root'")
      .run();
    strictEqual(syncOpenCodeSessions(sourcePath, repository).imported, 1);
    strictEqual(
      archive.prepare("SELECT output_preview FROM tool_events").get()!
        .output_preview,
      "changed",
    );

    source.prepare("DELETE FROM message WHERE session_id = 'child'").run();
    source.prepare("DELETE FROM session WHERE id = 'child'").run();
    strictEqual(syncOpenCodeSessions(sourcePath, repository).imported, 1);
    strictEqual(
      repository.getSession("opencode", "root")?.subagents.length,
      0,
    );
  } finally {
    source.close();
    archive.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
