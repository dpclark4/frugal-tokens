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
import type { SessionSortKey } from "../shared/sessionSchemas.ts";

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

// Distinct enough per column that ascending/descending order isn't
// accidentally shared across keys, and sized so computed cost (which scales
// with each model's own per-token rate) still lands in the same a < b < c
// order as the raw token counts.
const sortFixtureValues = [
  {
    id: "a",
    title: "Alpha",
    model: "gpt-5.6-luna",
    userTurns: 1,
    uncachedInput: 120,
    output: 80,
    updatedAt: 100,
  },
  {
    id: "b",
    title: "Bravo",
    model: "gpt-5.6-sol",
    userTurns: 5,
    uncachedInput: 340,
    output: 260,
    updatedAt: 200,
  },
  {
    id: "c",
    title: "Charlie",
    model: "gpt-5.6-terra",
    userTurns: 10,
    uncachedInput: 910,
    output: 770,
    updatedAt: 300,
  },
];

function sortFixtureSession(
  sourceID: number,
  values: typeof sortFixtureValues[number],
): LinearConversationImport {
  const tokens = {
    uncachedInput: values.uncachedInput,
    cacheRead: 0,
    freshPrompt: values.uncachedInput,
    output: values.output,
    reasoning: 0,
    processed: values.uncachedInput + values.output,
  };
  return {
    sourceID,
    externalID: values.id,
    publicID: values.id,
    artifactPath: `project/${values.id}.jsonl`,
    workingDirectory: "/workspace/project",
    observedAt: 10,
    checkpoint: { parserVersion: "test", checksum: values.id },
    session: {
      title: values.title,
      updatedAt: values.updatedAt,
      startedAt: 10,
      endedAt: 30,
      providers: ["openai"],
      models: [values.model],
      userTurns: values.userTurns,
      modelCalls: 1,
      tokens,
      turns: [{
        number: 1,
        startedAt: 10,
        calls: [{
          id: "call-1",
          callWithinTurn: 1,
          provider: "openai",
          model: values.model,
          startedAt: 11,
          completedAt: 12,
          tokens,
          activity: { hasText: true, hasReasoning: false, tools: [] },
        }],
      }],
    },
  };
}

function seedSortFixture(
  sources: SourceArtifactRepository,
  projection: ConversationWriteRepository,
) {
  const sourceID = sources.ensureSource("pi", "directory", "Pi", "/sessions");
  for (const values of sortFixtureValues) {
    const imported = sortFixtureSession(sourceID, values);
    sources.recordUnchangedArtifact(
      sourceID,
      imported.externalID,
      imported.artifactPath!,
      imported.observedAt,
    );
    projection.replaceLinearConversationTree([imported]);
  }
}

const sortKeyExpectedDescOrder = {
  name: ["c", "b", "a"],
  model: ["c", "b", "a"],
  activity: ["c", "b", "a"],
  input: ["c", "b", "a"],
  output: ["c", "b", "a"],
  cost: ["c", "b", "a"],
  // No cache issues are seeded here (see the dedicated heuristic test
  // below), so every session ties at 0 and falls through to the
  // updated_at DESC tiebreaker.
  cacheMisses: ["c", "b", "a"],
} satisfies Record<SessionSortKey, string[]>;

// SAFETY: sortKeyExpectedDescOrder's keys are declared as exactly the
// SessionSortKey enum members via the `satisfies` check above.
for (const key of Object.keys(sortKeyExpectedDescOrder) as SessionSortKey[]) {
  Deno.test(`sorts recent sessions by ${key} (descending)`, () => {
    const db = openArchiveDatabase(":memory:");
    migrateTestDatabase(db);
    const sources = new SourceArtifactRepository(db);
    const projection = new ConversationWriteRepository(db);
    const conversations = new ConversationRepository(db);
    try {
      seedSortFixture(sources, projection);
      deepStrictEqual(
        conversations.listSessions(1, 10, "pi", undefined, {
          key,
          direction: "desc",
        }).items.map(({ id }) => id),
        sortKeyExpectedDescOrder[key],
      );
    } finally {
      db.close();
    }
  });
}

Deno.test("flips to ascending order on request", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    seedSortFixture(sources, projection);
    deepStrictEqual(
      conversations.listSessions(1, 10, "pi", undefined, {
        key: "input",
        direction: "asc",
      }).items.map(({ id }) => id),
      ["a", "b", "c"],
    );
  } finally {
    db.close();
  }
});

Deno.test("sorts cache misses by full misses first, then partial+ttl combined", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    seedSortFixture(sources, projection);
    const cacheSummaries = {
      a: { fullMisses: 2, partialHits: 0, ttlRelatedMisses: 0 },
      b: { fullMisses: 1, partialHits: 5, ttlRelatedMisses: 0 },
      c: { fullMisses: 1, partialHits: 1, ttlRelatedMisses: 1 },
    } satisfies Record<string, {
      fullMisses: number;
      partialHits: number;
      ttlRelatedMisses: number;
    }>;
    for (const [id, cacheSummary] of Object.entries(cacheSummaries)) {
      // SAFETY: The static SQL projection and migrated schema define this row contract.
      const row = db.prepare(`
        SELECT cr.conversation_id, cr.summary_json
        FROM conversation_rollups cr
        JOIN conversations c ON c.id = cr.conversation_id
        WHERE c.external_id = ?
      `).get(id) as { conversation_id: number; summary_json: string };
      const summary = JSON.parse(row.summary_json);
      summary.cacheSummary = {
        ...summary.cacheSummary,
        ...cacheSummary,
      };
      db.prepare(`
        UPDATE conversation_rollups SET summary_json = ?
        WHERE conversation_id = ?
      `).run(JSON.stringify(summary), row.conversation_id);
    }

    deepStrictEqual(
      conversations.listSessions(1, 10, "pi", undefined, {
        key: "cacheMisses",
        direction: "desc",
      }).items.map(({ id }) => id),
      // a has the most full misses; among the full=1 tie, b's larger
      // partial+ttl combined key sorts before c's.
      ["a", "b", "c"],
    );
  } finally {
    db.close();
  }
});

Deno.test("omitting sort reproduces the natural updated_at order", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    seedSortFixture(sources, projection);
    deepStrictEqual(
      conversations.listSessions(1, 10, "pi").items.map(({ id }) => id),
      ["c", "b", "a"],
    );
  } finally {
    db.close();
  }
});

Deno.test("overview rollups return ordered root execution intervals", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "pi",
      "directory",
      "Pi",
      "/sessions",
    );
    const imported = linearSession(sourceID);
    sources.recordUnchangedArtifact(
      sourceID,
      imported.externalID,
      "project/linear.jsonl",
      imported.observedAt,
    );
    projection.replaceLinearConversationTree([imported]);

    const rollups = conversations.listOverviewRollups(0, "pi");
    strictEqual(rollups.length, 1);
    deepStrictEqual(rollups[0].rootExecutionIntervals, [
      { startedAt: 10, executionEndAt: 12 },
      { startedAt: 20, executionEndAt: 22 },
    ]);
  } finally {
    db.close();
  }
});

Deno.test("lists recent sessions by last activity time", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "pi",
      "directory",
      "Pi",
      "/sessions",
    );
    const values = [
      { id: "older-start", startedAt: 100, updatedAt: 300 },
      { id: "newer-start", startedAt: 200, updatedAt: 250 },
    ];
    for (const value of values) {
      const imported = linearSession(sourceID);
      imported.externalID = value.id;
      imported.publicID = value.id;
      imported.artifactPath = `project/${value.id}.jsonl`;
      imported.checkpoint = { parserVersion: "test", checksum: value.id };
      imported.session = {
        ...imported.session,
        title: value.id,
        startedAt: value.startedAt,
        updatedAt: value.updatedAt,
      };
      sources.recordUnchangedArtifact(
        sourceID,
        imported.externalID,
        imported.artifactPath,
        imported.observedAt,
      );
      projection.replaceLinearConversationTree([imported]);
    }

    deepStrictEqual(
      conversations.listSessions(1, 10, "pi").items.map(({ id }) => id),
      ["older-start", "newer-start"],
    );
  } finally {
    db.close();
  }
});

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
      analyzed.turns.find((turn) => turn.calls[0].id === "response-fork-a-3")
        ?.calls[0].cacheAssessment?.status,
      "hit",
    );
    strictEqual(
      analyzed.turns.at(-1)!.calls[0].cacheAssessment?.status,
      "hit",
    );
    strictEqual(
      analyzed.turns[3].calls[0].contextEventsBefore?.[0]?.type,
      "compaction",
    );
    const callIDs = new Map(
      // SAFETY: The static SQL projection and migrated schema define this row contract.
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

    const storedPredecessors = new Map(
      // SAFETY: The static SQL projection and migrated schema define this row contract.
      (db.prepare(`
        SELECT model_call_id, previous_model_call_id
        FROM conversation_cache_misses
      `).all() as Array<{
        model_call_id: number;
        previous_model_call_id: number | null;
      }>).map((row) => [row.model_call_id, row.previous_model_call_id]),
    );
    strictEqual(
      storedPredecessors.has(callIDs.get("response-fork-a-3")!),
      false,
    );
    strictEqual(
      storedPredecessors.has(callIDs.get("response-fork-b-5")!),
      false,
    );
  } finally {
    db.close();
  }
});

Deno.test("attributes a cache-floor reset to an implicit Codex fork predecessor", async () => {
  const directory = Deno.makeTempDirSync();
  const fixture = decodeURIComponent(
    new URL(
      "./fixtures/codex-branching/sibling-forks/",
      import.meta.url,
    ).pathname,
  );
  const source = `${directory}/sessions`;
  Deno.mkdirSync(source);
  const rootPath = `${source}/rollout-original.jsonl`;
  const childPath = `${source}/rollout-fork-a.jsonl`;
  Deno.copyFileSync(`${fixture}rollout-original.jsonl`, rootPath);

  const rootRecords = Deno.readTextFileSync(rootPath).trim().split("\n").map(
    (line) => JSON.parse(line),
  );
  const firstRootUsage = rootRecords.find((record) =>
    record.type === "event_msg" && record.payload?.type === "token_count"
  );
  firstRootUsage.payload.info.last_token_usage.cached_input_tokens = 10;
  Deno.writeTextFileSync(
    rootPath,
    `${rootRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const allChildRecords = Deno.readTextFileSync(
    `${fixture}rollout-fork-a.jsonl`,
  ).trim().split("\n").map((line) => JSON.parse(line));
  const firstUniqueTurn = allChildRecords.findIndex((record) =>
    record.type === "event_msg" && record.payload?.type === "task_started" &&
    record.payload.turn_id === "turn-fork-a-3"
  );
  const childRecords = [
    allChildRecords[0],
    allChildRecords[1],
    ...allChildRecords.slice(firstUniqueTurn),
  ];
  const firstChildUsage = childRecords.find((record) =>
    record.type === "event_msg" && record.payload?.type === "token_count"
  );
  firstChildUsage.payload.info.last_token_usage.cached_input_tokens = 10;
  Deno.writeTextFileSync(
    childPath,
    `${childRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new ConversationRepository(db);
  try {
    await syncCodexSessions(source, sources, projection);
    strictEqual(
      db.prepare(`
        SELECT fork_point_provenance FROM conversation_branches
        WHERE forked_from_branch_id IS NOT NULL
      `).get()!.fork_point_provenance,
      "unresolved",
    );

    const detail = conversations.getSession(
      "codex",
      "00000000-0000-4000-8000-000000000001",
    )!;
    const analyzed = analyzeSessionCache(detail);
    const forkCall = analyzed.turns.find((turn) =>
      turn.calls[0].id === "response-fork-a-3"
    )!.calls[0];
    strictEqual(forkCall.previousCallID, "response-original-4");
    strictEqual(forkCall.cacheAssessment?.status, "full-miss");

    deepStrictEqual(
      {
        ...db.prepare(`
          SELECT miss.status,
            current_call.source_call_id AS current_call,
            previous_call.source_call_id AS previous_call
          FROM conversation_cache_misses miss
          JOIN conversation_model_calls current_call
            ON current_call.id = miss.model_call_id
          JOIN conversation_model_calls previous_call
            ON previous_call.id = miss.previous_model_call_id
          WHERE current_call.source_call_id = 'response-fork-a-3'
        `).get()!,
      },
      {
        status: "full-miss",
        current_call: "response-fork-a-3",
        previous_call: "response-original-4",
      },
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
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

    // SAFETY: The static SQL projection and migrated schema define this row contract.
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
