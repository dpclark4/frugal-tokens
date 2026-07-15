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
