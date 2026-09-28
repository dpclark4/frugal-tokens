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

Deno.test("cache issue costs include every call before turn deduplication", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const conversations = new SessionBrowserRepository(db);
  try {
    const sourceID = sources.ensureSource("pi", "directory", "Pi", "/sessions");
    const imported = sortFixtureSession(sourceID, sortFixtureValues[0]);
    const turn = imported.session.turns[0];
    const call = turn.calls[0];
    turn.calls = Array.from({ length: 5 }, (_, index) => ({
      ...call,
      id: `call-${index + 1}`,
      callWithinTurn: index + 1,
    }));
    imported.session.modelCalls = turn.calls.length;
    const child = sortFixtureSession(sourceID, sortFixtureValues[1]);
    child.parentExternalID = imported.externalID;
    for (const item of [imported, child]) {
      sources.recordUnchangedArtifact(
        sourceID,
        item.externalID,
        item.artifactPath!,
        item.observedAt,
      );
    }
    projection.replaceLinearConversationTree([imported, child]);
    db.exec("DELETE FROM conversation_cache_misses");
    db.exec(`
      INSERT INTO conversation_cache_misses (
        model_call_id, conversation_id, turn_id, started_at, gap_ms,
        status, cause, previous_context_tokens, current_context_tokens,
        actual_cache_read_tokens, missed_tokens, actual_missed_cost
      )
      SELECT id, conversation_id, turn_id, started_at, 0,
        'full-miss',
        CASE call_within_turn WHEN 4 THEN 'compaction' WHEN 5 THEN 'ttl' END,
        100, 100, 0, 100,
        CASE call_within_turn WHEN 1 THEN 0.25 WHEN 2 THEN 0.5 WHEN 4 THEN 0 END
      FROM conversation_model_calls
    `);
    const issues = conversations.listSessions(1, 10, "pi").items[0]
      .cacheIssues!;
    strictEqual(issues.length, 4);
    deepStrictEqual(issues.find((issue) => issue.scope === "Bravo"), {
      status: "full-miss",
      turn: 1,
      scope: "Bravo",
      estimatedCost: 0.25,
    });
    deepStrictEqual(issues.find((issue) => issue.cause === undefined), {
      status: "full-miss",
      turn: 1,
      estimatedCost: 0.75,
      hasUnpricedCost: true,
    });
    deepStrictEqual(issues.find((issue) => issue.cause === "compaction"), {
      status: "full-miss",
      cause: "compaction",
      turn: 1,
      estimatedCost: 0,
    });
    deepStrictEqual(issues.find((issue) => issue.cause === "ttl"), {
      status: "full-miss",
      cause: "ttl",
      turn: 1,
      hasUnpricedCost: true,
    });
  } finally {
    db.close();
  }
});

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

Deno.test("directory options count eligible roots, group unknown paths, and respect harness", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const browser = new SessionBrowserRepository(db);
  try {
    const pi = sources.ensureSource("pi", "directory", "Pi", "/pi");
    const codex = sources.ensureSource("codex", "directory", "Codex", "/codex");
    const imports = [
      sortFixtureSession(pi, { ...sortFixtureValues[0], id: "root" }),
      sortFixtureSession(pi, { ...sortFixtureValues[0], id: "child" }),
      sortFixtureSession(pi, { ...sortFixtureValues[0], id: "unknown" }),
      sortFixtureSession(pi, { ...sortFixtureValues[0], id: "empty" }),
      sortFixtureSession(codex, { ...sortFixtureValues[0], id: "other" }),
      sortFixtureSession(pi, { ...sortFixtureValues[0], id: "no-tokens" }),
    ];
    imports[1].parentExternalID = imports[0].externalID;
    for (const imported of imports) {
      sources.recordUnchangedArtifact(
        imported.sourceID,
        imported.externalID,
        imported.artifactPath!,
        imported.observedAt,
      );
    }
    projection.replaceLinearConversationTree(imports.slice(0, 2));
    for (const imported of imports.slice(2)) {
      projection.replaceLinearConversationTree([imported]);
    }
    db.prepare(
      "UPDATE conversations SET working_directory = '/child-only' WHERE external_id = 'child'",
    ).run();
    db.prepare(
      "UPDATE conversations SET working_directory = NULL WHERE external_id = 'unknown'",
    ).run();
    db.prepare(
      "UPDATE conversations SET working_directory = '' WHERE external_id = 'empty'",
    ).run();
    db.prepare(
      "UPDATE conversation_rollups SET uncached_input_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = 'no-tokens')",
    ).run();
    deepStrictEqual(browser.listDirectories(), [
      { path: null, sessionCount: 2 },
      { path: "/workspace/project", sessionCount: 2 },
    ]);
    deepStrictEqual(browser.listDirectories("pi"), [
      { path: null, sessionCount: 2 },
      { path: "/workspace/project", sessionCount: 1 },
    ]);
    deepStrictEqual(browser.listDirectories("codex"), [
      { path: "/workspace/project", sessionCount: 1 },
    ]);
    deepStrictEqual(browser.listDirectories("opencode"), []);
    for (const option of browser.listDirectories()) {
      const filtered = browser.listSessions(
        1,
        100,
        undefined,
        undefined,
        undefined,
        [],
        [option.path],
      );
      strictEqual(filtered.pagination.totalItems, option.sessionCount);
    }
    const unknown = browser.listSessions(
      1,
      100,
      "pi",
      undefined,
      undefined,
      [],
      [null],
    );
    deepStrictEqual(unknown.items.map((item) => item.id).sort(), [
      "empty",
      "unknown",
    ]);
    const combined = browser.listSessions(
      1,
      100,
      "pi",
      undefined,
      undefined,
      [],
      [null, "/workspace/project"],
    );
    strictEqual(combined.pagination.totalItems, 3);
    strictEqual(
      browser.listSessions(1, 100, "pi", undefined, undefined, [], [
        "/child-only",
      ]).pagination.totalItems,
      0,
    );
    strictEqual(
      browser.listSessions(1, 100, "pi", undefined, undefined, [
        "missing-model",
      ], [null]).pagination.totalItems,
      0,
    );
    strictEqual(
      browser.listSessions(1, 100, "pi", [], undefined, [], [null]).pagination
        .totalItems,
      0,
    );
  } finally {
    db.close();
  }
});

Deno.test("directory options roll up Herdr worktrees per project and home", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const projection = new ConversationWriteRepository(db);
  const browser = new SessionBrowserRepository(db);
  try {
    const sourceID = sources.ensureSource("pi", "directory", "Pi", "/sessions");
    const paths = [
      "/home/a/.herdr/worktrees/project/worktree-one",
      "/home/a/.herdr/worktrees/project/worktree-two/src",
      "/home/a/.herdr/worktrees/project",
      "/home/a/.herdr/worktrees/other/worktree-one",
      "/home/b/.herdr/worktrees/project/worktree-one",
      "/workspace/project/worktree-one",
      "/home/a/not.herdr/worktrees/project/worktree-one",
      "/home/a/.herdr/worktrees",
      "/home/a/.herdr/worktrees/project-other/one",
      "/home/a/.herdr/worktrees/proj_%/one",
      "/home/a/.herdr/worktrees/projAB/one",
      "/workspace/project/worktree-one/subdir",
    ];
    for (const [index, path] of paths.entries()) {
      const imported = sortFixtureSession(sourceID, {
        ...sortFixtureValues[0],
        id: `directory-${index}`,
      });
      imported.workingDirectory = path;
      sources.recordUnchangedArtifact(
        sourceID,
        imported.externalID,
        imported.artifactPath!,
        imported.observedAt,
      );
      projection.replaceLinearConversationTree([imported]);
    }
    deepStrictEqual(browser.listDirectories("pi"), [
      { path: "/home/a/.herdr/worktrees/project", sessionCount: 3 },
      { path: "/home/a/.herdr/worktrees", sessionCount: 1 },
      { path: "/home/a/.herdr/worktrees/other", sessionCount: 1 },
      { path: "/home/a/.herdr/worktrees/proj_%", sessionCount: 1 },
      { path: "/home/a/.herdr/worktrees/projAB", sessionCount: 1 },
      { path: "/home/a/.herdr/worktrees/project-other", sessionCount: 1 },
      {
        path: "/home/a/not.herdr/worktrees/project/worktree-one",
        sessionCount: 1,
      },
      { path: "/home/b/.herdr/worktrees/project", sessionCount: 1 },
      { path: "/workspace/project/worktree-one", sessionCount: 1 },
      { path: "/workspace/project/worktree-one/subdir", sessionCount: 1 },
    ]);
    for (const option of browser.listDirectories("pi")) {
      const filtered = browser.listSessions(
        1,
        100,
        "pi",
        undefined,
        undefined,
        [],
        [option.path],
      );
      strictEqual(filtered.pagination.totalItems, option.sessionCount);
    }
    const selection = ["/home/a/.herdr/worktrees/project"];
    const all = browser.listSessions(
      1,
      100,
      "pi",
      undefined,
      undefined,
      [],
      selection,
    );
    deepStrictEqual(all.items.map((item) => item.id).sort(), [
      "directory-0",
      "directory-1",
      "directory-2",
    ]);
    for (let page = 1; page <= 3; page++) {
      const result = browser.listSessions(
        page,
        1,
        "pi",
        undefined,
        undefined,
        [],
        selection,
      );
      strictEqual(result.pagination.totalItems, 3);
      strictEqual(result.pagination.totalPages, 3);
      deepStrictEqual(result.items, all.items.slice(page - 1, page));
    }
    strictEqual(
      browser.listSessions(1, 100, "pi", undefined, undefined, [
        sortFixtureValues[0].model,
      ], selection).pagination.totalItems,
      3,
    );
    strictEqual(
      browser.listSessions(1, 100, "codex", undefined, undefined, [], selection)
        .pagination.totalItems,
      0,
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
