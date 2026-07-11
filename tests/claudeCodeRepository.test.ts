import { deepStrictEqual } from "node:assert/strict";
import { ClaudeCodeRepository } from "../src/server/claudeCodeRepository.ts";
import type { SessionDetail } from "../src/shared/sessionSchemas.ts";

function repository(files: Record<string, string>) {
  const directory = Deno.makeTempDirSync();
  for (const [relativePath, content] of Object.entries(files)) {
    const path = `${directory}/${relativePath}`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    Deno.mkdirSync(parent, { recursive: true });
    Deno.writeTextFileSync(path, content.trim());
  }
  return new ClaudeCodeRepository(directory);
}

Deno.test("normalizes model changes without creating command turns", () => {
  const actual = repository({
    "model-switch.jsonl": `
{"type":"user","uuid":"user-sonnet","timestamp":"2026-06-25T19:51:53.000Z","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"Start with Sonnet"}}
{"type":"assistant","uuid":"sonnet-thinking","timestamp":"2026-06-25T19:51:54.000Z","message":{"id":"call-sonnet","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"Considering the request"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20}}}}
{"type":"assistant","uuid":"sonnet-text","timestamp":"2026-06-25T19:51:55.000Z","message":{"id":"call-sonnet","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"text","text":"Sonnet response"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20}}}}
{"type":"user","uuid":"model-caveat","timestamp":"2026-06-25T19:52:00.000Z","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Generated while running a command</local-command-caveat>"}}
{"type":"user","uuid":"model-command","timestamp":"2026-06-25T19:52:00.000Z","message":{"role":"user","content":"<command-name>/model</command-name>"}}
{"type":"user","uuid":"model-output","timestamp":"2026-06-25T19:52:00.000Z","message":{"role":"user","content":"<local-command-stdout>Set model to Opus</local-command-stdout>"}}
{"type":"user","uuid":"user-opus","timestamp":"2026-06-25T19:52:01.000Z","message":{"role":"user","content":"❯ Continue with Opus"}}
{"type":"assistant","uuid":"opus-text","timestamp":"2026-06-25T19:52:02.000Z","message":{"id":"call-opus","role":"assistant","model":"claude-opus-4-7","stop_reason":"end_turn","content":[{"type":"text","text":"Opus response"}],"usage":{"input_tokens":5,"cache_read_input_tokens":50,"cache_creation_input_tokens":15,"output_tokens":25,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":15}}}}
{"type":"ai-title","aiTitle":"Switch models","timestamp":"2026-06-25T19:52:03.000Z"}
`,
  }).getSession("model-switch");
  const expected: SessionDetail = {
    id: "model-switch",
    harness: "claude-code",
    title: "Switch models",
    updatedAt: Date.parse("2026-06-25T19:52:03.000Z"),
    providers: ["anthropic"],
    models: ["claude-sonnet-4-5", "claude-opus-4-7"],
    userTurns: 2,
    modelCalls: 2,
    tokens: {
      uncachedInput: 15,
      cacheRead: 70,
      cacheWrite: 45,
      cacheWrite5m: 10,
      cacheWrite1h: 35,
      freshPrompt: 60,
      output: 65,
      reasoning: 0,
      processed: 195,
    },
    parentID: undefined,
    turns: [
      {
        number: 1,
        startedAt: Date.parse("2026-06-25T19:51:53.000Z"),
        calls: [{
          id: "call-sonnet",
          callWithinTurn: 1,
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          startedAt: Date.parse("2026-06-25T19:51:54.000Z"),
          completedAt: Date.parse("2026-06-25T19:51:55.000Z"),
          tokens: {
            uncachedInput: 10,
            cacheRead: 20,
            cacheWrite: 30,
            cacheWrite5m: 10,
            cacheWrite1h: 20,
            freshPrompt: 40,
            output: 40,
            reasoning: 0,
            processed: 100,
          },
          activity: {
            finishReason: "end_turn",
            hasText: true,
            hasReasoning: true,
            tools: [],
          },
        }],
      },
      {
        number: 2,
        startedAt: Date.parse("2026-06-25T19:52:01.000Z"),
        calls: [{
          id: "call-opus",
          callWithinTurn: 1,
          provider: "anthropic",
          model: "claude-opus-4-7",
          startedAt: Date.parse("2026-06-25T19:52:02.000Z"),
          completedAt: Date.parse("2026-06-25T19:52:02.000Z"),
          tokens: {
            uncachedInput: 5,
            cacheRead: 50,
            cacheWrite: 15,
            cacheWrite5m: 0,
            cacheWrite1h: 15,
            freshPrompt: 20,
            output: 25,
            reasoning: 0,
            processed: 95,
          },
          activity: {
            finishReason: "end_turn",
            hasText: true,
            hasReasoning: false,
            tools: [],
          },
        }],
      },
    ],
    subagents: [],
  };

  deepStrictEqual(actual, expected);
});

Deno.test("normalizes an SDK prompt and deduplicates streamed usage", () => {
  const actual = repository({
    "sdk-session.jsonl": `
{"type":"user","uuid":"sdk-user","timestamp":"2026-06-25T20:00:00.000Z","promptSource":"sdk","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"sdk-thinking","timestamp":"2026-06-25T20:00:01.000Z","message":{"id":"sdk-call","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"Respond briefly"}],"usage":{"input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":12,"output_tokens":8,"cache_creation":{"ephemeral_5m_input_tokens":12,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","uuid":"sdk-text","timestamp":"2026-06-25T20:00:02.000Z","message":{"id":"sdk-call","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"text","text":"Hi!"}],"usage":{"input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":12,"output_tokens":8,"cache_creation":{"ephemeral_5m_input_tokens":12,"ephemeral_1h_input_tokens":0}}}}
{"type":"last-prompt","lastPrompt":"hi","timestamp":"2026-06-25T20:00:03.000Z"}
`,
  }).getSession("sdk-session");
  const expected: SessionDetail = {
    id: "sdk-session",
    harness: "claude-code",
    title: "hi",
    updatedAt: Date.parse("2026-06-25T20:00:03.000Z"),
    providers: ["anthropic"],
    models: ["claude-sonnet-4-5"],
    userTurns: 1,
    modelCalls: 1,
    tokens: {
      uncachedInput: 2,
      cacheRead: 100,
      cacheWrite: 12,
      cacheWrite5m: 12,
      cacheWrite1h: 0,
      freshPrompt: 14,
      output: 8,
      reasoning: 0,
      processed: 122,
    },
    parentID: undefined,
    turns: [{
      number: 1,
      startedAt: Date.parse("2026-06-25T20:00:00.000Z"),
      calls: [{
        id: "sdk-call",
        callWithinTurn: 1,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        startedAt: Date.parse("2026-06-25T20:00:01.000Z"),
        completedAt: Date.parse("2026-06-25T20:00:02.000Z"),
        tokens: {
          uncachedInput: 2,
          cacheRead: 100,
          cacheWrite: 12,
          cacheWrite5m: 12,
          cacheWrite1h: 0,
          freshPrompt: 14,
          output: 8,
          reasoning: 0,
          processed: 122,
        },
        activity: {
          finishReason: "end_turn",
          hasText: true,
          hasReasoning: true,
          tools: [],
        },
      }],
    }],
    subagents: [],
  };

  deepStrictEqual(actual, expected);
});

Deno.test("normalizes a linked subagent without folding child usage into parent", () => {
  const actual = repository({
    "parent.jsonl": `
{"type":"user","uuid":"parent-user","timestamp":"2026-06-25T21:00:00.000Z","promptSource":"typed","origin":{"kind":"human"},"message":{"role":"user","content":"Delegate this task"}}
{"type":"assistant","uuid":"parent-agent-call","timestamp":"2026-06-25T21:00:01.000Z","message":{"id":"parent-call-1","role":"assistant","model":"claude-opus-4-7","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tool-agent","name":"Agent"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20}}}}
{"type":"user","uuid":"parent-agent-result","timestamp":"2026-06-25T21:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-agent"}]},"toolUseResult":{"agentId":"child"}}
{"type":"assistant","uuid":"parent-final","timestamp":"2026-06-25T21:00:04.000Z","message":{"id":"parent-call-2","role":"assistant","model":"claude-opus-4-7","stop_reason":"end_turn","content":[{"type":"text","text":"Parent final response"}],"usage":{"input_tokens":2,"cache_read_input_tokens":60,"cache_creation_input_tokens":8,"output_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":8}}}}
{"type":"ai-title","aiTitle":"Delegate work","timestamp":"2026-06-25T21:00:05.000Z"}
`,
    "parent/subagents/agent-child.jsonl": `
{"type":"user","uuid":"child-user","timestamp":"2026-06-25T21:00:01.500Z","isSidechain":true,"message":{"role":"user","content":"Investigate the issue"}}
{"type":"assistant","uuid":"child-final","timestamp":"2026-06-25T21:00:02.500Z","isSidechain":true,"message":{"id":"child-call","role":"assistant","model":"claude-sonnet-4-5","stop_reason":"end_turn","content":[{"type":"text","text":"Child result"}],"usage":{"input_tokens":7,"cache_read_input_tokens":11,"cache_creation_input_tokens":13,"output_tokens":17,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":10}}}}
`,
    "parent/subagents/agent-child.meta.json": `
{"agentType":"Explore","description":"Investigate issue","toolUseId":"tool-agent","spawnDepth":1}
`,
  }).getSession("parent");
  const expected: SessionDetail = {
    id: "parent",
    harness: "claude-code",
    title: "Delegate work",
    updatedAt: Date.parse("2026-06-25T21:00:05.000Z"),
    providers: ["anthropic"],
    models: ["claude-opus-4-7"],
    userTurns: 1,
    modelCalls: 2,
    tokens: {
      uncachedInput: 12,
      cacheRead: 80,
      cacheWrite: 38,
      cacheWrite5m: 10,
      cacheWrite1h: 28,
      freshPrompt: 50,
      output: 15,
      reasoning: 0,
      processed: 145,
    },
    parentID: undefined,
    turns: [{
      number: 1,
      startedAt: Date.parse("2026-06-25T21:00:00.000Z"),
      calls: [
        {
          id: "parent-call-1",
          callWithinTurn: 1,
          provider: "anthropic",
          model: "claude-opus-4-7",
          startedAt: Date.parse("2026-06-25T21:00:01.000Z"),
          completedAt: Date.parse("2026-06-25T21:00:01.000Z"),
          tokens: {
            uncachedInput: 10,
            cacheRead: 20,
            cacheWrite: 30,
            cacheWrite5m: 10,
            cacheWrite1h: 20,
            freshPrompt: 40,
            output: 5,
            reasoning: 0,
            processed: 65,
          },
          activity: {
            finishReason: "tool_use",
            hasText: false,
            hasReasoning: false,
            tools: [{
              name: "Agent",
              status: "completed",
              startedAt: Date.parse("2026-06-25T21:00:01.000Z"),
              completedAt: Date.parse("2026-06-25T21:00:03.000Z"),
              childSessionID: "child",
            }],
          },
        },
        {
          id: "parent-call-2",
          callWithinTurn: 2,
          provider: "anthropic",
          model: "claude-opus-4-7",
          startedAt: Date.parse("2026-06-25T21:00:04.000Z"),
          completedAt: Date.parse("2026-06-25T21:00:04.000Z"),
          tokens: {
            uncachedInput: 2,
            cacheRead: 60,
            cacheWrite: 8,
            cacheWrite5m: 0,
            cacheWrite1h: 8,
            freshPrompt: 10,
            output: 10,
            reasoning: 0,
            processed: 80,
          },
          activity: {
            finishReason: "end_turn",
            hasText: true,
            hasReasoning: false,
            tools: [],
          },
        },
      ],
    }],
    subagents: [{
      id: "child",
      harness: "claude-code",
      title: "Investigate issue",
      updatedAt: Date.parse("2026-06-25T21:00:02.500Z"),
      providers: ["anthropic"],
      models: ["claude-sonnet-4-5"],
      userTurns: 1,
      modelCalls: 1,
      tokens: {
        uncachedInput: 7,
        cacheRead: 11,
        cacheWrite: 13,
        cacheWrite5m: 3,
        cacheWrite1h: 10,
        freshPrompt: 20,
        output: 17,
        reasoning: 0,
        processed: 48,
      },
      parentID: "parent",
      turns: [{
        number: 1,
        startedAt: Date.parse("2026-06-25T21:00:01.500Z"),
        calls: [{
          id: "child-call",
          callWithinTurn: 1,
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          startedAt: Date.parse("2026-06-25T21:00:02.500Z"),
          completedAt: Date.parse("2026-06-25T21:00:02.500Z"),
          tokens: {
            uncachedInput: 7,
            cacheRead: 11,
            cacheWrite: 13,
            cacheWrite5m: 3,
            cacheWrite1h: 10,
            freshPrompt: 20,
            output: 17,
            reasoning: 0,
            processed: 48,
          },
          activity: {
            finishReason: "end_turn",
            hasText: true,
            hasReasoning: false,
            tools: [],
          },
        }],
      }],
      subagents: [],
    }],
  };

  deepStrictEqual(actual, expected);
});
