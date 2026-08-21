import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { syncCodexSessions } from "./codexImporter.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";

function fixturePath(name: string) {
  return decodeURIComponent(
    new URL(`./fixtures/codex-branching/${name}/`, import.meta.url).pathname,
  );
}

function count(db: ReturnType<typeof openArchiveDatabase>, table: string) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
  );
}

function copyFixture(name: string, destination: string, files?: string[]) {
  Deno.mkdirSync(destination, { recursive: true });
  for (const entry of Deno.readDirSync(fixturePath(name))) {
    if (!entry.isFile || (files !== undefined && !files.includes(entry.name))) {
      continue;
    }
    Deno.copyFileSync(
      `${fixturePath(name)}${entry.name}`,
      `${destination}/${entry.name}`,
    );
  }
}

function rewriteFirstRecord(
  path: string,
  update: (record: Record<string, unknown>) => void,
) {
  const lines = Deno.readTextFileSync(path).trim().split("\n");
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  update(first);
  lines[0] = JSON.stringify(first);
  Deno.writeTextFileSync(path, `${lines.join("\n")}\n`);
  const changedAt = new Date(Date.now() + 2_000);
  Deno.utimeSync(path, changedAt, changedAt);
}

function writeJsonl(path: string, records: unknown[]) {
  Deno.writeTextFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

Deno.test("Codex sibling artifacts project one canonical conversation family", async () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const first = await syncCodexSessions(
      fixturePath("sibling-forks"),
      sessions,
      conversations,
    );
    strictEqual(first.imported, 3);
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_branches"), 3);
    strictEqual(count(db, "conversation_turns"), 7);
    strictEqual(count(db, "conversation_model_calls"), 7);
    strictEqual(count(db, "artifact_model_call_occurrences"), 13);
    strictEqual(count(db, "conversation_subagent_launches"), 0);
    deepStrictEqual(
      db.prepare(`
        SELECT occurrence_kind, COUNT(*) AS count
        FROM artifact_model_call_occurrences
        GROUP BY occurrence_kind ORDER BY occurrence_kind
      `).all().map((row) => ({ ...row })),
      [
        { occurrence_kind: "copied", count: 6 },
        { occurrence_kind: "executed", count: 7 },
      ],
    );
    deepStrictEqual(
      {
        ...db.prepare(`
        SELECT user_turns, model_calls FROM conversation_rollups
      `).get()!,
      },
      { user_turns: 7, model_calls: 7 },
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_branches
        WHERE forked_from_branch_id IS NOT NULL
          AND fork_point_entry_id IS NOT NULL
          AND fork_point_provenance = 'inferred-confirmed'
      `).get()!.count,
      2,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_model_calls AS call
        JOIN artifact_model_call_occurrences AS occurrence
          ON occurrence.model_call_id = call.id
        WHERE call.source_call_id = 'response-shared-1'
      `).get()!.count,
      3,
    );
    strictEqual(count(db, "conversation_tool_events"), 1);
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_entries
        WHERE stable_source_id = 'window-original-1'
      `).get()!.count,
      1,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM artifact_entry_occurrences AS occurrence
        JOIN conversation_entries AS entry ON entry.id = occurrence.entry_id
        WHERE entry.stable_source_id = 'window-original-1'
      `).get()!.count,
      2,
    );

    const conversationID = db.prepare("SELECT id FROM conversations").get()!.id;
    const unchanged = await syncCodexSessions(
      fixturePath("sibling-forks"),
      sessions,
      conversations,
    );
    strictEqual(unchanged.skipped, 3);
    strictEqual(
      db.prepare("SELECT id FROM conversations").get()!.id,
      conversationID,
    );
    strictEqual(count(db, "conversation_model_calls"), 7);
  } finally {
    db.close();
  }
});

Deno.test("Codex rewind with a queued prompt projects as one branched conversation", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source, { recursive: true });
  const metadata = (id: string, forkedFrom?: string) => ({
    timestamp: "2026-08-06T23:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      cwd: "/workspace/project",
      ...(forkedFrom === undefined ? {} : { forked_from_id: forkedFrom }),
    },
  });
  const task = (id: string, second: number) => ({
    timestamp: `2026-08-06T23:00:0${second}.000Z`,
    type: "event_msg",
    payload: { type: "task_started", turn_id: id, started_at: second },
  });
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    second: number,
  ) => ({
    timestamp: `2026-08-06T23:00:0${second}.100Z`,
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{
        type: role === "user" ? "input_text" : "output_text",
        text,
      }],
    },
  });
  const usage = (second: number) => ({
    timestamp: `2026-08-06T23:00:0${second}.200Z`,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
  const rootID = "rewind-root";
  const childID = "rewind-child";
  const shared = [
    task("shared-turn-1", 1),
    message("shared-user-1", "user", "1", 1),
    message("shared-response-1", "assistant", "one", 1),
    usage(1),
    // Codex can queue this prompt without emitting another task_started.
    message("shared-user-2", "user", "2", 2),
    message("shared-response-2", "assistant", "two", 2),
    usage(2),
  ];
  writeJsonl(`${source}/rollout-root.jsonl`, [
    metadata(rootID),
    { type: "turn_context", payload: { model: "gpt-test-codex" } },
    ...shared,
    task("root-turn-3", 3),
    message("root-user-3", "user", "3", 3),
    message("root-response-3", "assistant", "three", 3),
    usage(3),
  ]);
  writeJsonl(`${source}/rollout-child.jsonl`, [
    metadata(childID, rootID),
    // A rewind artifact includes the copied parent's metadata after its own.
    metadata(rootID),
    { type: "turn_context", payload: { model: "gpt-test-codex" } },
    ...shared,
    task("child-turn-3", 4),
    message("child-user-3", "user", "3'", 4),
    message("child-response-3", "assistant", "three prime", 4),
    usage(4),
  ]);

  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const result = await syncCodexSessions(source, sessions, conversations);
    strictEqual(result.failed, 0);
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_turns"), 4);
    strictEqual(count(db, "conversation_model_calls"), 4);
    strictEqual(count(db, "artifact_model_call_occurrences"), 6);
    strictEqual(
      new ConversationRepository(db).listSessions(
        1,
        10,
        "codex",
      ).items.length,
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test("Codex nested artifacts resolve recursive branch ancestry", async () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    await syncCodexSessions(
      fixturePath("nested-fork"),
      sessions,
      conversations,
    );
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_branches"), 3);
    strictEqual(count(db, "conversation_turns"), 3);
    strictEqual(count(db, "conversation_model_calls"), 3);
    strictEqual(count(db, "artifact_model_call_occurrences"), 6);
    deepStrictEqual(
      db.prepare(`
        SELECT occurrence_kind, COUNT(*) AS count
        FROM artifact_model_call_occurrences
        GROUP BY occurrence_kind ORDER BY occurrence_kind
      `).all().map((row) => ({ ...row })),
      [
        { occurrence_kind: "copied", count: 3 },
        { occurrence_kind: "executed", count: 3 },
      ],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_branches AS child
        JOIN conversation_branches AS parent
          ON parent.id = child.forked_from_branch_id
        WHERE child.external_id = '00000000-0000-4000-8000-000000000103'
          AND parent.external_id = '00000000-0000-4000-8000-000000000102'
      `).get()!.count,
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test("Codex family rebuilds for late, missing, and reappearing parents", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  copyFixture("nested-fork", source, ["rollout-child.jsonl"]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const provisional = await syncCodexSessions(
      source,
      sessions,
      conversations,
    );
    strictEqual(provisional.imported, 1);
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_branches"), 1);
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_model_call_occurrences
        WHERE occurrence_kind = 'unknown'
      `).get()!.count,
      2,
    );

    copyFixture("nested-fork", source, ["rollout-root.jsonl"]);
    const resolved = await syncCodexSessions(source, sessions, conversations);
    strictEqual(resolved.imported, 2);
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_model_calls"), 2);
    strictEqual(count(db, "artifact_model_call_occurrences"), 3);
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
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM source_artifact_lineage
        WHERE parent_source_session_id IS NOT NULL
      `).get()!.count,
      1,
    );

    const rootPath = `${source}/rollout-root.jsonl`;
    Deno.removeSync(rootPath);
    const beforeMissing = db.prepare("SELECT id FROM conversations").get()!.id;
    const missing = await syncCodexSessions(source, sessions, conversations);
    strictEqual(missing.skipped, 1);
    strictEqual(
      db.prepare("SELECT id FROM conversations").get()!.id,
      beforeMissing,
    );
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(
      db.prepare(`
        SELECT availability FROM source_sessions
        WHERE external_id = 'rollout-root'
      `).get()!.availability,
      "missing",
    );

    copyFixture("nested-fork", source, ["rollout-root.jsonl"]);
    const reappeared = await syncCodexSessions(source, sessions, conversations);
    strictEqual(reappeared.imported, 2);
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_model_calls"), 2);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex parent append rebuilds the complete family once", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  copyFixture("sibling-forks", source);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    await syncCodexSessions(source, sessions, conversations);
    const original = `${source}/rollout-original.jsonl`;
    Deno.writeTextFileSync(
      original,
      `${Deno.readTextFileSync(original).trim()}\n` +
        `{"timestamp":"2026-01-01T10:04:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-original-5","started_at":1767261841}}\n` +
        `{"timestamp":"2026-01-01T10:04:01.100Z","type":"response_item","payload":{"type":"message","id":"message-user-original-5","role":"user","content":[{"type":"input_text","text":"Original five"}]}}\n` +
        `{"timestamp":"2026-01-01T10:04:01.200Z","type":"response_item","payload":{"type":"message","id":"response-original-5","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Original answer five"}]}}\n` +
        `{"timestamp":"2026-01-01T10:04:01.300Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":95,"cached_input_tokens":25,"output_tokens":9,"reasoning_output_tokens":0}}}}\n`,
    );
    const changedAt = new Date(Date.now() + 2_000);
    Deno.utimeSync(original, changedAt, changedAt);
    const result = await syncCodexSessions(source, sessions, conversations);
    strictEqual(result.imported, 3);
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_turns"), 8);
    strictEqual(count(db, "conversation_model_calls"), 8);
    strictEqual(count(db, "artifact_model_call_occurrences"), 14);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex new children rebuild only their connected family", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  copyFixture("sibling-forks", source, ["rollout-original.jsonl"]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    await syncCodexSessions(source, sessions, conversations);
    strictEqual(count(db, "conversation_model_calls"), 4);

    copyFixture("sibling-forks", source, ["rollout-fork-a.jsonl"]);
    const firstChild = await syncCodexSessions(source, sessions, conversations);
    strictEqual(firstChild.imported, 2);
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_model_calls"), 6);
    strictEqual(count(db, "artifact_model_call_occurrences"), 8);

    copyFixture("sibling-forks", source, ["rollout-fork-b.jsonl"]);
    const secondChild = await syncCodexSessions(
      source,
      sessions,
      conversations,
    );
    strictEqual(secondChild.imported, 3);
    strictEqual(count(db, "conversation_branches"), 3);
    strictEqual(count(db, "conversation_model_calls"), 7);
    strictEqual(count(db, "artifact_model_call_occurrences"), 13);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex lineage changes rebuild both the prior and new families", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source);
  const sessionMeta = (id: string, parentID?: string) => ({
    timestamp: "2026-04-01T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      cwd: "/workspace/project",
      ...(parentID === undefined ? {} : { forked_from_id: parentID }),
    },
  });
  writeJsonl(`${source}/rollout-root-a.jsonl`, [sessionMeta("root-a")]);
  writeJsonl(`${source}/rollout-root-b.jsonl`, [sessionMeta("root-b")]);
  const childPath = `${source}/rollout-child.jsonl`;
  writeJsonl(childPath, [sessionMeta("child", "root-a")]);

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  try {
    const initial = await syncCodexSessions(source, sessions, conversations);
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

    writeJsonl(childPath, [sessionMeta("child", "root-b")]);
    const changedAt = new Date(Date.now() + 2_000);
    Deno.utimeSync(childPath, changedAt, changedAt);
    const moved = await syncCodexSessions(source, sessions, conversations);
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

Deno.test("Codex ancestry cycle failure preserves the last good family", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  copyFixture("nested-fork", source, [
    "rollout-root.jsonl",
    "rollout-child.jsonl",
  ]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const rootPath = `${source}/rollout-root.jsonl`;
  const originalRoot = Deno.readTextFileSync(rootPath);
  try {
    await syncCodexSessions(source, sessions, conversations);
    const conversationID = db.prepare("SELECT id FROM conversations").get()!.id;
    rewriteFirstRecord(rootPath, (record) => {
      const payload = record.payload as Record<string, unknown>;
      payload.forked_from_id = "00000000-0000-4000-8000-000000000102";
    });
    const failed = await syncCodexSessions(source, sessions, conversations);
    strictEqual(failed.failed, 2);
    strictEqual(
      db.prepare("SELECT id FROM conversations").get()!.id,
      conversationID,
    );
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_model_calls"), 2);

    Deno.writeTextFileSync(rootPath, originalRoot);
    const changedAt = new Date(Date.now() + 4_000);
    Deno.utimeSync(rootPath, changedAt, changedAt);
    const recovered = await syncCodexSessions(source, sessions, conversations);
    strictEqual(recovered.imported, 2);
    strictEqual(count(db, "conversation_branches"), 2);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex transactional replacement retains the prior canonical family", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  copyFixture("nested-fork", source, [
    "rollout-root.jsonl",
    "rollout-child.jsonl",
  ]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sessions = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const childPath = `${source}/rollout-child.jsonl`;
  try {
    await syncCodexSessions(source, sessions, conversations);
    const conversationID = db.prepare("SELECT id FROM conversations").get()!.id;
    const records = Deno.readTextFileSync(childPath).trim().split("\n").map(
      (line) =>
        JSON.parse(line) as {
          payload?: { id?: string; content?: Array<Record<string, unknown>> };
        },
    );
    const sharedResponse = records.find((record) =>
      record.payload?.id === "response-nested-root-1"
    )!;
    sharedResponse.payload!.content!.push({
      type: "output_text",
      text: "Conflicting copied shape",
    });
    writeJsonl(childPath, records);
    const changedAt = new Date(Date.now() + 2_000);
    Deno.utimeSync(childPath, changedAt, changedAt);

    const failed = await syncCodexSessions(source, sessions, conversations);
    strictEqual(failed.failed, 2);
    strictEqual(
      db.prepare("SELECT id FROM conversations").get()!.id,
      conversationID,
    );
    strictEqual(count(db, "conversation_branches"), 2);
    strictEqual(count(db, "conversation_model_calls"), 2);
    strictEqual(count(db, "artifact_model_call_occurrences"), 3);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex copies a complete multi-call tool turn without re-executing it", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source);
  const pathRecords = [
    {
      timestamp: "2026-03-01T10:00:00.100Z",
      type: "turn_context",
      payload: { model: "gpt-test-codex" },
    },
    {
      timestamp: "2026-03-01T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-multi",
        started_at: 1772359201,
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "message-user-multi",
        role: "user",
        content: [{ type: "input_text", text: "Use a tool" }],
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.200Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "tool-request-multi",
        call_id: "tool-multi",
        name: "read_file",
        input: "fixture.txt",
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.300Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        id: "tool-output-multi",
        call_id: "tool-multi",
        output: "fixture",
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.400Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 40,
            cached_input_tokens: 0,
            output_tokens: 4,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.500Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "response-multi-final",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Done" }],
      },
    },
    {
      timestamp: "2026-03-01T10:00:01.600Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 20,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
  ];
  writeJsonl(`${source}/rollout-root.jsonl`, [{
    timestamp: "2026-03-01T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "multi-root", cwd: "/workspace/project" },
  }, ...pathRecords]);
  writeJsonl(`${source}/rollout-child.jsonl`, [{
    timestamp: "2026-03-01T11:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "multi-child",
      forked_from_id: "multi-root",
      cwd: "/workspace/project",
    },
  }, ...pathRecords]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  try {
    await syncCodexSessions(
      source,
      new SourceArtifactRepository(db),
      new ConversationWriteRepository(db),
    );
    strictEqual(count(db, "conversation_turns"), 1);
    strictEqual(count(db, "conversation_model_calls"), 2);
    strictEqual(count(db, "artifact_model_call_occurrences"), 4);
    strictEqual(count(db, "conversation_tool_events"), 1);
    deepStrictEqual(
      db.prepare(`
        SELECT occurrence_kind, COUNT(*) AS count
        FROM artifact_model_call_occurrences
        GROUP BY occurrence_kind ORDER BY occurrence_kind
      `).all().map((row) => ({ ...row })),
      [
        { occurrence_kind: "copied", count: 2 },
        { occurrence_kind: "executed", count: 2 },
      ],
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_branches
        WHERE forked_from_branch_id IS NOT NULL
          AND fork_point_entry_id = head_entry_id
      `).get()!.count,
      1,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex does not deduplicate copied-looking calls without stable identity", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source);
  const pathRecords = [
    {
      timestamp: "2026-04-01T10:00:00.100Z",
      type: "turn_context",
      payload: { model: "gpt-test-codex" },
    },
    {
      timestamp: "2026-04-01T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", started_at: 1775037601 },
    },
    {
      timestamp: "2026-04-01T10:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Same content" }],
      },
    },
    {
      timestamp: "2026-04-01T10:00:01.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Same answer" }],
      },
    },
    {
      timestamp: "2026-04-01T10:00:01.300Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
  ];
  writeJsonl(`${source}/rollout-root.jsonl`, [{
    type: "session_meta",
    payload: { id: "unresolved-root" },
  }, ...pathRecords]);
  writeJsonl(`${source}/rollout-child.jsonl`, [{
    type: "session_meta",
    payload: {
      id: "unresolved-child",
      forked_from_id: "unresolved-root",
    },
  }, ...pathRecords]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  try {
    await syncCodexSessions(
      source,
      new SourceArtifactRepository(db),
      new ConversationWriteRepository(db),
    );
    strictEqual(count(db, "conversation_turns"), 2);
    strictEqual(count(db, "conversation_model_calls"), 2);
    strictEqual(count(db, "artifact_model_call_occurrences"), 2);
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_model_call_occurrences
        WHERE occurrence_kind = 'unknown' AND identity_basis = 'unresolved'
      `).get()!.count,
      1,
    );
    strictEqual(
      db.prepare(`
        SELECT fork_point_provenance FROM conversation_branches
        WHERE forked_from_branch_id IS NOT NULL
      `).get()!.fork_point_provenance,
      "unresolved",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Codex projects a source artifact without provider session identity", async () => {
  const directory = Deno.makeTempDirSync();
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source);
  writeJsonl(`${source}/rollout-anonymous.jsonl`, [
    { type: "session_meta", payload: { cwd: "/workspace/project" } },
    {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-test-codex" },
    },
    {
      timestamp: "2026-05-01T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "anonymous-turn" },
    },
    {
      timestamp: "2026-05-01T10:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "anonymous-user",
        role: "user",
        content: [{ type: "input_text", text: "Anonymous" }],
      },
    },
    {
      timestamp: "2026-05-01T10:00:01.200Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "anonymous-response",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Imported" }],
      },
    },
    {
      timestamp: "2026-05-01T10:00:01.300Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
  ]);
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  try {
    await syncCodexSessions(
      source,
      new SourceArtifactRepository(db),
      new ConversationWriteRepository(db),
    );
    strictEqual(count(db, "conversations"), 1);
    strictEqual(count(db, "conversation_model_calls"), 1);
    strictEqual(count(db, "source_artifact_identities"), 0);
    strictEqual(
      db.prepare("SELECT external_id FROM conversations").get()!.external_id,
      "rollout-anonymous",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
