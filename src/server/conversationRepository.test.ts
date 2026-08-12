import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import { syncCodexSessions } from "./codexImporter.ts";
import {
  analyzeSessionCache,
  categorizeUsageCallCache,
} from "./cacheAnalysis.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import type { LinearConversationImport } from "./conversationImportTypes.ts";

const usage = {
  uncachedInput: 10,
  cacheRead: 5,
  cacheWrite: 2,
  cacheWrite5m: 2,
  cacheWrite1h: 0,
  freshPrompt: 10,
  output: 3,
  reasoning: 1,
  processed: 21,
};

function linearSession(sourceID: number): LinearConversationImport {
  return {
    sourceID,
    externalID: "linear",
    publicID: "linear",
    artifactPath: "project/linear.jsonl",
    workingDirectory: "/workspace/project",
    observedAt: 10,
    checkpoint: { parserVersion: "test", checksum: "linear" },
    session: {
      title: "Linear parity",
      agent: "test-agent",
      updatedAt: 30,
      startedAt: 10,
      endedAt: 30,
      providers: ["openai"],
      models: ["gpt-5.6-luna"],
      userTurns: 2,
      modelCalls: 2,
      tokens: { ...usage, processed: usage.processed * 2 },
      turns: [{
        number: 1,
        startedAt: 10,
        inputs: [{ kind: "text", preview: "Start", originalLength: 5 }],
        reasoningSetting: {
          settingName: "effort",
          settingValue: "medium",
          provenance: "inherited",
        },
        calls: [{
          id: "call-1",
          callWithinTurn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
          startedAt: 11,
          completedAt: 12,
          tokens: usage,
          activity: {
            hasText: true,
            hasReasoning: true,
            tools: [{
              sourceID: "tool-1",
              name: "read",
              status: "completed",
              startedAt: 11,
              completedAt: 12,
              input: { preview: "input", originalLength: 5 },
              output: { preview: "output", originalLength: 6 },
            }],
          },
          content: [{ kind: "text", preview: "First", originalLength: 5 }],
        }],
      }, {
        number: 2,
        startedAt: 20,
        calls: [{
          id: "call-2",
          callWithinTurn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
          startedAt: 21,
          completedAt: 22,
          tokens: usage,
          activity: {
            hasText: true,
            hasReasoning: true,
            tools: [],
          },
          content: [{ kind: "text", preview: "Second", originalLength: 6 }],
        }],
      }],
      contextEvents: [{
        type: "compaction",
        sourceOrder: 2,
        occurredAt: 19,
        affectedCall: { turn: 2, call: 1 },
      }],
    },
  };
}

Deno.test("conversation repository linearizes Codex branches without duplicating usage", async () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  const fixture = decodeURIComponent(
    new URL(
      "./fixtures/codex-branching/sibling-forks/",
      import.meta.url,
    ).pathname,
  );
  try {
    await syncCodexSessions(fixture, sources, projection);
    const list = conversations.listSessions(1, 10, "codex");
    deepStrictEqual(conversations.listHarnesses(), ["codex"]);
    strictEqual(list.pagination.totalItems, 1);
    strictEqual(list.items[0].id, "00000000-0000-4000-8000-000000000001");
    strictEqual(list.items[0].userTurns, 7);
    strictEqual(list.items[0].modelCalls, 7);
    strictEqual(list.items[0].forkCount, 2);

    const detail = conversations.getSession("codex", list.items[0].id)!;
    strictEqual(detail.turns.length, 7);
    deepStrictEqual(
      detail.turns.map((turn) => turn.calls[0].id),
      [
        "response-shared-1",
        "response-shared-2",
        "tool-entry-original-3",
        "response-original-4",
        "response-fork-a-3",
        "response-fork-a-4",
        "response-fork-b-5",
      ],
    );
    deepStrictEqual(
      detail.turns.map((turn) => turn.branchNumber),
      [undefined, undefined, undefined, undefined, 1, 1, 2],
    );
    strictEqual(detail.subagents.length, 0);
    strictEqual(conversations.listUsageCalls(undefined, "codex").length, 7);
    strictEqual(
      conversations.listToolCalls(0, Number.MAX_SAFE_INTEGER, "codex").length,
      1,
    );
    strictEqual(
      conversations.listOverviewRollups(0, "codex")[0].overview.days.reduce(
        (sum, day) => sum + day.turns,
        0,
      ),
      7,
    );
    const analyzed = analyzeSessionCache(detail);
    strictEqual(
      analyzed.turns.at(-1)!.calls[0].cacheAssessment?.status,
      "partial-hit",
    );
    strictEqual(
      analyzed.turns[3].calls[0].contextEventsBefore?.[0]?.type,
      "compaction",
    );
    const callIDs = new Map(
      (db.prepare(`
        SELECT source_call_id, id FROM conversation_model_calls
      `).all() as Array<{ source_call_id: string; id: number }>).map((row) => [
        row.source_call_id,
        row.id,
      ]),
    );
    const categorized = categorizeUsageCallCache(
      conversations.listUsageCalls(undefined, "codex"),
    );
    strictEqual(
      categorized.find((call) =>
        call.modelCallID === callIDs.get("response-fork-a-3")
      )?.previousComparableCall?.modelCallID,
      callIDs.get("response-shared-2"),
    );
    strictEqual(
      categorized.find((call) =>
        call.modelCallID === callIDs.get("response-fork-b-5")
      )?.previousComparableCall?.modelCallID,
      callIDs.get("response-original-4"),
    );
  } finally {
    db.close();
  }
});

Deno.test("session lists read cache issue reasons from normalized misses", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "codex",
      "directory",
      "Codex",
      "/sessions",
    );
    const session = linearSession(sourceID);
    session.session.turns[1].calls[0].model = "gpt-5.6-sol";
    session.session.contextEvents = [];
    sources.recordUnchangedArtifact(
      sourceID,
      session.externalID,
      session.artifactPath!,
      10,
    );
    projection.replaceLinearConversationTree([session]);

    const row = db.prepare(`
      SELECT cr.conversation_id, cr.summary_json
      FROM conversation_rollups cr
      JOIN conversations c ON c.id = cr.conversation_id
      WHERE c.external_id = 'linear'
    `).get() as { conversation_id: number; summary_json: string };
    const staleSummary = JSON.parse(row.summary_json);
    staleSummary.cacheIssues = [{ status: "full-miss", turn: 2 }];
    db.prepare(`
      UPDATE conversation_rollups SET summary_json = ?
      WHERE conversation_id = ?
    `).run(JSON.stringify(staleSummary), row.conversation_id);

    const list = conversations.listSessions(1, 10, "codex", [
      "model-change",
    ]);
    strictEqual(list.pagination.totalItems, 1);
    deepStrictEqual(list.items[0].cacheIssues, [{
      status: "full-miss",
      reason: "model-change",
      turn: 2,
    }]);
    strictEqual(
      conversations.listSessions(1, 10, "codex", ["full-miss"])
        .pagination.totalItems,
      0,
    );
  } finally {
    db.close();
  }
});

Deno.test("conversation repository keeps subagent launches separate from branches", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "claude-code",
      "directory",
      "Claude Code",
      "/sessions",
    );
    const root = linearSession(sourceID);
    root.externalID = "root";
    root.publicID = "root";
    root.session.title = "Root";
    root.session.turns[0].calls[0].activity.tools[0].childExternalID =
      "root::agent-child";
    root.session.turns[1].calls[0].activity.tools = [{
      ...root.session.turns[0].calls[0].activity.tools[0],
      sourceID: "tool-resume",
    }];
    const child = linearSession(sourceID);
    child.externalID = "root::agent-child";
    child.publicID = "child";
    child.parentExternalID = "root";
    child.session.title = "Child";
    child.session.agent = "Explore";
    sources.recordUnchangedArtifact(
      sourceID,
      root.externalID,
      "root.jsonl",
      10,
    );
    sources.recordUnchangedArtifact(
      sourceID,
      child.externalID,
      "child.jsonl",
      10,
    );
    projection.replaceLinearConversationTree([root, child]);

    const list = conversations.listSessions(1, 10, "claude-code");
    strictEqual(list.pagination.totalItems, 1);
    const detail = conversations.getSession("claude-code", "root")!;
    strictEqual(detail.subagents.length, 1);
    strictEqual(detail.subagents[0].id, "child");
    strictEqual(detail.subagents[0].parentID, "root");
    strictEqual(detail.subagents[0].agent, "Explore");
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    strictEqual(
      detail.turns[1].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_subagent_launches")
        .get()!.count,
      1,
    );
    strictEqual(
      conversations.listUsageCalls(undefined, "claude-code").length,
      4,
    );
    strictEqual(
      conversations.listUsageRollups(undefined, "claude-code")[0]
        .subagentModelCalls,
      2,
    );
    strictEqual(
      conversations.listSubagentUsage(undefined, "claude-code").length,
      1,
    );
    const storedMisses = conversations.listCacheMisses(0, "claude-code");
    const missGroups = conversations.summarizeCacheMisses(0, "claude-code");
    deepStrictEqual(
      new Set(missGroups.map((group) => group.scope)),
      new Set(["root", "subagent"]),
    );
    strictEqual(
      missGroups.reduce((sum, group) => sum + group.misses, 0),
      storedMisses.length,
    );
    strictEqual(
      missGroups.reduce((sum, group) => sum + group.missedTokens, 0),
      storedMisses.reduce((sum, miss) => sum + miss.missedTokens, 0),
    );
    strictEqual(
      missGroups.reduce((sum, group) => sum + group.attributedCost, 0),
      storedMisses.reduce(
        (sum, miss) => sum + (miss.actualMissedCost ?? 0),
        0,
      ),
    );
    strictEqual(
      missGroups.reduce((sum, group) => sum + group.unpriced, 0),
      storedMisses.filter((miss) => miss.actualMissedCost === undefined).length,
    );
  } finally {
    db.close();
  }
});
