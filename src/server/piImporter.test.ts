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
{"type":"compaction","id":"compact-1","parentId":"assistant-1","timestamp":"2026-07-11T13:37:00.000Z","summary":"Sensitive generated summary","firstKeptEntryId":"assistant-1","retainedTail":{"legacy":true},"tokensBefore":50000,"usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"reasoning":2,"totalTokens":110},"fromHook":false}
{"type":"message","id":"user-2","parentId":"compact-1","timestamp":"2026-07-11T13:37:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Continue"}]}}
{"type":"message","id":"assistant-2","parentId":"user-2","timestamp":"2026-07-11T13:37:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Continued answer"}],"provider":"anthropic","model":"claude-opus","usage":{"input":4,"output":3,"cacheRead":1,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"stop"}}
`.trim();
}

Deno.test("imports PI sessions directly from the configured directory", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/sessions`;
  Deno.mkdirSync(sessions);
  Deno.writeTextFileSync(
    `${sessions}/root-session.jsonl`,
    transcript("Root session"),
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const result = await syncPiSessions(sessions, repository);
    strictEqual(result.discovered, 1);
    strictEqual(result.imported, 1);
    strictEqual(
      repository.getSession("pi", "root-session")?.title,
      "Root session",
    );
    strictEqual(
      repository.getSession("pi", "root-session")?.workingDirectory,
      "/Users/test/project",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("imports PI thinking levels for turns and model calls", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/sessions`;
  Deno.mkdirSync(sessions);
  Deno.writeTextFileSync(
    `${sessions}/thinking.jsonl`,
    `
{"type":"session","version":3,"id":"thinking","timestamp":"2026-07-11T13:36:32.000Z","cwd":"/Users/test/project"}
{"type":"thinking_level_change","timestamp":"2026-07-11T13:36:33.000Z","thinkingLevel":"low"}
{"type":"message","id":"user-1","timestamp":"2026-07-11T13:36:34.000Z","message":{"role":"user","content":[{"type":"text","text":"Start low"}]}}
{"type":"message","id":"assistant-1","timestamp":"2026-07-11T13:36:35.000Z","message":{"role":"assistant","content":[{"type":"text","text":"First"}],"provider":"anthropic","model":"claude-opus","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0}}}
{"type":"thinking_level_change","timestamp":"2026-07-11T13:36:36.000Z","thinkingLevel":"high"}
{"type":"message","id":"assistant-2","timestamp":"2026-07-11T13:36:37.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Second"}],"provider":"anthropic","model":"claude-opus","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":1}}}
{"type":"message","id":"user-2","timestamp":"2026-07-11T13:36:38.000Z","message":{"role":"user","content":[{"type":"text","text":"Continue high"}]}}
{"type":"message","id":"assistant-3","timestamp":"2026-07-11T13:36:39.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Third"}],"provider":"anthropic","model":"claude-opus","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":1}}}
    `.trim(),
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const result = await syncPiSessions(sessions, repository);
    strictEqual(result.imported, 1);
    const detail = repository.getSession("pi", "thinking")!;
    strictEqual(detail.turns[0].reasoningSetting?.settingValue, "low");
    strictEqual(
      detail.turns[0].calls[0].reasoningSetting?.settingValue,
      "low",
    );
    strictEqual(
      detail.turns[0].calls[1].reasoningSetting?.settingValue,
      "high",
    );
    strictEqual(detail.turns[1].reasoningSetting?.settingValue, "high");
    deepStrictEqual(
      repository.listSessions(1, 10, "pi").items[0].thinking,
      {
        latest: "high",
        values: ["low", "high"],
        classifiedCalls: 3,
      },
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM reasoning_setting_events")
        .get()!.count,
      2,
    );

    const turnSettings = db.prepare(`
      SELECT t.ordinal, rse.setting_name, rse.setting_value,
             rse.source_field_path, rse.source_order, trs.provenance
      FROM turn_reasoning_settings trs
      JOIN turns t ON t.id = trs.turn_id
      JOIN reasoning_setting_events rse ON rse.id = trs.setting_event_id
      ORDER BY t.ordinal
    `).all().map((row) => ({ ...row }));
    deepStrictEqual(turnSettings, [
      {
        ordinal: 1,
        setting_name: "thinkingLevel",
        setting_value: "low",
        source_field_path: "thinkingLevel",
        source_order: 2,
        provenance: "inherited",
      },
      {
        ordinal: 2,
        setting_name: "thinkingLevel",
        setting_value: "high",
        source_field_path: "thinkingLevel",
        source_order: 5,
        provenance: "inherited",
      },
    ]);

    const callSettings = db.prepare(`
      SELECT t.ordinal AS turn_ordinal, mc.ordinal AS call_ordinal,
             rse.setting_value, mcrs.provenance
      FROM model_call_reasoning_settings mcrs
      JOIN model_calls mc ON mc.id = mcrs.model_call_id
      JOIN turns t ON t.id = mc.turn_id
      JOIN reasoning_setting_events rse ON rse.id = mcrs.setting_event_id
      ORDER BY t.ordinal, mc.ordinal
    `).all().map((row) => ({ ...row }));
    deepStrictEqual(callSettings, [
      {
        turn_ordinal: 1,
        call_ordinal: 1,
        setting_value: "low",
        provenance: "inherited",
      },
      {
        turn_ordinal: 1,
        call_ordinal: 2,
        setting_value: "high",
        provenance: "inherited",
      },
      {
        turn_ordinal: 2,
        call_ordinal: 1,
        setting_value: "high",
        provenance: "inherited",
      },
    ]);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("applies a mid-call PI thinking change to the next model call", async () => {
  const directory = Deno.makeTempDirSync();
  const sessions = `${directory}/sessions`;
  Deno.mkdirSync(sessions);
  Deno.writeTextFileSync(
    `${sessions}/mid-call.jsonl`,
    `
{"type":"session","version":3,"id":"mid-call","timestamp":"2026-07-11T13:36:32.000Z","cwd":"/Users/test/project"}
{"type":"thinking_level_change","id":"thinking-medium","timestamp":"2026-07-11T13:36:33.000Z","thinkingLevel":"medium"}
{"type":"message","id":"user-1","parentId":"thinking-medium","timestamp":"2026-07-11T13:36:34.000Z","message":{"role":"user","content":[{"type":"text","text":"Start"}]}}
{"type":"message","id":"assistant-1","parentId":"user-1","timestamp":"2026-07-11T13:36:35.000Z","message":{"role":"assistant","timestamp":1783776995000,"content":[],"provider":"openai-codex","model":"gpt-5.6-terra","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"toolUse"}}
{"type":"message","id":"tool-result-1","parentId":"assistant-1","timestamp":"2026-07-11T13:36:35.100Z","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"read","content":[{"type":"text","text":"First result"}]}}
{"type":"thinking_level_change","id":"thinking-high","parentId":"tool-result-1","timestamp":"2026-07-11T13:36:36.500Z","thinkingLevel":"high"}
{"type":"message","id":"assistant-2","parentId":"thinking-high","timestamp":"2026-07-11T13:36:36.000Z","message":{"role":"assistant","timestamp":1783776996000,"content":[],"provider":"openai-codex","model":"gpt-5.6-terra","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"toolUse"}}
{"type":"message","id":"tool-result-2","parentId":"assistant-2","timestamp":"2026-07-11T13:36:36.100Z","message":{"role":"toolResult","toolCallId":"tool-2","toolName":"read","content":[{"type":"text","text":"Second result"}]}}
{"type":"message","id":"assistant-3","parentId":"tool-result-2","timestamp":"2026-07-11T13:36:37.000Z","message":{"role":"assistant","timestamp":1783776997000,"content":[],"provider":"openai-codex","model":"gpt-5.6-terra","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":{"total":0.01}},"stopReason":"stop"}}
    `.trim(),
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  try {
    const result = await syncPiSessions(sessions, repository);
    strictEqual(result.imported, 1);
    const detail = repository.getSession("pi", "mid-call")!;
    strictEqual(detail.turns[0].reasoningSetting?.settingValue, "medium");
    deepStrictEqual(
      detail.turns[0].calls.map((call) =>
        call.reasoningSetting?.settingValue
      ),
      ["medium", "medium", "high"],
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

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
    const compaction = repository.getSession("pi", "project/session")!
      .turns[1].calls[0].contextEventsBefore![0];
    strictEqual(compaction.type, "compaction");
    strictEqual(compaction.sourceOrder, 4);
    strictEqual(
      compaction.occurredAt,
      Date.parse("2026-07-11T13:37:00.000Z"),
    );
    strictEqual(compaction.compaction?.resultKind, "plaintext-summary");
    strictEqual(compaction.compaction?.checkpointCompleteness, "complete");
    strictEqual(compaction.compaction?.preContextTokens, 50_000);
    strictEqual(compaction.compaction?.retainedItemCount, 1);
    deepStrictEqual(
      compaction.compaction?.checkpointItems.map((item) => ({
        kind: item.kind,
        sourceEntryID: item.sourceEntryID,
      })),
      [
        { kind: "summary", sourceEntryID: "compact-1" },
        { kind: "message", sourceEntryID: "assistant-1" },
      ],
    );
    deepStrictEqual(
      compaction.compaction?.nativeMetadata?.captureIssues,
      ["retained-tail-not-array"],
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM compaction_details").get()!
        .count,
      1,
    );
    strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS count FROM compaction_checkpoint_items",
      ).get()!.count,
      2,
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
