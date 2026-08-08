import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { sessionListItemSchema } from "../shared/sessionSchemas.ts";
import { ConversationCompatibilityRepository } from "./conversationCompatibilityRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";
import { syncCodexSessions } from "./codexImporter.ts";
import {
  analyzeSessionCache,
  categorizeUsageCallCache,
} from "./cacheAnalysis.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SessionReadRepository } from "./sessionReadRepository.ts";
import { enrichSessionSummary } from "./sessionSummaryEnrichment.ts";
import {
  SessionRepository,
  type SourceSessionImport,
} from "./sessionRepository.ts";

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

function linearSession(sourceID: number): SourceSessionImport {
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

Deno.test("conversation compatibility repository preserves linear read contracts", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const legacy = new SessionRepository(db);
  const projection = new ConversationProjectionRepository(db);
  const compatibility = new ConversationCompatibilityRepository(db);
  try {
    const sourceID = legacy.ensureSource("pi", "directory", "PI", "/sessions");
    const value = linearSession(sourceID);
    legacy.replaceSourceSession(value);
    projection.replaceLinearSession(value);

    const legacyList = legacy.listSessions(1, 10, "pi");
    const legacyDetail = legacy.getSession("pi", "linear")!;
    const compatibilityList = compatibility.listSessions(1, 10, "pi");
    deepStrictEqual(
      JSON.parse(JSON.stringify(compatibilityList.items)),
      [
        JSON.parse(JSON.stringify(
          sessionListItemSchema.parse(enrichSessionSummary(legacyDetail)),
        )),
      ],
    );
    deepStrictEqual(compatibilityList.pagination, legacyList.pagination);
    const enriched = compatibility.enrichSessionSummaries(
      compatibilityList.items,
    )[0];
    strictEqual(enriched.compactionCount, 1);
    strictEqual(enriched.cacheSummary?.compactionRelatedMisses, 1);
    strictEqual(enriched.inclusiveModelCalls, 2);

    const compatibilityDetail = compatibility.getSession("pi", "linear")!;
    deepStrictEqual(
      { ...compatibilityDetail, internalID: undefined },
      { ...legacyDetail, internalID: undefined },
    );
    deepStrictEqual(
      compatibility.listUsageCalls(undefined, "pi").map(({
        computedCost: _cost,
        modelCallID: _modelCallID,
        previousModelCallID: _previousModelCallID,
        turnRowID: _turnRowID,
        ...call
      }) => call),
      legacy.listUsageCalls(undefined, "pi"),
    );
    strictEqual(compatibility.listToolCalls(0, 100, "pi").length, 1);
    strictEqual(compatibility.listCacheMisses(undefined, "pi").length, 1);
    strictEqual(
      compatibility.listSessions(1, 10, "pi", ["compaction"]).pagination
        .totalItems,
      1,
    );
    strictEqual(
      compatibility.listSessions(1, 10, "pi", ["ttl"]).pagination.totalItems,
      0,
    );
    strictEqual(
      compatibility.listSessions(1, 10, "pi", []).pagination.totalItems,
      0,
    );
    const legacyOverview = legacy.listOverviewRollups(0, "pi");
    const compatibilityOverview = compatibility.listOverviewRollups(0, "pi");
    strictEqual(compatibilityOverview.length, 1);
    const expectedRootIntervals = [{
      startedAt: 10,
      executionEndAt: 12,
    }, {
      startedAt: 20,
      executionEndAt: 22,
    }];
    deepStrictEqual(
      legacyOverview[0].rootExecutionIntervals,
      expectedRootIntervals,
    );
    deepStrictEqual(
      compatibilityOverview[0].rootExecutionIntervals,
      expectedRootIntervals,
    );
    strictEqual(compatibility.listUsageRollups(undefined, "pi").length, 1);
  } finally {
    db.close();
  }
});

Deno.test("conversation compatibility repository linearizes Codex branches without duplicating usage", async () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const legacy = new SessionRepository(db);
  const projection = new ConversationProjectionRepository(db);
  const compatibility = new ConversationCompatibilityRepository(db);
  const fixture = decodeURIComponent(
    new URL(
      "./fixtures/codex-branching/sibling-forks/",
      import.meta.url,
    ).pathname,
  );
  try {
    await syncCodexSessions(fixture, legacy, projection);
    const list = compatibility.listSessions(1, 10, "codex");
    strictEqual(list.pagination.totalItems, 1);
    strictEqual(list.items[0].id, "00000000-0000-4000-8000-000000000001");
    strictEqual(list.items[0].userTurns, 7);
    strictEqual(list.items[0].modelCalls, 7);

    const detail = compatibility.getSession("codex", list.items[0].id)!;
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
    strictEqual(detail.subagents.length, 0);
    strictEqual(compatibility.listUsageCalls(undefined, "codex").length, 7);
    strictEqual(
      compatibility.listToolCalls(0, Number.MAX_SAFE_INTEGER, "codex").length,
      1,
    );
    strictEqual(
      compatibility.listOverviewRollups(0, "codex")[0].overview.days.reduce(
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
      compatibility.listUsageCalls(undefined, "codex"),
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

Deno.test("conversation compatibility repository keeps subagent launches separate from branches", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const legacy = new SessionRepository(db);
  const projection = new ConversationProjectionRepository(db);
  const compatibility = new ConversationCompatibilityRepository(db);
  try {
    const sourceID = legacy.ensureSource(
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
    legacy.replaceSourceSessionTree([root, child]);
    projection.replaceLinearSessionTree([root, child]);

    const list = compatibility.listSessions(1, 10, "claude-code");
    strictEqual(list.pagination.totalItems, 1);
    const detail = compatibility.getSession("claude-code", "root")!;
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
      compatibility.listUsageCalls(undefined, "claude-code").length,
      4,
    );
    strictEqual(
      compatibility.listUsageRollups(undefined, "claude-code")[0]
        .subagentModelCalls,
      2,
    );
    strictEqual(
      compatibility.listSubagentUsage(undefined, "claude-code").length,
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test("session read repository delegates each harness to exactly one provider", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const legacy = new SessionRepository(db);
  const projection = new ConversationProjectionRepository(db);
  const compatibility = new ConversationCompatibilityRepository(db);
  try {
    const piSourceID = legacy.ensureSource(
      "pi",
      "directory",
      "PI",
      "/pi",
    );
    const pi = linearSession(piSourceID);
    pi.externalID = "pi-session";
    pi.publicID = "pi-session";
    legacy.replaceSourceSession(pi);
    projection.replaceLinearSession(pi);

    const openCodeSourceID = legacy.ensureSource(
      "opencode",
      "database",
      "OpenCode",
      "/opencode.db",
    );
    const openCode = linearSession(openCodeSourceID);
    openCode.externalID = "opencode-session";
    openCode.publicID = "opencode-session";
    openCode.session.updatedAt = 40;
    legacy.replaceSourceSession(openCode);
    projection.replaceLinearSession(openCode);

    db.prepare(`
      UPDATE conversations SET title = 'PI conversation'
      WHERE external_id = 'pi-session'
    `).run();
    db.prepare(`
      UPDATE sessions SET title = 'PI legacy'
      WHERE source_session_id = (
        SELECT id FROM source_sessions WHERE external_id = 'pi-session'
      )
    `).run();
    db.prepare(`
      UPDATE conversations SET title = 'OpenCode conversation'
      WHERE external_id = 'opencode-session'
    `).run();
    db.prepare(`
      UPDATE sessions SET title = 'OpenCode legacy'
      WHERE source_session_id = (
        SELECT id FROM source_sessions WHERE external_id = 'opencode-session'
      )
    `).run();

    const reads = new SessionReadRepository(
      legacy,
      compatibility,
      new Set(["pi"]),
    );
    strictEqual(reads.getSession("pi", "pi-session")!.title, "PI conversation");
    strictEqual(
      reads.getSession("opencode", "opencode-session")!.title,
      "OpenCode legacy",
    );
    const global = reads.listSessions(1, 10);
    strictEqual(global.pagination.totalItems, 2);
    deepStrictEqual(
      global.items.map((item) => item.title).toSorted(),
      ["OpenCode legacy", "PI conversation"],
    );
    const firstPage = reads.listSessions(1, 1);
    const secondPage = reads.listSessions(2, 1);
    strictEqual(firstPage.pagination.totalItems, 2);
    strictEqual(firstPage.items[0].title, "OpenCode legacy");
    strictEqual(secondPage.pagination.totalItems, 2);
    strictEqual(secondPage.items[0].title, "PI conversation");
    strictEqual(
      reads.listUsageCalls().length,
      reads.listUsageCalls(undefined, "pi").length +
        reads.listUsageCalls(undefined, "opencode").length,
    );
    const allConversationReads = new SessionReadRepository(
      legacy,
      compatibility,
      new Set(["opencode", "claude-code", "pi", "codex", "cursor"]),
    );
    deepStrictEqual(
      allConversationReads.listCacheMisses(),
      compatibility.listCacheMisses(),
    );
    deepStrictEqual(
      allConversationReads.listUsageRollups(),
      compatibility.listUsageRollups(),
    );
    strictEqual(
      reads.listOverviewRollups(0).length,
      reads.listOverviewRollups(0, "pi").length +
        reads.listOverviewRollups(0, "opencode").length,
    );
    strictEqual(
      reads.summarizeModelCallCosts(0).totalCost,
      reads.summarizeModelCallCosts(0, "pi").totalCost +
        reads.summarizeModelCallCosts(0, "opencode").totalCost,
    );
  } finally {
    db.close();
  }
});
