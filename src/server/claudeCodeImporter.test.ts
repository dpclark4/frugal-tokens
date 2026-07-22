import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncClaudeCodeSessions } from "./claudeCodeImporter.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SessionRepository } from "./sessionRepository.ts";

function write(path: string, content: string) {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  Deno.writeTextFileSync(path, content.trim());
}

Deno.test("imports a Claude Code root and namespaced child tree", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  const longPrompt = "p".repeat(600);
  write(
    `${project}/root.jsonl`,
    `
{"type":"user","timestamp":"2026-07-14T10:00:00Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":[{"type":"text","text":"${longPrompt}"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}]}}
{"type":"assistant","timestamp":"2026-07-14T10:00:01Z","message":{"id":"root-call","model":"claude-opus","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"secret reasoning"},{"type":"text","text":"Calling child"},{"type":"tool_use","id":"tool-1","name":"Agent","input":{"prompt":"investigate"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"output_tokens":5}}}
{"type":"user","timestamp":"2026-07-14T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"child output"}]},"toolUseResult":{"agentId":"child"}}
{"type":"user","timestamp":"2026-07-14T10:00:03Z","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","content":"plain output"}]},"toolUseResult":"plain output"}
{"type":"system","subtype":"compact_boundary","timestamp":"2026-07-14T10:00:04Z","content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":48059,"postTokens":5625}}
{"type":"user","timestamp":"2026-07-14T10:00:04Z","message":{"content":"Sensitive generated summary"}}
{"type":"user","timestamp":"2026-07-14T10:00:05Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Continue"}}
{"type":"assistant","timestamp":"2026-07-14T10:00:06Z","message":{"id":"post-compact-call","model":"claude-opus","stop_reason":"end_turn","content":[{"type":"text","text":"Continued"}],"usage":{"input_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":8,"output_tokens":5}}}
  `,
  );
  write(
    `${project}/root/subagents/agent-child.jsonl`,
    `
{"type":"user","timestamp":"2026-07-14T10:00:01Z","isSidechain":true,"message":{"content":"Investigate"}}
{"type":"assistant","timestamp":"2026-07-14T10:00:02Z","message":{"id":"child-call","model":"claude-sonnet","content":[{"type":"text","text":"Child answer"}],"usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}
  `,
  );
  write(
    `${project}/root/subagents/agent-child.meta.json`,
    JSON.stringify({
      description: "Explorer child",
      agentType: "Explore",
    }),
  );
  write(
    `${project}/sessions-index.json`,
    JSON.stringify({
      entries: [{ sessionId: "root", summary: "Indexed root" }],
    }),
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const result = await syncClaudeCodeSessions(sessions, repository);
    strictEqual(result.imported, 1);
    const detail = repository.getSession("claude-code", "project/root")!;
    strictEqual(detail.title, "Indexed root");
    strictEqual(detail.subagents[0].id, "child");
    strictEqual(detail.subagents[0].parentID, "project/root");
    strictEqual(detail.subagents[0].title, "Explorer child");
    strictEqual(detail.subagents[0].agent, "Explore");
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    const childIdentity = db.prepare(`
      SELECT external_id, public_id FROM source_sessions WHERE parent_id IS NOT NULL
    `).get() as { external_id: string; public_id: string };
    strictEqual(childIdentity.public_id, "child");
    strictEqual(
      childIdentity.external_id,
      "project/root::project/root/subagents/agent-child.jsonl",
    );
    const input = db.prepare(`
      SELECT preview, original_length FROM turn_inputs WHERE kind = 'text'
    `).get()!;
    strictEqual(input.preview, longPrompt.slice(0, 512));
    strictEqual(input.original_length, 600);
    strictEqual(
      db.prepare(`
        SELECT mime_type FROM turn_inputs WHERE kind = 'image'
      `).get()!.mime_type,
      "image/png",
    );
    strictEqual(detail.turns[0].calls[0].activity.images, 1);
    strictEqual(
      db.prepare("SELECT preview FROM call_content WHERE kind = 'text'").get()!
        .preview,
      "Calling child",
    );
    strictEqual(
      db.prepare("SELECT preview FROM call_content WHERE kind = 'reasoning'")
        .get()!.preview,
      null,
    );
    const tool = db.prepare(`
      SELECT input_preview, output_preview FROM tool_events WHERE name = 'Agent'
    `).get()!;
    strictEqual(tool.input_preview, '{"prompt":"investigate"}');
    strictEqual(tool.output_preview, "child output");
    deepStrictEqual(detail.turns[1].calls[0].contextEventsBefore, [{
      type: "compaction",
      sourceOrder: 5,
      occurredAt: Date.parse("2026-07-14T10:00:04Z"),
    }]);
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM turn_inputs
        WHERE preview LIKE '%Sensitive generated summary%'
      `).get()!.count,
      0,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("skips unchanged Claude trees and reimports index and agent metadata changes", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  write(
    `${project}/root.jsonl`,
    `
{"type":"user","timestamp":"2026-07-14T10:00:00Z","promptSource":"typed","message":{"content":"Root"}}
{"type":"assistant","timestamp":"2026-07-14T10:00:01Z","message":{"id":"call","model":"claude-sonnet","content":[{"type":"text","text":"Done"}],"usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}
  `,
  );
  write(
    `${project}/root/subagents/agent-child.jsonl`,
    `
{"type":"user","timestamp":"2026-07-14T10:00:00Z","isSidechain":true,"message":{"content":"Child"}}
{"type":"assistant","timestamp":"2026-07-14T10:00:01Z","message":{"id":"child-call","model":"claude-sonnet","content":[{"type":"text","text":"Done"}],"usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}
  `,
  );
  const metaPath = `${project}/root/subagents/agent-child.meta.json`;
  const indexPath = `${project}/sessions-index.json`;
  write(metaPath, '{"description":"First child"}');
  write(
    indexPath,
    '{"entries":[{"sessionId":"root","summary":"First title"}]}',
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository)).imported,
      1,
    );
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository)).skipped,
      1,
    );

    write(
      indexPath,
      '{"entries":[{"sessionId":"root","summary":"Changed title"}]}',
    );
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository)).imported,
      1,
    );
    strictEqual(
      repository.getSession("claude-code", "project/root")?.title,
      "Changed title",
    );

    write(metaPath, '{"description":"Changed child description"}');
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository)).imported,
      1,
    );
    strictEqual(
      repository.getSession("claude-code", "project/root")?.subagents[0].title,
      "Changed child description",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
