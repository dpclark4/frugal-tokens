import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import {
  repriceUnpricedSessions,
  SessionRepricingService,
} from "./sessionRepricing.ts";
import type { LinearConversationImport } from "./conversationImportTypes.ts";

Deno.test("repricing summarizes batches above five sessions", () => {
  for (const count of [5, 6]) {
    const db = openArchiveDatabase(":memory:");
    migrateTestDatabase(db);
    const originalInfo = console.info;
    const logs: string[] = [];
    try {
      const sources = new SourceArtifactRepository(db);
      const sourceID = sources.ensureSource(
        "pi",
        "directory",
        "Pi",
        "/sessions",
      );
      const writer = new ConversationWriteRepository(db);
      for (let i = 0; i < count; i++) {
        const id = `session-${i}`;
        sources.recordUnchangedArtifact(sourceID, id, `${id}.jsonl`, 1);
        writer.replaceLinearConversation(session(
          sourceID,
          id,
          i === 0 ? "muse-spark-1.3" : "unknown-model",
        ));
      }
      db.exec("UPDATE conversation_model_calls SET computed_cost = NULL");
      console.info = (message: string) => logs.push(message);
      repriceUnpricedSessions(db);
      if (count > 5) {
        deepStrictEqual(logs, [
          "[reprice] sessions=6 updated=1 not_updated=5 failed=0",
        ]);
      } else {
        strictEqual(logs.length, 5);
        strictEqual(
          logs.every((line) => line.startsWith("[reprice] session=")),
          true,
        );
      }
    } finally {
      console.info = originalInfo;
      db.close();
    }
  }
});

function session(
  sourceID: number,
  externalID: string,
  model: string,
  parentExternalID?: string,
): LinearConversationImport {
  const tokens = {
    uncachedInput: 1_000_000,
    cacheRead: 0,
    freshPrompt: 1_000_000,
    output: 0,
    reasoning: 0,
    processed: 1_000_000,
  };
  return {
    sourceID,
    externalID,
    parentExternalID,
    observedAt: 1,
    checkpoint: {},
    session: {
      title: externalID,
      reportedCost: 99,
      updatedAt: 2,
      providers: ["meta"],
      models: [model],
      userTurns: 1,
      modelCalls: 1,
      tokens,
      turns: [{
        number: 1,
        startedAt: 1,
        calls: [{
          id: "call-1",
          callWithinTurn: 1,
          provider: "meta",
          model,
          startedAt: 1,
          completedAt: 2,
          reportedCost: 99,
          tokens,
          activity: { hasText: true, hasReasoning: false, tools: [] },
        }],
      }],
    },
  };
}

Deno.test("reprices stored sessions and subagents, preserving unknown and zero prices", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  try {
    const sources = new SourceArtifactRepository(db);
    const sourceID = sources.ensureSource("pi", "directory", "Pi", "/sessions");
    for (const id of ["root", "child", "unknown", "zero"]) {
      sources.recordUnchangedArtifact(sourceID, id, `${id}.jsonl`, 1);
    }
    const writer = new ConversationWriteRepository(db);
    writer.replaceLinearConversationTree([
      session(sourceID, "root", "muse-spark-1.3"),
      session(sourceID, "child", "muse-spark-1.3-contributor", "root"),
      session(sourceID, "unknown", "unknown-model", "root"),
    ]);
    writer.replaceLinearConversation(
      session(sourceID, "zero", "unknown-model"),
    );
    db.exec(`UPDATE conversation_model_calls SET computed_cost = NULL;
      UPDATE conversation_model_calls SET computed_cost = 0 WHERE conversation_id =
        (SELECT id FROM conversations WHERE external_id = 'zero');
      UPDATE conversation_rollups SET computed_cost = NULL, summary_json = NULL;`);
    const rootID = Number(
      db.prepare("SELECT id FROM conversations WHERE external_id = 'root'")
        .get()!.id,
    );
    const service = new SessionRepricingService(db);
    deepStrictEqual(service.findUnpricedSessionIDs(), [rootID]);
    deepStrictEqual(service.repriceSessions([rootID, rootID]), [{
      conversationID: rootID,
      updatedCalls: 2,
      remainingUnpricedCalls: 1,
    }]);
    const stored = db.prepare(
      "SELECT computed_cost, overview_json, summary_json FROM conversation_rollups WHERE conversation_id = ?",
    ).get(rootID)!;
    strictEqual(stored.computed_cost, 1.25);
    const summary = JSON.parse(String(stored.summary_json));
    strictEqual(summary.computedCost, 1.25);
    strictEqual(summary.reportedCost, 99);
    const overview = JSON.parse(String(stored.overview_json));
    strictEqual(overview.days[0].cost, 100.35);
    strictEqual(
      db.prepare(
        "SELECT computed_cost FROM conversation_model_calls WHERE model = 'muse-spark-1.3-contributor'",
      ).get()!.computed_cost,
      0.1,
    );
    deepStrictEqual(service.repriceSessions([rootID]), [{
      conversationID: rootID,
      updatedCalls: 0,
      remainingUnpricedCalls: 1,
    }]);
    throws(() => service.repriceSessions([-1]), /Unknown root/);
    // A failed session must not leave a transaction open.
    deepStrictEqual(service.findUnpricedSessionIDs(), [rootID]);
  } finally {
    db.close();
  }
});

Deno.test("fully repriced sessions leave the post-import candidate scan", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  try {
    const sourceID = new SourceArtifactRepository(db).ensureSource(
      "pi",
      "directory",
      "Pi",
      "/sessions",
    );
    new SourceArtifactRepository(db).recordUnchangedArtifact(
      sourceID,
      "root",
      "root.jsonl",
      1,
    );
    new ConversationWriteRepository(db).replaceLinearConversation(
      session(sourceID, "root", "muse-spark-1.3-contributor-free"),
    );
    db.exec("UPDATE conversation_model_calls SET computed_cost = NULL");
    const service = new SessionRepricingService(db);
    const [result] = service.repriceSessions(service.findUnpricedSessionIDs());
    strictEqual(result.updatedCalls, 1);
    strictEqual(result.remainingUnpricedCalls, 0);
    strictEqual(
      db.prepare("SELECT computed_cost FROM conversation_model_calls").get()!
        .computed_cost,
      0,
    );
    deepStrictEqual(service.findUnpricedSessionIDs(), []);
  } finally {
    db.close();
  }
});
