import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { CodexRepository, normalizeCodexSession } from "./codexRepository.ts";
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
    endedAt: Date.parse("2026-07-11T14:00:06.000Z"),
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
      inputs: [{
        kind: "text",
        preview: "Inspect Codex usage",
        originalLength: 19,
        truncated: false,
      }],
      calls: [
        {
          id: "1-1",
          callWithinTurn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
          startedAt: Date.parse("2026-07-11T14:00:02.000Z"),
          completedAt: Date.parse("2026-07-11T14:00:03.000Z"),
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
          startedAt: Date.parse("2026-07-11T14:00:05.000Z"),
          completedAt: Date.parse("2026-07-11T14:00:06.000Z"),
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

Deno.test("starts a turn for each Codex user message within a task", () => {
  const actual = repository({
    "2026/07/25/rollout-user-boundaries.jsonl": `
{"timestamp":"2026-07-25T19:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.5","effort":"medium"}}
{"timestamp":"2026-07-25T19:00:00.001Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T19:00:00.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}}
{"timestamp":"2026-07-25T19:00:00.003Z","type":"event_msg","payload":{"type":"user_message","message":"first"}}
{"timestamp":"2026-07-25T19:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"one"}]}}
{"timestamp":"2026-07-25T19:00:01.001Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-25T19:00:01.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}}
{"timestamp":"2026-07-25T19:00:01.003Z","type":"event_msg","payload":{"type":"user_message","message":"second"}}
{"timestamp":"2026-07-25T19:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"two"}]}}
{"timestamp":"2026-07-25T19:00:02.001Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":11,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-25T19:00:02.002Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T19:00:02.003Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"third"}]}}
{"timestamp":"2026-07-25T19:00:02.004Z","type":"event_msg","payload":{"type":"user_message","message":"third"}}
{"timestamp":"2026-07-25T19:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"three"}]}}
{"timestamp":"2026-07-25T19:00:03.001Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":12,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-25T19:00:03.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fourth"}]}}
{"timestamp":"2026-07-25T19:00:03.003Z","type":"event_msg","payload":{"type":"user_message","message":"fourth"}}
{"timestamp":"2026-07-25T19:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"four"}]}}
{"timestamp":"2026-07-25T19:00:04.001Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":13,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/25/rollout-user-boundaries")!;

  strictEqual(actual.userTurns, 4);
  strictEqual(actual.modelCalls, 4);
  deepStrictEqual(
    actual.turns.map((turn) => turn.inputs?.[0]?.preview),
    ["first", "second", "third", "fourth"],
  );
  deepStrictEqual(actual.turns.map((turn) => turn.calls.length), [1, 1, 1, 1]);
});

Deno.test("applies Codex reasoning settings to the turn that changes them", () => {
  const actual = repository({
    "2026/07/25/rollout-thinking.jsonl": `
{"timestamp":"2026-07-25T18:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T18:00:00.001Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","collaboration_mode":{"settings":{"reasoning_effort":"low"}}}}
{"timestamp":"2026-07-25T18:00:00.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}}
{"timestamp":"2026-07-25T18:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-25T18:00:02.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T18:00:02.001Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","collaboration_mode":{"settings":{"reasoning_effort":"medium"}}}}
{"timestamp":"2026-07-25T18:00:02.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}}
{"timestamp":"2026-07-25T18:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/25/rollout-thinking")!;

  deepStrictEqual(
    actual.turns.map((turn) => turn.reasoningSetting?.settingValue),
    ["low", "medium"],
  );
  deepStrictEqual(
    actual.turns.flatMap((turn) =>
      turn.calls.map((call) => call.reasoningSetting?.settingValue)
    ),
    ["low", "medium"],
  );
});

Deno.test("ignores null Codex reasoning effort and falls back", () => {
  const actual = repository({
    "2026/07/25/rollout-null-effort.jsonl": `
{"timestamp":"2026-07-25T18:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T18:00:00.001Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":null,"developer_instructions":null}}}}
{"timestamp":"2026-07-25T18:00:00.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}}
{"timestamp":"2026-07-25T18:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-25T18:00:02.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T18:00:02.001Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","collaboration_mode":{"settings":{"reasoning_effort":null}},"thread_settings":{"reasoning_effort":"low"}}}
{"timestamp":"2026-07-25T18:00:02.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}}
{"timestamp":"2026-07-25T18:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/25/rollout-null-effort")!;

  deepStrictEqual(actual.turns.length, 2);
  deepStrictEqual(
    actual.turns.map((turn) => turn.reasoningSetting?.settingValue),
    [undefined, "low"],
  );
  deepStrictEqual(
    actual.turns[1].reasoningSetting?.sourceFieldPath,
    "payload.thread_settings.reasoning_effort",
  );
});

Deno.test("imports Codex sessions that report a null reasoning effort", () => {
  const text = `
{"timestamp":"2026-07-25T18:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-25T18:00:00.001Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":null,"developer_instructions":null}}}}
{"timestamp":"2026-07-25T18:00:00.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}}
{"timestamp":"2026-07-25T18:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`.trim();

  const actual = normalizeCodexSession({
    id: "2026/07/25/rollout-null-effort",
    path: "2026/07/25/rollout-null-effort.jsonl",
    artifactPath: "2026/07/25/rollout-null-effort.jsonl",
    updatedAt: 0,
    size: text.length,
  }, text);

  strictEqual(actual.turns.length, 1);
  strictEqual(actual.turns[0].reasoningSetting, undefined);
  strictEqual(actual.summary.models[0], "gpt-5.6-sol");
});

Deno.test("infers Codex model-call timing around tool loops", () => {
  const actual = repository({
    "2026/07/24/rollout-timing.jsonl": `
{"timestamp":"2026-07-24T15:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1784905200,"model_context_window":258400}}
{"timestamp":"2026-07-24T15:00:00.050Z","type":"turn_context","payload":{"model":"gpt-5.6-luna"}}
{"timestamp":"2026-07-24T15:00:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"dealers choice"}]}}
{"timestamp":"2026-07-24T15:00:00.100Z","type":"event_msg","payload":{"type":"user_message","message":"dealers choice"}}
{"timestamp":"2026-07-24T15:00:01.000Z","type":"response_item","payload":{"type":"reasoning","summary":[]}}
{"timestamp":"2026-07-24T15:00:02.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"tools.exec({\\"cmd\\":\\"pwd\\"})"}}
{"timestamp":"2026-07-24T15:00:02.200Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"/tmp"}}
{"timestamp":"2026-07-24T15:00:02.200Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":2}}}}
{"timestamp":"2026-07-24T15:00:03.000Z","type":"response_item","payload":{"type":"reasoning","summary":[]}}
{"timestamp":"2026-07-24T15:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Done."}]}}
{"timestamp":"2026-07-24T15:00:04.010Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":8,"reasoning_output_tokens":0}}}}
{"timestamp":"2026-07-24T15:00:04.500Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","started_at":1784905200,"completed_at":1784905204,"duration_ms":4500,"time_to_first_token_ms":900}}
`,
  }).getSession("2026/07/24/rollout-timing")!;

  strictEqual(actual.turns.length, 1);
  strictEqual(actual.turns[0].calls.length, 2);
  strictEqual(
    actual.turns[0].calls[0].startedAt,
    Date.parse("2026-07-24T15:00:00.100Z"),
  );
  strictEqual(
    actual.turns[0].calls[0].completedAt,
    Date.parse("2026-07-24T15:00:02.000Z"),
  );
  strictEqual(
    actual.turns[0].calls[1].startedAt,
    Date.parse("2026-07-24T15:00:02.200Z"),
  );
  strictEqual(
    actual.turns[0].calls[1].completedAt,
    Date.parse("2026-07-24T15:00:04.000Z"),
  );
  strictEqual(
    actual.turns[0].calls[0].activity.tools[0].completedAt,
    Date.parse("2026-07-24T15:00:02.200Z"),
  );
});

Deno.test("does not invent zero-duration Codex calls without boundaries", () => {
  const actual = repository({
    "2026/07/24/rollout-unknown-timing.jsonl": `
{"timestamp":"2026-07-24T15:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-24T15:00:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-07-24T15:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":2}}}}
`,
  }).getSession("2026/07/24/rollout-unknown-timing")!;

  strictEqual(
    actual.turns[0].calls[0].startedAt,
    Date.parse("2026-07-24T15:00:00.100Z"),
  );
  strictEqual(actual.turns[0].calls[0].completedAt, undefined);
});

Deno.test("prefers Codex user_message over startup instructions for titles", () => {
  const actual = repository({
    "2026/07/24/rollout-title.jsonl": `
{"timestamp":"2026-07-24T15:18:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/example/project"}]}}
{"timestamp":"2026-07-24T15:18:02.001Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-07-24T15:18:02.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}
{"timestamp":"2026-07-24T15:18:02.003Z","type":"event_msg","payload":{"type":"user_message","message":"hi","images":[]}}
{"timestamp":"2026-07-24T15:18:02.004Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/07/24/rollout-title")!;

  strictEqual(actual.title, "hi");
});

Deno.test("prefers completed Codex UserMessage over startup instructions for titles", () => {
  const actual = repository({
    "2026/08/22/rollout-completed-title.jsonl": `
{"timestamp":"2026-08-22T16:29:49.489Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/example/project"}]}}
{"timestamp":"2026-08-22T16:29:49.605Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the importer"}]}}
{"timestamp":"2026-08-22T16:29:49.606Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"Fix the importer"}]}}}
{"timestamp":"2026-08-22T16:29:50.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}
`,
  }).getSession("2026/08/22/rollout-completed-title")!;

  strictEqual(actual.title, "Fix the importer");
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
    compaction: {
      trigger: "unknown",
      resultKind: "unavailable",
      checkpointCompleteness: "unknown",
      nativeMetadata: { captureIssues: ["compacted-record-missing"] },
      checkpointItems: [],
    },
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
