import { strictEqual, throws } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import type { LinearConversationImport } from "./conversationImportTypes.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import { computeModelCallCost } from "./pricing.ts";

const tokens = {
  uncachedInput: 10,
  cacheRead: 5,
  freshPrompt: 10,
  output: 2,
  reasoning: 1,
  processed: 18,
};

function linearImport(sourceID: number): LinearConversationImport {
  return {
    sourceID,
    externalID: "linear",
    artifactPath: "linear.jsonl",
    observedAt: 1,
    checkpoint: {
      sourceSize: 100,
      sourceModifiedAt: 1,
      checksum: "checksum",
      parserVersion: "test-1",
    },
    session: {
      title: "Last good",
      updatedAt: 3,
      startedAt: 1,
      endedAt: 3,
      providers: ["openai"],
      models: ["gpt-5.6-sol"],
      userTurns: 1,
      modelCalls: 1,
      tokens,
      turns: [{
        number: 1,
        startedAt: 1,
        inputs: [{
          kind: "text",
          preview: "Prompt",
          originalLength: 6,
          truncated: false,
        }],
        calls: [{
          id: "call-1",
          callWithinTurn: 1,
          provider: "openai",
          model: "gpt-5.6-sol",
          startedAt: 2,
          completedAt: 3,
          reportedCost: 99,
          tokens,
          activity: {
            hasText: true,
            hasReasoning: true,
            tools: [],
          },
          content: [{
            kind: "text",
            preview: "Answer",
            originalLength: 6,
            truncated: false,
          }],
        }],
      }],
    },
  };
}

Deno.test("an authoritative imported title replaces a generated title", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "pi",
      "directory",
      "Pi",
      "/sessions",
    );
    const value = linearImport(sourceID);
    value.session.title = "Prompt";
    sources.recordUnchangedArtifact(
      sourceID,
      value.externalID,
      value.artifactPath!,
      value.observedAt,
    );
    conversations.replaceLinearConversation(value);
    db.prepare(`
      UPDATE source_sessions SET generated_title = 'Generated summary'
      WHERE source_id = ? AND external_id = ?
    `).run(sourceID, value.externalID);

    conversations.replaceLinearConversation(value);
    strictEqual(reads.getSession("pi", "linear")?.title, "Generated summary");

    value.session.title = "User supplied name";
    conversations.replaceLinearConversation(value);
    strictEqual(reads.getSession("pi", "linear")?.title, "User supplied name");
    strictEqual(
      db.prepare(`
        SELECT generated_title FROM source_sessions
        WHERE source_id = ? AND external_id = ?
      `).get(sourceID, value.externalID)?.generated_title,
      null,
    );
  } finally {
    db.close();
  }
});

Deno.test("linear conversation replacement is idempotent and transactional", () => {
  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const conversations = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const sourceID = sources.ensureSource(
      "codex",
      "directory",
      "Codex",
      "/sessions",
    );
    const value = linearImport(sourceID);
    sources.recordUnchangedArtifact(
      sourceID,
      value.externalID,
      value.artifactPath!,
      value.observedAt,
    );
    conversations.replaceLinearConversation(value);
    const conversationID = db.prepare(
      "SELECT id FROM conversations WHERE external_id = 'linear'",
    ).get()!.id;

    conversations.replaceLinearConversation(value);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_branches").get()!
        .count,
      1,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT computed_cost FROM conversation_model_calls").get()!
        .computed_cost,
      computeModelCallCost(tokens, "gpt-5.6-sol", 2),
    );
    strictEqual(
      db.prepare(
        "SELECT COUNT(*) AS count FROM artifact_model_call_occurrences",
      )
        .get()!.count,
      1,
    );
    strictEqual(
      db.prepare("SELECT id FROM conversations WHERE external_id = 'linear'")
        .get()!.id,
      conversationID,
    );

    const invalid = structuredClone(value);
    invalid.session.title = "Must roll back";
    invalid.session.userTurns = 2;
    invalid.session.modelCalls = 2;
    invalid.session.turns.push(structuredClone(invalid.session.turns[0]));
    throws(
      () => conversations.replaceLinearConversation(invalid),
      /constraint|UNIQUE/i,
    );
    strictEqual(
      db.prepare("SELECT title FROM conversations WHERE external_id = 'linear'")
        .get()!.title,
      "Last good",
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      1,
    );
    strictEqual(reads.getSession("codex", "linear")?.title, "Last good");

    const reusedSourceIDs = structuredClone(value);
    reusedSourceIDs.session.title = "Repeated native IDs";
    reusedSourceIDs.session.updatedAt = 5;
    reusedSourceIDs.session.endedAt = 5;
    reusedSourceIDs.session.userTurns = 2;
    reusedSourceIDs.session.modelCalls = 2;
    const repeatedTool = {
      sourceID: "reused-tool-id",
      name: "read",
      status: "completed",
      outputPreview: "result",
    };
    reusedSourceIDs.session.turns[0].calls[0].activity.tools = [repeatedTool];
    const secondTurn = structuredClone(reusedSourceIDs.session.turns[0]);
    secondTurn.number = 2;
    secondTurn.startedAt = 4;
    secondTurn.calls[0].startedAt = 4;
    secondTurn.calls[0].completedAt = 5;
    reusedSourceIDs.session.turns.push(secondTurn);

    conversations.replaceLinearConversation(reusedSourceIDs);
    conversations.replaceLinearConversation(reusedSourceIDs);
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_model_calls")
        .get()!.count,
      2,
    );
    strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_tool_events")
        .get()!.count,
      2,
    );
    strictEqual(
      db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_entries
        WHERE stable_source_id IS NOT NULL
      `).get()!.count,
      6,
    );
  } finally {
    db.close();
  }
});
