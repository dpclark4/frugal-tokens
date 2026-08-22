import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncCodexSessions } from "./codexImporter.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import { analyzeSessionCache } from "./cacheAnalysis.ts";
import { priceSessionDetail } from "./pricing.ts";
import { contextRange } from "../shared/contextMetrics.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

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
{"timestamp":"2026-07-11T14:00:06.500Z","type":"event_msg","payload":{"type":"task_started","turn_id":"compaction-turn"}}
{"timestamp":"2026-07-11T14:00:06.900Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":4291}}}}
{"timestamp":"2026-07-11T14:00:07.000Z","type":"compacted","payload":{"message":"","window_id":"window-2","window_number":1,"replacement_history":[{"type":"message","id":"developer-1","role":"developer","content":[{"type":"input_text","text":"Runtime instructions"}]},"legacy-item",{"type":"compaction","id":"cmp-1","encrypted_content":"sensitive-summary"}]}}
{"timestamp":"2026-07-11T14:00:07.001Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-07-11T14:00:07.500Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","thread_settings":{"collaboration_mode":{"settings":{"reasoning_effort":"low"}}}}}
{"timestamp":"2026-07-11T14:00:08.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:09.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Continue"}]}}
{"timestamp":"2026-07-11T14:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Continued"}]}}
{"timestamp":"2026-07-11T14:00:11.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":90,"cached_input_tokens":20,"output_tokens":8,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-11T14:00:12.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:13.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Later turn"}]}}
{"timestamp":"2026-07-11T14:00:14.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Later response"}]}}
{"timestamp":"2026-07-11T14:00:15.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":9,"reasoning_output_tokens":0}}}}
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
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const result = await syncCodexSessions(sessions, repository, conversations);
    strictEqual(result.imported, 1);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_branches").get()!
        .count,
      1,
    );

    const id = "2026/07/11/rollout-session";
    strictEqual(reads.listSessions(1, 10, "codex").items[0].id, id);
    const detail = reads.getSession("codex", id)!;
    strictEqual(detail.title, "Import Codex");
    strictEqual(detail.workingDirectory, "/Users/test/project");
    strictEqual(reads.listUsageCalls(undefined, "codex").length, 3);
    strictEqual(
      db.prepare(`
        SELECT content_preview FROM conversation_entries
        WHERE producer_model_call_id IS NOT NULL AND content_kind = 'text'
        ORDER BY id LIMIT 1
      `).get()!.content_preview,
      "Imported",
    );
    const tool = db.prepare(`
      SELECT input_preview, output_preview FROM conversation_tool_events
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
      db.prepare("SELECT COUNT(*) AS count FROM conversation_turns").get()!
        .count,
      4,
    );
    strictEqual(
      db.prepare(`
        SELECT source_call_id FROM conversation_model_calls
        WHERE source_call_id LIKE 'context-operation:%'
      `).get()!.source_call_id,
      "context-operation:compaction-turn:call:1",
    );
    strictEqual(detail.turns.length, 3);
    strictEqual(detail.userTurns, 3);
    strictEqual(detail.modelCalls, 3);
    strictEqual(detail.turns[0].calls[0].id, "1-1");
    strictEqual(detail.turns[1].calls[0].id, "3-1");
    strictEqual(detail.turns[2].calls[0].id, "4-1");
    deepStrictEqual(detail.turns[2].calls[0].contextEventsBefore, []);
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
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_model_calls
        WHERE reasoning_setting_value IS NOT NULL
          AND source_call_id NOT LIKE 'context-operation:%'
      `).get()!.count,
      3,
    );

    const priced = priceSessionDetail(detail);
    strictEqual(
      priced.computedCost,
      priced.turns[0].calls[0].computedCost! +
        priced.turns[1].calls[0].computedCost! +
        priced.turns[2].calls[0].computedCost!,
    );
    const context = contextRange(priced.turns.flatMap((turn) => turn.calls));
    strictEqual(context.latest?.size, 100);

    const analyzed = analyzeSessionCache(priced);
    strictEqual(
      analyzed.turns[1].calls[0].cacheAssessment?.status,
      "partial-hit",
    );
    strictEqual(
      analyzed.turns[1].calls[0].cacheAssessment?.cause,
      "compaction",
    );
    strictEqual(
      db.prepare(`
        SELECT cause FROM conversation_cache_misses
        WHERE conversation_id = (
          SELECT id FROM conversations WHERE external_id = ?
        )
      `).get(id)!.cause,
      "compaction",
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_entries
        WHERE content_preview LIKE '%sensitive-summary%'
      `).get()!.count,
      0,
    );
    const unchanged = await syncCodexSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(unchanged.skipped, 1);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      4,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
