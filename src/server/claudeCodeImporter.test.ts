import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncClaudeCodeSessions } from "./claudeCodeImporter.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

function write(path: string, content: string) {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  Deno.writeTextFileSync(path, content.trim());
}

Deno.test("imports a Claude Code root and namespaced child tree", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  const longPrompt = "p".repeat(2_600);
  write(
    `${project}/root.jsonl`,
    `
{"type":"user","uuid":"root-user","timestamp":"2026-07-14T10:00:00Z","cwd":"/Users/test/project","promptSource":"typed","origin":{"kind":"human"},"message":{"content":[{"type":"text","text":"${longPrompt}"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}]}}
{"type":"assistant","uuid":"root-assistant","timestamp":"2026-07-14T10:00:01Z","message":{"id":"root-call","model":"claude-opus","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"secret reasoning"},{"type":"text","text":"Calling child"},{"type":"tool_use","id":"tool-1","name":"Agent","input":{"prompt":"investigate"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"output_tokens":5}}}
{"type":"user","timestamp":"2026-07-14T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"child output"}]},"toolUseResult":{"agentId":"child"}}
{"type":"user","timestamp":"2026-07-14T10:00:03Z","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","content":"plain output"}]},"toolUseResult":"plain output"}
{"type":"system","subtype":"compact_boundary","uuid":"boundary","timestamp":"2026-07-14T10:00:04Z","content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":48059,"postTokens":5625,"cumulativeDroppedTokens":42434,"durationMs":"legacy","preservedMessages":{"uuids":["root-user","root-assistant"]}}}
{"type":"user","uuid":"summary","isCompactSummary":true,"timestamp":"2026-07-14T10:00:04Z","message":{"content":"Sensitive generated summary"}}
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
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const result = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(result.imported, 1);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count,
      2,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_branches").get()!
        .count,
      2,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_subagent_launches
      `).get()!.count,
      1,
    );
    const detail = reads.getSession("claude-code", "project/root")!;
    strictEqual(detail.title, "Indexed root");
    strictEqual(detail.workingDirectory, "/Users/test/project");
    strictEqual(detail.subagents[0].id, "child");
    strictEqual(detail.subagents[0].parentID, "project/root");
    strictEqual(detail.subagents[0].title, "Explorer child");
    strictEqual(detail.subagents[0].agent, "Explore");
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const childIdentity = db.prepare(`
      SELECT child.external_id, child.public_id
      FROM conversation_subagent_launches launch
      JOIN conversations child ON child.id = launch.child_conversation_id
    `).get() as { external_id: string; public_id: string };
    strictEqual(childIdentity.public_id, "child");
    strictEqual(
      childIdentity.external_id,
      "project/root::project/root/subagents/agent-child.jsonl",
    );
    const input = db.prepare(`
      SELECT content_preview AS preview, original_length
      FROM conversation_entries
      WHERE role = 'user' AND content_kind = 'text'
        AND original_length = 2600
    `).get()!;
    strictEqual(input.preview, longPrompt.slice(0, 2_048));
    strictEqual(input.original_length, 2_600);
    strictEqual(
      db.prepare(`
        SELECT mime_type FROM conversation_entries
        WHERE role = 'user' AND content_kind = 'image'
      `).get()!.mime_type,
      "image/png",
    );
    strictEqual(detail.turns[0].calls[0].activity.images, 1);
    strictEqual(
      db.prepare(`
        SELECT entry.content_preview FROM conversation_entries entry
        JOIN conversation_model_calls call
          ON call.id = entry.producer_model_call_id
        WHERE call.source_call_id = 'root-call' AND entry.content_kind = 'text'
      `).get()!.content_preview,
      "Calling child",
    );
    strictEqual(
      db.prepare(`
        SELECT entry.content_preview FROM conversation_entries entry
        JOIN conversation_model_calls call
          ON call.id = entry.producer_model_call_id
        WHERE call.source_call_id = 'root-call'
          AND entry.content_kind = 'reasoning'
      `).get()!.content_preview,
      null,
    );
    const tool = db.prepare(`
      SELECT input_preview, output_preview FROM conversation_tool_events
      WHERE name = 'Agent'
    `).get()!;
    strictEqual(tool.input_preview, '{"prompt":"investigate"}');
    strictEqual(tool.output_preview, "child output");
    const compactionEvent = detail.turns[1].calls[0]
      .contextEventsBefore![0];
    strictEqual(compactionEvent.type, "compaction");
    strictEqual(compactionEvent.sourceOrder, 5);
    strictEqual(
      compactionEvent.occurredAt,
      Date.parse("2026-07-14T10:00:04Z"),
    );
    strictEqual(compactionEvent.compaction?.trigger, "manual");
    strictEqual(compactionEvent.compaction?.preContextTokens, 48_059);
    strictEqual(compactionEvent.compaction?.postContextTokens, 5_625);
    strictEqual(compactionEvent.compaction?.droppedContextTokens, 42_434);
    deepStrictEqual(
      compactionEvent.compaction?.checkpointItems.map((item) => ({
        kind: item.kind,
        sourceEntryID: item.sourceEntryID,
      })),
      [
        { kind: "summary", sourceEntryID: "summary" },
        { kind: "message", sourceEntryID: "root-user" },
        { kind: "message", sourceEntryID: "root-assistant" },
      ],
    );
    deepStrictEqual(
      compactionEvent.compaction?.nativeMetadata?.captureIssues,
      ["duration-ms-invalid"],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_entries
        WHERE content_preview LIKE '%Sensitive generated summary%'
      `).get()!.count,
      0,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("imports replayed Claude compaction checkpoints", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  write(
    `${project}/replayed.jsonl`,
    `
{"type":"user","uuid":"user-1","sessionId":"replayed","timestamp":"2026-07-14T10:00:00Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"First"}}
{"type":"assistant","uuid":"assistant-1","sessionId":"replayed","timestamp":"2026-07-14T10:00:01Z","message":{"id":"call-1","model":"claude-opus","content":[{"type":"text","text":"First response"}],"usage":{"input_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":1}}}
{"type":"system","subtype":"compact_boundary","uuid":"replayed-boundary","sessionId":"replayed","timestamp":"2026-07-14T10:00:02Z","compactMetadata":{"trigger":"auto","preTokens":100,"postTokens":20}}
{"type":"user","uuid":"replayed-summary","sessionId":"replayed","isCompactSummary":true,"timestamp":"2026-07-14T10:00:02Z","message":{"content":"Summary"}}
{"type":"user","uuid":"user-2","sessionId":"replayed","timestamp":"2026-07-14T10:00:03Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Second"}}
{"type":"assistant","uuid":"assistant-2","sessionId":"replayed","timestamp":"2026-07-14T10:00:04Z","message":{"id":"call-2","model":"claude-opus","content":[{"type":"text","text":"Second response"}],"usage":{"input_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":1}}}
{"type":"system","subtype":"compact_boundary","uuid":"replayed-boundary","sessionId":"replayed","timestamp":"2026-07-14T10:00:02Z","compactMetadata":{"trigger":"auto","preTokens":100,"postTokens":20}}
{"type":"user","uuid":"replayed-summary","sessionId":"replayed","isCompactSummary":true,"timestamp":"2026-07-14T10:00:02Z","message":{"content":"Summary"}}
{"type":"user","uuid":"user-3","sessionId":"replayed","timestamp":"2026-07-14T10:00:05Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Third"}}
{"type":"assistant","uuid":"assistant-3","sessionId":"replayed","timestamp":"2026-07-14T10:00:06Z","message":{"id":"call-3","model":"claude-opus","content":[{"type":"text","text":"Third response"}],"usage":{"input_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"output_tokens":1}}}
    `,
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const result = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(result.imported, 1);
    strictEqual(result.failed, 0);

    const detail = reads.getSession("claude-code", "project/replayed")!;
    deepStrictEqual(
      detail.turns.map((turn) =>
        turn.calls[0].contextEventsBefore?.map((event) => event.sourceOrder) ??
          []
      ),
      [[], [3], [7]],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_entries
        WHERE kind = 'context-event'
      `).get()!.count,
      2,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_entry_occurrences
        WHERE source_entry_id = 'replayed-boundary'
      `).get()!.count,
      2,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM artifact_entry_occurrences")
        .get()!.count,
      8,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("projects Claude fork artifacts as one canonical conversation family", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  const parent = "00000000-0000-4000-8000-000000000001";
  const child = "00000000-0000-4000-8000-000000000002";
  const sharedUser =
    `{"type":"user","uuid":"user-shared","sessionId":"${parent}","timestamp":"2026-08-01T10:00:00Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Shared"}}`;
  const sharedAssistant =
    `{"type":"assistant","uuid":"assistant-shared","sessionId":"${parent}","session_id":"${parent}","timestamp":"2026-08-01T10:00:01Z","message":{"id":"call-shared","model":"claude-sonnet","content":[{"type":"text","text":"Shared answer"}],"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}`;
  write(
    `${project}/${parent}.jsonl`,
    `
{"type":"ai-title","sessionId":"${parent}","aiTitle":"Fork family"}
${sharedUser}
${sharedAssistant}
{"type":"user","uuid":"user-parent","sessionId":"${parent}","timestamp":"2026-08-01T10:00:02Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Parent"}}
{"type":"assistant","uuid":"assistant-parent","sessionId":"${parent}","session_id":"${parent}","timestamp":"2026-08-01T10:00:03Z","message":{"id":"call-parent","model":"claude-sonnet","content":[{"type":"text","text":"Parent answer"}],"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}
    `,
  );
  write(
    `${project}/${child}.jsonl`,
    `
{"type":"ai-title","sessionId":"${child}","aiTitle":"Fork family"}
${
      sharedUser.replaceAll(`"${parent}"`, `"${child}"`).replace(
        `"session_id":"${child}"`,
        `"session_id":"${parent}"`,
      )
    }
${
      sharedAssistant.replaceAll(
        `"sessionId":"${parent}"`,
        `"sessionId":"${child}"`,
      )
    }
{"type":"user","uuid":"user-child","sessionId":"${child}","timestamp":"2026-08-01T10:00:04Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Child"}}
{"type":"assistant","uuid":"assistant-child","sessionId":"${child}","session_id":"${child}","timestamp":"2026-08-01T10:00:05Z","message":{"id":"call-child","model":"claude-sonnet","content":[{"type":"text","text":"Child answer"}],"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}
    `,
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const result = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(result.imported, 2);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_branches").get()!
        .count,
      2,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_turns").get()!
        .count,
      3,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      3,
    );
    strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS count FROM artifact_model_call_occurrences",
      ).get()!.count,
      4,
    );
    deepStrictEqual(
      db.prepare(`
        SELECT occurrence_kind, COUNT(*) AS count
        FROM artifact_model_call_occurrences
        GROUP BY occurrence_kind ORDER BY occurrence_kind
      `).all().map((row) => ({ ...row })),
      [
        { occurrence_kind: "copied", count: 1 },
        { occurrence_kind: "executed", count: 3 },
      ],
    );
    strictEqual(
      db.prepare("SELECT model_calls FROM conversation_rollups").get()!
        .model_calls,
      3,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_branches
        WHERE forked_from_branch_id IS NOT NULL
          AND fork_point_provenance = 'inferred-confirmed'
      `).get()!.count,
      1,
    );
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository, conversations))
        .skipped,
      2,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("extends a copied Claude turn continued by a descendant", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  const parent = "00000000-0000-4000-8000-000000000011";
  const child = "00000000-0000-4000-8000-000000000012";
  const sharedUser =
    `{"type":"user","uuid":"shared-user","sessionId":"${parent}","timestamp":"2026-08-01T10:00:00Z","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"Continue this turn"}}`;
  const sharedCall =
    `{"type":"assistant","uuid":"shared-assistant","sessionId":"${parent}","session_id":"${parent}","timestamp":"2026-08-01T10:00:01Z","message":{"id":"shared-call","model":"claude-sonnet","content":[{"type":"text","text":"First response"}],"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}`;
  write(
    `${project}/${parent}.jsonl`,
    `
{"type":"ai-title","sessionId":"${parent}","aiTitle":"Background handoff"}
${sharedUser}
${sharedCall}
    `,
  );
  write(
    `${project}/${child}.jsonl`,
    `
{"type":"ai-title","sessionId":"${child}","aiTitle":"Background handoff"}
${sharedUser.replaceAll(`"${parent}"`, `"${child}"`)}
${sharedCall.replace(`"sessionId":"${parent}"`, `"sessionId":"${child}"`)}
{"type":"assistant","uuid":"continued-assistant","sessionId":"${child}","session_id":"${child}","timestamp":"2026-08-01T10:00:02Z","message":{"id":"continued-call","model":"claude-sonnet","content":[{"type":"text","text":"Continued in background"}],"usage":{"input_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4}}}
    `,
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const result = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(result.imported, 2);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_turns").get()!
        .count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      2,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_entries").get()!
        .count,
      3,
    );
    strictEqual(
      db.prepare("SELECT model_calls FROM conversation_rollups").get()!
        .model_calls,
      2,
    );
    deepStrictEqual(
      db.prepare(`
        SELECT occurrence_kind, COUNT(*) AS count
        FROM artifact_model_call_occurrences
        GROUP BY occurrence_kind ORDER BY occurrence_kind
      `).all().map((row) => ({ ...row })),
      [
        { occurrence_kind: "copied", count: 1 },
        { occurrence_kind: "executed", count: 2 },
      ],
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Claude lineage changes rebuild both the prior and new families", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/projects`;
  const project = `${sessions}/project`;
  const metadata = (id: string, origin: string) =>
    JSON.stringify({
      type: "ai-title",
      sessionId: id,
      session_id: origin,
      aiTitle: id,
    });
  write(`${project}/root-a.jsonl`, metadata("root-a", "root-a"));
  write(`${project}/root-b.jsonl`, metadata("root-b", "root-b"));
  const childPath = `${project}/child.jsonl`;
  const child = (parentID: string) =>
    `${metadata("child", parentID)}\n${metadata("child", "child")}`;
  write(childPath, child("root-a"));

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const initial = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(initial.imported, 3);
    deepStrictEqual(
      db.prepare(`
        SELECT conversation.external_id AS conversation_id,
          branch.external_id AS branch_id
        FROM conversation_branches AS branch
        JOIN conversations AS conversation ON conversation.id = branch.conversation_id
        ORDER BY conversation.external_id, branch.external_id
      `).all().map((row) => ({ ...row })),
      [
        { conversation_id: "root-a", branch_id: "child" },
        { conversation_id: "root-a", branch_id: "root-a" },
        { conversation_id: "root-b", branch_id: "root-b" },
      ],
    );

    write(childPath, child("root-b"));
    const changedAt = new Date(Date.now() + 2_000);
    Deno.utimeSync(childPath, changedAt, changedAt);
    const moved = await syncClaudeCodeSessions(
      sessions,
      repository,
      conversations,
    );
    strictEqual(moved.imported, 3);
    deepStrictEqual(
      db.prepare(`
        SELECT conversation.external_id AS conversation_id,
          branch.external_id AS branch_id
        FROM conversation_branches AS branch
        JOIN conversations AS conversation ON conversation.id = branch.conversation_id
        ORDER BY conversation.external_id, branch.external_id
      `).all().map((row) => ({ ...row })),
      [
        { conversation_id: "root-a", branch_id: "root-a" },
        { conversation_id: "root-b", branch_id: "child" },
        { conversation_id: "root-b", branch_id: "root-b" },
      ],
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
  const repository = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository, conversations))
        .imported,
      1,
    );
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository, conversations))
        .skipped,
      1,
    );

    write(
      indexPath,
      '{"entries":[{"sessionId":"root","summary":"Changed title"}]}',
    );
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository, conversations))
        .imported,
      1,
    );
    strictEqual(
      reads.getSession("claude-code", "project/root")?.title,
      "Changed title",
    );

    write(metaPath, '{"description":"Changed child description"}');
    strictEqual(
      (await syncClaudeCodeSessions(sessions, repository, conversations))
        .imported,
      1,
    );
    strictEqual(
      reads.getSession("claude-code", "project/root")?.subagents[0].title,
      "Changed child description",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
