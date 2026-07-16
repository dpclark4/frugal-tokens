import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncCodexSessions } from "./codexImporter.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SessionRepository } from "./sessionRepository.ts";

const transcript = `
{"id":"session","timestamp":"2026-07-11T13:59:59.000Z","instructions":null,"git":null}
{"timestamp":"2026-07-11T13:59:59.000Z","type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"ignored"}}
{"timestamp":"2026-07-11T13:59:59.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}
{"timestamp":"2026-07-11T14:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.6-luna"}}
{"timestamp":"2026-07-11T14:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Import Codex"}]}}
{"timestamp":"2026-07-11T14:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec_command","input":"ls"}}
{"timestamp":"2026-07-11T14:00:04.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"}}
{"timestamp":"2026-07-11T14:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Imported"}]}}
{"timestamp":"2026-07-11T14:00:06.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10,"reasoning_output_tokens":2}}}}
{"timestamp":"2026-07-11T14:00:07.000Z","type":"compacted","payload":{"message":"","replacement_history":[{"type":"compaction","id":"cmp-1","encrypted_content":"sensitive-summary"}]}}
{"timestamp":"2026-07-11T14:00:07.001Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-07-11T14:00:08.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:09.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Continue"}]}}
{"timestamp":"2026-07-11T14:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Continued"}]}}
{"timestamp":"2026-07-11T14:00:11.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":90,"cached_input_tokens":20,"output_tokens":8,"reasoning_output_tokens":0}}}}
`.trim();

Deno.test("imports Codex sessions for SQLite reads", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/sessions`;
  const rolloutDirectory = `${sessions}/2026/07/11`;
  Deno.mkdirSync(rolloutDirectory, { recursive: true });
  Deno.writeTextFileSync(
    `${rolloutDirectory}/rollout-session.jsonl`,
    transcript,
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const result = await syncCodexSessions(sessions, repository);
    strictEqual(result.imported, 1);

    const id = "2026/07/11/rollout-session";
    strictEqual(repository.listSessions(1, 10, "codex").items[0].id, id);
    strictEqual(repository.getSession("codex", id)?.title, "Import Codex");
    strictEqual(repository.listUsageCalls(undefined, "codex").length, 2);
    strictEqual(
      (db.prepare("SELECT preview FROM turn_inputs").get() as {
        preview: string;
      })
        .preview,
      "Import Codex",
    );
    strictEqual(
      (db.prepare("SELECT preview FROM call_content").get() as {
        preview: string;
      })
        .preview,
      "Imported",
    );
    const tool = db.prepare(`
      SELECT input_preview, output_preview FROM tool_events
    `).get()!;
    strictEqual(tool.input_preview, "ls");
    strictEqual(tool.output_preview, "ok");
    deepStrictEqual(
      repository.getSession("codex", id)?.turns[1].calls[0]
        .contextEventsBefore,
      [{
        type: "compaction",
        sourceOrder: 12,
        occurredAt: Date.parse("2026-07-11T14:00:07.001Z"),
      }],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM call_content
        WHERE preview LIKE '%sensitive-summary%'
      `).get()!.count,
      0,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
