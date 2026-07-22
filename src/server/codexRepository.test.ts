import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { CodexRepository } from "./codexRepository.ts";
import type { SessionDetail } from "../shared/sessionSchemas.ts";

function repository(files: Record<string, string>) {
  const directory = Deno.makeTempDirSync();
  for (const [relativePath, content] of Object.entries(files)) {
    const path = `${directory}/${relativePath}`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    Deno.mkdirSync(parent, { recursive: true });
    Deno.writeTextFileSync(path, content.trim());
  }
  return new CodexRepository(directory);
}

Deno.test("normalizes Codex JSONL sessions from token count events", () => {
  const actual = repository({
    "2026/07/11/rollout-2026-07-11T14-00-00-000Z.jsonl": `
{"timestamp":"2026-07-11T14:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.6-luna"}}
{"timestamp":"2026-07-11T14:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T14:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect Codex usage"}]}}
{"timestamp":"2026-07-11T14:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec_command","input":"tools.exec_command({\\"cmd\\":\\"ls\\"})"}}
{"timestamp":"2026-07-11T14:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":250,"output_tokens":80,"reasoning_output_tokens":20}}}}
{"timestamp":"2026-07-11T14:00:05.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"ok"}}
{"timestamp":"2026-07-11T14:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Done."}]}}
{"timestamp":"2026-07-11T14:00:07.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1300,"cached_input_tokens":1000,"output_tokens":30,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/11/rollout-2026-07-11T14-00-00-000Z");

  const expected: SessionDetail = {
    id: "2026/07/11/rollout-2026-07-11T14-00-00-000Z",
    harness: "codex",
    title: "Inspect Codex usage",
    updatedAt: Date.parse("2026-07-11T14:00:07.000Z"),
    startedAt: Date.parse("2026-07-11T14:00:01.000Z"),
    endedAt: Date.parse("2026-07-11T14:00:07.000Z"),
    providers: ["openai"],
    models: ["gpt-5.6-luna"],
    userTurns: 1,
    modelCalls: 2,
    tokens: {
      uncachedInput: 1050,
      cacheRead: 1250,
      cacheWrite: undefined,
      cacheWrite5m: undefined,
      cacheWrite1h: undefined,
      freshPrompt: 1050,
      output: 110,
      reasoning: 20,
      processed: 2430,
    },
    parentID: undefined,
    turns: [{
      number: 1,
      startedAt: Date.parse("2026-07-11T14:00:01.000Z"),
      calls: [
        {
          id: "1-1",
          callWithinTurn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
          startedAt: Date.parse("2026-07-11T14:00:04.000Z"),
          completedAt: Date.parse("2026-07-11T14:00:04.000Z"),
          tokens: {
            uncachedInput: 750,
            cacheRead: 250,
            cacheWrite: undefined,
            cacheWrite5m: undefined,
            cacheWrite1h: undefined,
            freshPrompt: 750,
            output: 80,
            reasoning: 20,
            processed: 1100,
          },
          activity: {
            hasText: false,
            hasReasoning: true,
            tools: [{
              name: "exec_command -> exec_command",
              status: "completed",
              startedAt: Date.parse("2026-07-11T14:00:03.000Z"),
              completedAt: Date.parse("2026-07-11T14:00:05.000Z"),
              inputPreview: 'tools.exec_command({"cmd":"ls"})',
              outputPreview: "ok",
            }],
          },
        },
        {
          id: "1-2",
          callWithinTurn: 2,
          preview: "Done.",
          provider: "openai",
          model: "gpt-5.6-luna",
          startedAt: Date.parse("2026-07-11T14:00:07.000Z"),
          completedAt: Date.parse("2026-07-11T14:00:07.000Z"),
          tokens: {
            uncachedInput: 300,
            cacheRead: 1000,
            cacheWrite: undefined,
            cacheWrite5m: undefined,
            cacheWrite1h: undefined,
            freshPrompt: 300,
            output: 30,
            reasoning: 0,
            processed: 1330,
          },
          activity: {
            hasText: true,
            hasReasoning: false,
            tools: [],
          },
        },
      ],
    }],
    subagents: [],
  };

  deepStrictEqual(actual, expected);
});

Deno.test("normalizes exported Codex session arrays", () => {
  const actual = repository({
    "rollout_exported.jsonl": JSON.stringify([
      {
        timestamp: "2026-05-22T02:08:00.000Z",
        type: "event_msg",
        payload: { type: "task_started" },
      },
      {
        timestamp: "2026-05-22T02:08:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Imported session" }],
        },
      },
      {
        timestamp: "2026-05-22T02:08:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: null },
      },
      {
        timestamp: "2026-05-22T02:08:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 7963,
            },
          },
        },
      },
    ]),
  }).getSession("rollout_exported");

  deepStrictEqual(actual?.title, "Imported session");
  deepStrictEqual(actual?.modelCalls, 1);
  deepStrictEqual(actual?.tokens.processed, 7963);
});

Deno.test("counts Codex input images without retaining data URLs", () => {
  const actual = repository({
    "2026/07/21/rollout-images.jsonl": `
{"timestamp":"2026-07-21T17:57:30.000Z","type":"turn_context","payload":{"model":"gpt-5.6-terra"}}
{"timestamp":"2026-07-21T17:57:31.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-21T17:57:32.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<image name=[Image #1]>"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="},{"type":"input_text","text":"</image>"}]}}
{"timestamp":"2026-07-21T17:57:33.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/21/rollout-images");

  strictEqual(actual?.turns[0].calls[0].activity.images, 1);
});

Deno.test("falls back to legacy Codex user-message records", () => {
  const actual = repository({
    "2026/02/05/rollout-legacy.jsonl": `
{"timestamp":"2026-02-05T14:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Inspect legacy usage"}}
{"timestamp":"2026-02-05T14:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.3-codex"}}
{"timestamp":"2026-02-05T14:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":4}}}}
{"timestamp":"2026-02-05T14:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":4}}}}
{"timestamp":"2026-02-05T14:00:04.000Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-02-05T14:00:05.000Z","type":"event_msg","payload":{"type":"user_message","message":"Continue"}}
{"timestamp":"2026-02-05T14:00:06.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":8,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/02/05/rollout-legacy")!;

  strictEqual(actual.title, "Inspect legacy usage");
  strictEqual(actual.userTurns, 2);
  strictEqual(actual.modelCalls, 2);
  deepStrictEqual(actual.tokens, {
    uncachedInput: 70,
    cacheRead: 150,
    cacheWrite: undefined,
    cacheWrite5m: undefined,
    cacheWrite1h: undefined,
    freshPrompt: 70,
    output: 18,
    reasoning: 4,
    processed: 242,
  });
  deepStrictEqual(actual.turns[1].calls[0].contextEventsBefore, [{
    type: "compaction",
    sourceOrder: 5,
    occurredAt: Date.parse("2026-02-05T14:00:04.000Z"),
  }]);
});

Deno.test("does not fall back for startup-only Codex transcripts", () => {
  const actual = repository({
    "2026/02/05/rollout-startup.jsonl": `
{"timestamp":"2026-02-05T14:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}
{"timestamp":"2026-02-05T14:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"<environment_context>"}}
`,
  }).getSession("2026/02/05/rollout-startup")!;

  strictEqual(actual.modelCalls, 0);
  strictEqual(actual.userTurns, 0);
});

Deno.test("lists Codex sessions recursively by latest transcript timestamp", () => {
  const result = repository({
    "2026/07/10/rollout-old.jsonl": `
{"timestamp":"2026-07-10T10:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.4"}}
{"timestamp":"2026-07-10T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-10T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
    "2026/07/11/rollout-new.jsonl": `
{"timestamp":"2026-07-11T10:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.4"}}
{"timestamp":"2026-07-11T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-11T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).listSessions(1, 10);

  deepStrictEqual(
    result.items.map((item) => item.id),
    ["2026/07/11/rollout-new", "2026/07/10/rollout-old"],
  );
});
