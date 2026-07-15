import { deepStrictEqual } from "node:assert/strict";
import { PiRepository } from "./piRepository.ts";
import type { SessionDetail } from "../shared/sessionSchemas.ts";

function repository(files: Record<string, string>) {
  const directory = Deno.makeTempDirSync();
  for (const [relativePath, content] of Object.entries(files)) {
    const path = `${directory}/${relativePath}`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    Deno.mkdirSync(parent, { recursive: true });
    Deno.writeTextFileSync(path, content.trim());
  }
  return new PiRepository(directory);
}

Deno.test("normalizes PI JSONL sessions with tool activity and reported cost", () => {
  const actual = repository({
    "--Users-test-project--/2026-07-11T13-36-32-689Z_session.jsonl": `
{"type":"session","version":3,"id":"session","timestamp":"2026-07-11T13:36:32.689Z","cwd":"/Users/test/project"}
{"type":"model_change","id":"model","parentId":null,"timestamp":"2026-07-11T13:36:33.000Z","provider":"anthropic","modelId":"claude-opus-4-8"}
{"type":"message","id":"user-1","parentId":"model","timestamp":"2026-07-11T13:36:55.000Z","message":{"role":"user","content":[{"type":"text","text":"Inspect sessions"}]}}
{"type":"message","id":"assistant-1","parentId":"user-1","timestamp":"2026-07-11T13:36:59.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll inspect them."},{"type":"toolCall","id":"tool-1","name":"bash","arguments":{"command":"ls"}}],"provider":"anthropic","model":"claude-opus-4-8","usage":{"input":2,"output":183,"cacheRead":0,"cacheWrite":2231,"cacheWrite1h":100,"totalTokens":2516,"reasoning":0,"cost":{"total":0.01852875}},"stopReason":"toolUse"}}
{"type":"message","id":"tool-result-1","parentId":"assistant-1","timestamp":"2026-07-11T13:37:00.000Z","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}}
{"type":"message","id":"assistant-2","parentId":"tool-result-1","timestamp":"2026-07-11T13:37:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"provider":"anthropic","model":"claude-opus-4-8","usage":{"input":3,"output":10,"cacheRead":2231,"cacheWrite":0,"cacheWrite1h":0,"totalTokens":2244,"reasoning":4,"cost":{"total":0.004}},"stopReason":"stop"}}
`,
  }).getSession("--Users-test-project--/2026-07-11T13-36-32-689Z_session");

  const expected: SessionDetail = {
    id: "--Users-test-project--/2026-07-11T13-36-32-689Z_session",
    harness: "pi",
    title: "Inspect sessions",
    updatedAt: Date.parse("2026-07-11T13:37:05.000Z"),
    startedAt: Date.parse("2026-07-11T13:36:55.000Z"),
    endedAt: Date.parse("2026-07-11T13:37:05.000Z"),
    providers: ["anthropic"],
    models: ["claude-opus-4-8"],
    userTurns: 1,
    modelCalls: 2,
    reportedCost: 0.02252875,
    tokens: {
      uncachedInput: 5,
      cacheRead: 2231,
      cacheWrite: 2231,
      cacheWrite5m: 2131,
      cacheWrite1h: 100,
      freshPrompt: 2236,
      output: 193,
      reasoning: 4,
      processed: 4760,
    },
    parentID: undefined,
    turns: [{
      number: 1,
      startedAt: Date.parse("2026-07-11T13:36:55.000Z"),
      calls: [
        {
          id: "assistant-1",
          callWithinTurn: 1,
          preview: "I'll inspect them.",
          provider: "anthropic",
          model: "claude-opus-4-8",
          startedAt: Date.parse("2026-07-11T13:36:59.000Z"),
          completedAt: Date.parse("2026-07-11T13:36:59.000Z"),
          reportedCost: 0.01852875,
          tokens: {
            uncachedInput: 2,
            cacheRead: 0,
            cacheWrite: 2231,
            cacheWrite5m: 2131,
            cacheWrite1h: 100,
            freshPrompt: 2233,
            output: 183,
            reasoning: 0,
            processed: 2516,
          },
          activity: {
            finishReason: "toolUse",
            hasText: true,
            hasReasoning: false,
            tools: [{
              name: "bash",
              status: "completed",
              startedAt: Date.parse("2026-07-11T13:36:59.000Z"),
              completedAt: Date.parse("2026-07-11T13:37:00.000Z"),
              inputPreview: '{"command":"ls"}',
              outputPreview: "ok",
            }],
          },
        },
        {
          id: "assistant-2",
          callWithinTurn: 2,
          preview: "Done.",
          provider: "anthropic",
          model: "claude-opus-4-8",
          startedAt: Date.parse("2026-07-11T13:37:05.000Z"),
          completedAt: Date.parse("2026-07-11T13:37:05.000Z"),
          reportedCost: 0.004,
          tokens: {
            uncachedInput: 3,
            cacheRead: 2231,
            cacheWrite: undefined,
            cacheWrite5m: undefined,
            cacheWrite1h: undefined,
            freshPrompt: 3,
            output: 10,
            reasoning: 4,
            processed: 2244,
          },
          activity: {
            finishReason: "stop",
            hasText: true,
            hasReasoning: true,
            tools: [],
          },
        },
      ],
    }],
    subagents: [],
  };

  deepStrictEqual(actual, expected);
});
