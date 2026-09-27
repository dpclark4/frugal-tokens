import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { SessionBrowserRepository } from "./repository.ts";
import { ConversationWriteRepository } from "../../conversationWriteRepository.ts";
import { openArchiveDatabase } from "../../database.ts";
import { migrateTestDatabase } from "../../databaseTestUtils.ts";
import { SourceArtifactRepository } from "../../sourceArtifactRepository.ts";
import type { LinearConversationImport } from "../../conversationImportTypes.ts";
import type { SessionSortKey } from "../../../shared/sessionSchemas.ts";

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
  timestamp: ["c", "b", "a"],
  model: ["c", "b", "a"],
  activity: ["c", "b", "a"],
  input: ["c", "b", "a"],
  output: ["c", "b", "a"],
  cost: ["c", "b", "a"],
  // No cache issues are seeded here (see the dedicated count test below),
  // so every session ties at 0 and falls through to the updated_at DESC
  // tiebreaker.
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
    const conversations = new SessionBrowserRepository(db);
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
  const conversations = new SessionBrowserRepository(db);
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

Deno.test("sorts cache misses by the same count the UI displays", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new SessionBrowserRepository(db);
  try {
    seedSortFixture(sources, projection);
    // Counts only, deliberately not mirroring `sortFixtureValues`' a < b < c
    // ordering, so this test can't pass by accident via some other key's
    // tiebreaker. The UI badge is session.cacheIssues.length
    // (RecentSessionsTable.tsx), a flat count across every issue cause -
    // this seeds that same shape rather than the old fullMisses/partialHits
    // breakdown so the sort can't drift from what's displayed again.
    const issueCounts = { a: 1, b: 3, c: 0 };
    for (const [id, count] of Object.entries(issueCounts)) {
      // SAFETY: The static SQL projection and migrated schema define this row contract.
      const row = db.prepare(`
        SELECT cr.conversation_id, cr.summary_json
        FROM conversation_rollups cr
        JOIN conversations c ON c.id = cr.conversation_id
        WHERE c.external_id = ?
      `).get(id) as { conversation_id: number; summary_json: string };
      const summary = JSON.parse(row.summary_json);
      summary.cacheIssues = Array.from(
        { length: count },
        (_, index) => ({ status: "full-miss", turn: index + 1 }),
      );
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
      ["b", "a", "c"],
    );
  } finally {
    db.close();
  }
});

Deno.test("sorts session timestamps oldest first on request", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new SessionBrowserRepository(db);
  try {
    seedSortFixture(sources, projection);
    deepStrictEqual(
      conversations.listSessions(1, 10, "pi", undefined, {
        key: "timestamp",
        direction: "asc",
      }).items.map(({ id }) => id),
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
  const conversations = new SessionBrowserRepository(db);
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

Deno.test("model options count distinct root sessions including switches and subagents", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const browser = new SessionBrowserRepository(db);
  function persist(imports: LinearConversationImport[]) {
    for (const imported of imports) {
      sources.recordUnchangedArtifact(
        imported.sourceID,
        imported.externalID,
        imported.artifactPath!,
        imported.observedAt,
      );
    }
    projection.replaceLinearConversationTree(imports);
  }
  try {
    const sourceID = sources.ensureSource("pi", "directory", "Pi", "/sessions");
    const root = sortFixtureSession(sourceID, sortFixtureValues[0]);
    const first = root.session.turns[0].calls[0];
    first.tokens = {
      ...first.tokens,
      cacheRead: 50,
      processed: first.tokens.processed + 50,
    };
    root.session.turns[0].calls.push(
      { ...first, id: "repeat", callWithinTurn: 2 },
      { ...first, id: "switch", model: "gpt-5.6-sol", callWithinTurn: 3 },
    );
    const child = sortFixtureSession(sourceID, {
      ...sortFixtureValues[1],
      id: "child",
      model: "child-only",
    });
    child.parentExternalID = root.externalID;
    persist([root, child]);
    persist([
      sortFixtureSession(sourceID, sortFixtureValues[1]),
    ]);
    const codexID = sources.ensureSource(
      "codex",
      "directory",
      "Codex",
      "/codex",
    );
    persist([
      sortFixtureSession(codexID, sortFixtureValues[1]),
    ]);
    deepStrictEqual(browser.listModels(), [
      { id: "gpt-5.6-sol", sessionCount: 3 },
      { id: "child-only", sessionCount: 1 },
      { id: "gpt-5.6-luna", sessionCount: 1 },
    ]);
    deepStrictEqual(browser.listModels("pi"), [
      { id: "gpt-5.6-sol", sessionCount: 2 },
      { id: "child-only", sessionCount: 1 },
      { id: "gpt-5.6-luna", sessionCount: 1 },
    ]);
    deepStrictEqual(browser.listModels("opencode"), []);
    const all = browser.listSessions(1, 100, "pi");
    for (const model of ["child-only", "gpt-5.6-luna"]) {
      const filtered = browser.listSessions(
        1,
        100,
        "pi",
        undefined,
        undefined,
        [model],
      );
      deepStrictEqual(
        filtered.items,
        all.items.filter((item) => item.id === "a"),
      );
      strictEqual(filtered.pagination.totalItems, 1);
    }
    for (let page = 1; page <= 2; page++) {
      const filtered = browser.listSessions(
        page,
        1,
        "pi",
        undefined,
        undefined,
        ["gpt-5.6-sol", "gpt-5.6-luna"],
      );
      strictEqual(filtered.pagination.totalItems, 2);
      strictEqual(filtered.pagination.totalPages, 2);
      deepStrictEqual(filtered.items, all.items.slice(page - 1, page));
    }
    strictEqual(
      browser.listSessions(1, 10, "pi", [], undefined, ["gpt-5.6-sol"])
        .pagination.totalItems,
      0,
    );
    strictEqual(
      browser.listSessions(1, 10, "pi", undefined, undefined, [
        "unknown' OR 1=1 --",
      ]).pagination.totalItems,
      0,
    );
    const switched = browser.listSessions(
      1,
      10,
      "pi",
      ["model-change"],
      undefined,
      ["gpt-5.6-sol"],
    );
    deepStrictEqual(switched.items.map((item) => item.id), ["a"]);
  } finally {
    db.close();
  }
});

Deno.test("sorts by model with empty models_json array without crashing", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new SessionBrowserRepository(db);
  try {
    seedSortFixture(sources, projection);
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    db.prepare(`
      UPDATE conversations SET models_json = '[]' WHERE id = (
        SELECT id FROM conversations WHERE external_id = ?
      )
    `).run("a");
    const result = conversations.listSessions(1, 10, "pi", undefined, {
      key: "model",
      direction: "desc",
    });
    strictEqual(result.items.length, 3);
    deepStrictEqual(result.items.map(({ id }) => id), ["c", "b", "a"]);
  } finally {
    db.close();
  }
});
