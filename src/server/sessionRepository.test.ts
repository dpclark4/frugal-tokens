import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import {
  SessionRepository,
  type SourceSessionImport,
} from "./sessionRepository.ts";
import type { TokenUsage } from "../shared/sessionSchemas.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";

const tokens: TokenUsage = {
  uncachedInput: 3,
  cacheRead: 2,
  cacheWrite: 5,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  freshPrompt: 8,
  output: 4,
  reasoning: 1,
  processed: 15,
};

function importedSession(
  sourceID: number,
  externalID: string,
  parentExternalID?: string,
): SourceSessionImport {
  return {
    sourceID,
    externalID,
    parentExternalID,
    artifactPath: `/sessions/${externalID}.jsonl`,
    observedAt: 90,
    checkpoint: {
      sourceSize: 123,
      sourceModifiedAt: 80,
      checksum: `checksum-${externalID}`,
      parserVersion: "pi-1",
      importedAt: 100,
    },
    session: {
      title: externalID,
      agent: "pi",
      updatedAt: parentExternalID ? 30 : 20,
      startedAt: parentExternalID ? 11 : 10,
      endedAt: parentExternalID ? 31 : 21,
      providers: ["anthropic"],
      models: ["claude"],
      userTurns: 1,
      modelCalls: 1,
      reportedCost: 0,
      tokens,
      turns: [{
        number: 1,
        startedAt: parentExternalID ? 11 : 10,
        inputs: [{ kind: "text", preview: "hello", originalLength: 5 }],
        calls: [{
          id: `call-${externalID}`,
          callWithinTurn: 1,
          provider: "anthropic",
          model: "claude",
          startedAt: parentExternalID ? 12 : 11,
          completedAt: parentExternalID ? 13 : 12,
          reportedCost: 0,
          tokens,
          content: [{ kind: "text", preview: "answer", originalLength: 6 }],
          activity: {
            finishReason: "stop",
            hasText: true,
            hasReasoning: true,
            tools: [],
          },
        }],
      }],
      contextEvents: [{
        type: "compaction",
        sourceOrder: 2,
        occurredAt: 12,
        affectedCall: { turn: 1, call: 1 },
      }],
    },
  };
}

Deno.test("stores and reads canonical sessions atomically", () => {
  const directory = Deno.makeTempDirSync();
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  try {
    migrateTestDatabase(db);
    const sourceID = Number(
      (db.prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES ('pi', 'directory', 'PI', '/pi', 1)
      RETURNING id
    `).get() as { id: number }).id,
    );
    const repository = new SessionRepository(db);

    repository.replaceSourceSession(importedSession(sourceID, "root"));
    repository.replaceSourceSession(importedSession(sourceID, "child", "root"));
    const root = importedSession(sourceID, "root");
    root.session.turns[0].calls[0].activity.tools.push({
      sourceID: "tool-1",
      name: "subagent",
      status: "completed",
      startedAt: 11,
      completedAt: 12,
      childExternalID: "child",
      input: { preview: '{"path":"src/schema.ts"}' },
    });
    repository.replaceSourceSession(root);

    const listed = repository.listSessions(1, 10, "pi");
    strictEqual(listed.pagination.totalItems, 1);
    deepStrictEqual(listed.items.map(({ id }) => id), ["root"]);

    const detail = repository.getSession("pi", "root")!;
    strictEqual(detail.reportedCost, 0);
    strictEqual(detail.turns[0].calls[0].tokens.cacheWrite5m, 0);
    strictEqual(detail.turns[0].calls[0].tokens.cacheWrite1h, 0);
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].childSessionID,
      "child",
    );
    strictEqual(detail.turns[0].calls[0].preview, "answer");
    deepStrictEqual(detail.turns[0].calls[0].contextEventsBefore, [{
      type: "compaction",
      sourceOrder: 2,
      occurredAt: 12,
    }]);
    deepStrictEqual(detail.contextEvents, []);
    strictEqual(
      detail.turns[0].calls[0].activity.tools[0].inputPreview,
      '{"path":"src/schema.ts"}',
    );
    strictEqual(detail.subagents[0].id, "child");
    strictEqual(detail.subagents[0].parentID, "root");

    const usage = repository.listUsageCalls(12, "pi");
    deepStrictEqual(
      usage.map((call) => ({
        id: call.session.id,
        rootID: call.session.rootID,
        sessionStartedAt: call.sessionStartedAt,
      })),
      [{ id: "child", rootID: "root", sessionStartedAt: 10 }],
    );
    strictEqual(
      (db.prepare("SELECT COUNT(*) AS count FROM models").get() as {
        count: number;
      }).count,
      1,
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

    const codexSourceID = Number(
      (db.prepare(`
        INSERT INTO sources (harness, kind, label, location, created_at)
        VALUES ('codex', 'directory', 'Codex', '/codex', 1)
        RETURNING id
      `).get() as { id: number }).id,
    );
    const codex = importedSession(codexSourceID, "codex");
    codex.session.updatedAt = 100;
    repository.replaceSourceSession(codex);
    deepStrictEqual(
      repository.listSessions(1, 1).items.map(({ harness, id }) => ({
        harness,
        id,
      })),
      [{ harness: "codex", id: "codex" }],
    );
    strictEqual(repository.listSessions(1, 1).pagination.totalItems, 2);
    deepStrictEqual(
      repository.listSessions(2, 1).items.map(({ harness, id }) => ({
        harness,
        id,
      })),
      [{ harness: "pi", id: "root" }],
    );
    strictEqual(repository.listSessions(1, 10, "pi").pagination.totalItems, 1);
    deepStrictEqual(
      [...new Set(repository.listUsageCalls().map((call) => call.harness))]
        .sort(),
      ["codex", "pi"],
    );

    const invalid = importedSession(sourceID, "root");
    invalid.checkpoint.checksum = "must-roll-back";
    invalid.session.title = "must-roll-back";
    invalid.session.turns.push({ ...invalid.session.turns[0] });
    throws(() => repository.replaceSourceSession(invalid));
    strictEqual(repository.getSession("pi", "root")?.title, "root");
    const checkpoint = db.prepare(`
      SELECT checksum, imported_at FROM source_sessions
      WHERE source_id = ? AND external_id = 'root'
    `).get(sourceID)!;
    strictEqual(checkpoint.checksum, "checksum-root");
    strictEqual(checkpoint.imported_at, 100);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("atomically replaces trees with root-scoped public child IDs", () => {
  const directory = Deno.makeTempDirSync();
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  try {
    migrateTestDatabase(db);
    const sourceID = Number(
      (db.prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES ('claude-code', 'directory', 'Claude', '/claude', 1)
      RETURNING id
    `).get() as { id: number }).id,
    );
    const repository = new SessionRepository(db);

    const tree = (namespace: string): SourceSessionImport[] => {
      const root = importedSession(sourceID, `${namespace}:root`);
      root.publicID = namespace;
      root.session.turns[0].calls[0].activity.tools.push({
        name: "subagent",
        status: "completed",
        childExternalID: `${namespace}:child`,
      });
      const child = importedSession(
        sourceID,
        `${namespace}:child`,
        `${namespace}:root`,
      );
      child.publicID = "child";
      return [root, child];
    };

    repository.replaceSourceSessionTree(tree("root-a"));
    repository.replaceSourceSessionTree(tree("root-b"));

    deepStrictEqual(
      repository.listSessions(1, 10, "claude-code").items.map(({ id }) => id)
        .sort(),
      ["root-a", "root-b"],
    );
    for (const rootID of ["root-a", "root-b"]) {
      const detail = repository.getSession("claude-code", rootID)!;
      strictEqual(detail.subagents[0].id, "child");
      strictEqual(detail.subagents[0].parentID, rootID);
      strictEqual(
        detail.turns[0].calls[0].activity.tools[0].childSessionID,
        "child",
      );
    }

    const invalid = tree("root-a");
    invalid[0].session.title = "must-roll-back";
    invalid[0].checkpoint.checksum = "must-roll-back";
    invalid[1].session.turns.push({ ...invalid[1].session.turns[0] });
    throws(() => repository.replaceSourceSessionTree(invalid));
    strictEqual(
      repository.getSession("claude-code", "root-a")?.title,
      "root-a:root",
    );
    strictEqual(
      repository.getSession("claude-code", "root-a")?.subagents.length,
      1,
    );
    strictEqual(
      (db.prepare(`
        SELECT checksum FROM source_sessions
        WHERE source_id = ? AND external_id = 'root-a:root'
      `).get(sourceID) as { checksum: string }).checksum,
      "checksum-root-a:root",
    );

    const rootOnly = tree("root-a")[0];
    rootOnly.session.turns[0].calls[0].activity.tools = [];
    repository.replaceSourceSessionTree([rootOnly]);
    strictEqual(
      repository.getSession("claude-code", "root-a")?.subagents.length,
      0,
    );
    strictEqual(
      repository.getSession("claude-code", "root-b")?.subagents[0].id,
      "child",
    );
    deepStrictEqual(
      (db.prepare(`
        SELECT external_id FROM source_sessions
        WHERE source_id = ? AND public_id = 'child'
        ORDER BY external_id
      `).all(sourceID) as Array<{ external_id: string }>).map((row) =>
        row.external_id
      ),
      ["root-b:child"],
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("hides tagged context operations for Codex only", () => {
  const directory = Deno.makeTempDirSync();
  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  try {
    migrateTestDatabase(db);
    const repository = new SessionRepository(db);
    const source = (harness: "pi" | "codex") =>
      Number(
        (db.prepare(`
          INSERT INTO sources (harness, kind, label, location, created_at)
          VALUES (?, 'directory', ?, ?, 1) RETURNING id
        `).get(harness, harness, `/${harness}`) as { id: number }).id,
      );
    const pi = importedSession(source("pi"), "pi-operation");
    const codex = importedSession(source("codex"), "codex-operation");
    pi.session.turns[0].calls[0].id = "context-operation:1-1";
    codex.session.turns[0].calls[0].id = "context-operation:1-1";
    repository.replaceSourceSession(pi);
    repository.replaceSourceSession(codex);

    strictEqual(repository.getSession("pi", pi.externalID)?.turns.length, 1);
    strictEqual(
      repository.getSession("codex", codex.externalID)?.turns.length,
      0,
    );
    strictEqual(repository.listUsageCalls(undefined, "pi").length, 1);
    strictEqual(repository.listUsageCalls(undefined, "codex").length, 0);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
