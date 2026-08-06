import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncCodexSessions } from "./codexImporter.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { analyzeSessionCache } from "./cacheAnalysis.ts";
import { priceSessionDetail } from "./pricing.ts";
import { contextRange } from "../shared/contextMetrics.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";
import {
  assertConversationCompatibilityParity,
  assertLinearConversationParity,
} from "./conversationProjectionTestUtils.ts";

const transcript = `
{"id":"session","timestamp":"2026-07-11T13:59:59.000Z","instructions":null,"git":null}
{"timestamp":"2026-07-11T13:59:59.000Z","type":"session_meta","payload":{"cwd":"/Users/test/project"}}
{"timestamp":"2026-07-11T13:59:59.000Z","type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"ignored"}}
{"timestamp":"2026-07-11T13:59:59.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}
{"timestamp":"2026-07-11T14:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","effort":"medium"}}
{"timestamp":"2026-07-11T14:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Import Codex"}]}}
{"timestamp":"2026-07-11T14:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec_command","input":"ls"}}
{"timestamp":"2026-07-11T14:00:04.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"}}
{"timestamp":"2026-07-11T14:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Imported"}]}}
{"timestamp":"2026-07-11T14:00:06.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":10,"reasoning_output_tokens":2}}}}
{"timestamp":"2026-07-11T14:00:06.500Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:06.900Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":4291}}}}
{"timestamp":"2026-07-11T14:00:07.000Z","type":"compacted","payload":{"message":"","window_id":"window-2","window_number":1,"replacement_history":[{"type":"message","id":"developer-1","role":"developer","content":[{"type":"input_text","text":"Runtime instructions"}]},"legacy-item",{"type":"compaction","id":"cmp-1","encrypted_content":"sensitive-summary"}]}}
{"timestamp":"2026-07-11T14:00:07.001Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-07-11T14:00:07.500Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","thread_settings":{"collaboration_mode":{"settings":{"reasoning_effort":"low"}}}}}
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
  const conversations = new ConversationProjectionRepository(db);
  try {
    const result = await syncCodexSessions(sessions, repository, conversations);
    strictEqual(result.imported, 1);
    strictEqual(result.projectionResults["conversation-v2"].imported, 1);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_branches").get()!
        .count,
      1,
    );

    assertLinearConversationParity(db, "codex");
    assertConversationCompatibilityParity(db, repository, "codex", "2026/07/11/rollout-session");

    const id = "2026/07/11/rollout-session";
    strictEqual(repository.listSessions(1, 10, "codex").items[0].id, id);
    const detail = repository.getSession("codex", id)!;
    strictEqual(detail.title, "Import Codex");
    strictEqual(detail.workingDirectory, "/Users/test/project");
    // Canonical storage retains the opaque operation, but session reads and
    // usage analytics hide explicitly tagged compaction machinery.
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
    const compactionEvent = detail.turns[1].calls[0]
      .contextEventsBefore![0];
    strictEqual(compactionEvent.type, "compaction");
    strictEqual(compactionEvent.sourceOrder, 15);
    strictEqual(
      compactionEvent.occurredAt,
      Date.parse("2026-07-11T14:00:07.001Z"),
    );
    strictEqual(
      compactionEvent.compaction?.resultKind,
      "encrypted-checkpoint",
    );
    strictEqual(compactionEvent.compaction?.checkpointCompleteness, "partial");
    deepStrictEqual(
      compactionEvent.compaction?.checkpointItems.map((item) => ({
        kind: item.kind,
        sourceEntryID: item.sourceEntryID,
        availability: item.contentAvailability,
      })),
      [
        {
          kind: "developer-message",
          sourceEntryID: "developer-1",
          availability: "plaintext",
        },
        {
          kind: "opaque-checkpoint",
          sourceEntryID: "cmp-1",
          availability: "encrypted",
        },
      ],
    );
    deepStrictEqual(
      compactionEvent.compaction?.nativeMetadata?.captureIssues,
      ["replacement-item-not-object"],
    );
    strictEqual(
      (db.prepare("SELECT COUNT(*) AS count FROM turns").get() as {
        count: number;
      }).count,
      3,
    );
    strictEqual(
      db.prepare(`
        SELECT source_call_id FROM model_calls
        WHERE source_call_id LIKE 'context-operation:%'
      `).get()!.source_call_id,
      "context-operation:2-1",
    );
    strictEqual(detail.turns.length, 2);
    strictEqual(detail.userTurns, 2);
    strictEqual(detail.modelCalls, 2);
    strictEqual(detail.turns[0].calls[0].id, "1-1");
    strictEqual(detail.turns[1].calls[0].id, "3-1");
    strictEqual(detail.turns[0].reasoningSetting?.settingValue, "medium");
    strictEqual(
      detail.turns[0].calls[0].reasoningSetting?.sourceFieldPath,
      "payload.effort",
    );
    strictEqual(detail.turns[1].reasoningSetting?.settingValue, "low");
    strictEqual(
      detail.turns[1].calls[0].reasoningSetting?.sourceFieldPath,
      "payload.thread_settings.collaboration_mode.settings.reasoning_effort",
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM reasoning_setting_events")
        .get()!.count,
      2,
    );

    const priced = priceSessionDetail(detail);
    strictEqual(
      priced.computedCost,
      priced.turns[0].calls[0].computedCost! +
        priced.turns[1].calls[0].computedCost!,
    );
    const context = contextRange(priced.turns.flatMap((turn) => turn.calls));
    strictEqual(context.latest?.size, 90);

    const analyzed = analyzeSessionCache(priced);
    strictEqual(analyzed.turns[1].calls[0].cacheAssessment?.status, "partial-hit");
    strictEqual(analyzed.turns[1].calls[0].cacheAssessment?.cause, "compaction");
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM call_content
        WHERE preview LIKE '%sensitive-summary%'
      `).get()!.count,
      0,
    );
    const parity = db.prepare(`
      SELECT s.user_turns AS legacy_turns, s.model_calls AS legacy_calls,
        s.processed_tokens AS legacy_tokens,
        cr.user_turns AS v2_turns, cr.model_calls AS v2_calls,
        cr.processed_tokens AS v2_tokens
      FROM sessions s
      JOIN source_sessions ss ON ss.id = s.source_session_id
      JOIN conversations c
        ON c.source_id = ss.source_id AND c.external_id = ss.external_id
      JOIN conversation_rollups cr ON cr.conversation_id = c.id
    `).get()!;
    deepStrictEqual({ ...parity }, {
      legacy_turns: 3,
      legacy_calls: 3,
      legacy_tokens: 4501,
      v2_turns: 3,
      v2_calls: 3,
      v2_tokens: 4501,
    });

    const unchanged = await syncCodexSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(unchanged.skipped, 1);
    strictEqual(unchanged.projectionResults["conversation-v2"].skipped, 1);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      3,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
