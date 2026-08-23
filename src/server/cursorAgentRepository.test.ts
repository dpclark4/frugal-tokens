import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  cursorParserVersion,
  normalizeCursorSession,
  readCursorCapture,
  syncCursorAgentSessions,
} from "./cursorAgentRepository.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";

Deno.test("normalizes Cursor capture usage onto its matching request", () => {
  const directory = Deno.makeTempDirSync();
  const capturePath = `${directory}/events.jsonl`;
  Deno.writeTextFileSync(
    capturePath,
    [
      JSON.stringify({
        kind: "response-start",
        flowId: "flow-1",
        startedAt: 1_000,
      }),
      JSON.stringify({
        kind: "usage",
        requestId: "request-1",
        flowId: "flow-1",
        usageSequence: 1,
        inputTokens: 10,
        outputTokens: 2,
      }),
      JSON.stringify({
        kind: "usage",
        requestId: "request-1",
        flowId: "flow-1",
        usageSequence: 2,
        inputTokens: 12,
        cacheReadTokens: 8,
        outputTokens: 3,
        reportedCost: 0.01,
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        kind: "response-end",
        flowId: "flow-1",
        endedAt: 2_500,
      }),
      "{",
    ].join("\n"),
  );

  const capture = readCursorCapture(capturePath);
  const session = normalizeCursorSession({
    candidate: {
      id: "agent-1",
      storePath: "unused",
      artifactPath: "unused",
      metaPath: "unused",
      updatedAt: 3_000,
      sourceModifiedAt: 3_000,
      size: 1,
      changeHint: "changed",
      fileMeta: { createdAtMs: 500, updatedAtMs: 3_000 },
      storeMeta: {},
    },
    snapshot: {
      storeMeta: {},
      fileMeta: { createdAtMs: 500, updatedAtMs: 3_000 },
      rootBlobId: "root",
      messages: [
        {
          role: "user",
          content: "Inspect the import",
          providerOptions: { cursor: { requestId: "request-1" } },
        },
        {
          role: "assistant",
          content: [{
            type: "text",
            text: "The import is ready.",
            providerOptions: { cursor: { modelName: "claude-sonnet-4-6" } },
          }],
        },
      ],
    },
    capture,
    sourceID: 1,
    observedAt: 4_000,
    checkpoint: { parserVersion: "test" },
  });

  strictEqual(capture.malformedLines, 1);
  deepStrictEqual(session.session, {
    title: "Inspect the import",
    agent: undefined,
    updatedAt: 3_000,
    startedAt: 500,
    endedAt: 3_000,
    providers: ["cursor"],
    models: ["claude-sonnet-4-6"],
    userTurns: 1,
    modelCalls: 1,
    reportedCost: 0.01,
    tokens: {
      uncachedInput: 12,
      cacheRead: 8,
      cacheWrite: undefined,
      freshPrompt: 12,
      output: 3,
      reasoning: 0,
      processed: 23,
    },
    turns: [{
      number: 1,
      startedAt: 1_000_000,
      inputs: [{
        kind: "text",
        preview: "Inspect the import",
        originalLength: 18,
        truncated: false,
      }],
      calls: [{
        id: "request-1",
        callWithinTurn: 1,
        preview: "Inspect the import",
        responsePreview: "The import is ready.",
        responseOriginalLength: 20,
        responseTruncated: false,
        provider: "cursor",
        model: "claude-sonnet-4-6",
        startedAt: 1_000_000,
        completedAt: 2_500_000,
        reportedCost: 0.01,
        tokens: {
          uncachedInput: 12,
          cacheRead: 8,
          cacheWrite: undefined,
          freshPrompt: 12,
          output: 3,
          reasoning: 0,
          processed: 23,
        },
        activity: {
          hasText: true,
          hasReasoning: false,
          images: undefined,
          tools: [],
        },
        content: [{
          kind: "text",
          preview: "The import is ready.",
          originalLength: 20,
          truncated: false,
        }],
      }],
    }],
  });
});

function cursorStore(options: {
  directory: string;
  workspace: string;
  id: string;
  parentID?: string;
  toolCallID?: string;
  messages: unknown[];
}) {
  const path = `${options.directory}/${options.workspace}/${options.id}`;
  Deno.mkdirSync(path, { recursive: true });
  Deno.writeTextFileSync(
    `${path}/meta.json`,
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      hasConversation: true,
      cwd: "/workspace/cursor",
    }),
  );
  const db = new DatabaseSync(`${path}/store.db`);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT, value TEXT);
      CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
    `);
    const rootID = "aa".repeat(32);
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
      JSON.stringify(
        options.parentID === undefined
          ? {
            agentId: options.id,
            latestRootBlobId: rootID,
            name: `Agent ${options.id}`,
            createdAt: 1_000,
          }
          : {
            agentId: options.id,
            latestRootBlobId: rootID,
            name: `Agent ${options.id}`,
            createdAt: 1_000,
            subagentInfo: {
              parentAgentId: options.parentID,
              rootParentAgentId: options.parentID,
              toolCallId: options.toolCallID,
              typeName: "cursor-subagent",
            },
          },
      ),
    );
    const references = options.messages.map((_, index) =>
      (index + 1).toString(16).padStart(64, "0")
    );
    const root = Uint8Array.from(references.flatMap((reference) => [
      10,
      32,
      ...Uint8Array.from(reference.match(/../g)!, (pair) => parseInt(pair, 16)),
    ]));
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(rootID, root);
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    for (let index = 0; index < options.messages.length; index++) {
      insert.run(
        references[index],
        new TextEncoder().encode(JSON.stringify(options.messages[index])),
      );
    }
  } finally {
    db.close();
  }
}

Deno.test("Cursor canonical synchronization preserves tree topology and last-good data", () => {
  const directory = Deno.makeTempDirSync();
  cursorStore({
    directory,
    workspace: "workspace",
    id: "root-agent",
    messages: [{
      role: "user",
      content: "Delegate this",
      providerOptions: { cursor: { requestId: "root-request" } },
    }, {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "launch-child",
        toolName: "task",
        args: { prompt: "Inspect" },
      }, { type: "text", text: "Delegated." }],
    }],
  });
  cursorStore({
    directory,
    workspace: "workspace",
    id: "child-agent",
    parentID: "root-agent",
    toolCallID: "launch-child",
    messages: [{
      role: "user",
      content: "Inspect",
      providerOptions: { cursor: { requestId: "child-request" } },
    }, {
      role: "assistant",
      content: [{ type: "text", text: "Inspected." }],
    }],
  });

  const capturePath = `${directory}/events.jsonl`;
  Deno.writeTextFileSync(
    capturePath,
    ["root-request", "child-request"].map((requestId) =>
      JSON.stringify({
        kind: "usage",
        requestId,
        inputTokens: 10,
        outputTokens: 2,
      })
    ).join("\n"),
  );

  const db = openArchiveDatabase(":memory:");
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const writer = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  try {
    const first = syncCursorAgentSessions(
      directory,
      capturePath,
      sources,
      writer,
    );
    strictEqual(first.imported, 2);
    const detail = reads.getSession("cursor", "root-agent")!;
    strictEqual(detail.subagents.length, 1);
    strictEqual(detail.subagents[0].id, "child-agent");

    const unchanged = syncCursorAgentSessions(
      directory,
      capturePath,
      sources,
      writer,
    );
    strictEqual(unchanged.skipped, 2);

    const sourceID = sources.ensureSource(
      "cursor",
      "directory",
      "Cursor",
      directory,
    );
    db.prepare(`
      UPDATE artifact_import_projections SET parser_version = 'stale'
      WHERE projection_name = 'conversation'
        AND source_session_id IN (
          SELECT id FROM source_sessions WHERE source_id = ?
        )
    `).run(sourceID);
    const lastGood = reads.getSession("cursor", "root-agent")!;
    const replace = writer.replaceLinearConversationTree.bind(writer);
    writer.replaceLinearConversationTree = () => {
      throw new Error("forced conversation failure");
    };
    const failed = syncCursorAgentSessions(
      directory,
      capturePath,
      sources,
      writer,
    );
    writer.replaceLinearConversationTree = replace;
    strictEqual(failed.failed, 2);
    deepStrictEqual(reads.getSession("cursor", "root-agent"), lastGood);
    strictEqual(
      sources.projectionCheckpoint(sourceID, "root-agent")?.lastError,
      "forced conversation failure",
    );

    const recovered = syncCursorAgentSessions(
      directory,
      capturePath,
      sources,
      writer,
    );
    strictEqual(recovered.imported, 2);
    strictEqual(
      sources.projectionCheckpoint(sourceID, "root-agent")?.parserVersion,
      cursorParserVersion,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
