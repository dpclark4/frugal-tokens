import { deepStrictEqual } from "node:assert/strict";
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
