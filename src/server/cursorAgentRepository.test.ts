import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  normalizeCursorSession,
  readCursorCapture,
} from "./cursorAgentRepository.ts";

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
