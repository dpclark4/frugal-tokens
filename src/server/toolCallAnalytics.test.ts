import { deepStrictEqual, strictEqual } from "node:assert";
import { aggregateToolCalls, toolGroupName } from "./toolCallAnalytics.ts";

Deno.test("toolGroupName expands shell tools across harness formats", () => {
  strictEqual(toolGroupName("bash", '{"command":"mkdir output"}', true), "bash mkdir");
  strictEqual(toolGroupName("Bash", "deno task check", true), "bash deno");
  strictEqual(toolGroupName("bash", '{"command":"mkdir output"}', false), "bash");
  strictEqual(
    toolGroupName(
      "exec -> exec_command",
      'const r = await tools.exec_command({cmd:"jq -c select(.) file.jsonl",workdir:"/tmp"});',
      true,
    ),
    "exec -> exec_command jq",
  );
  strictEqual(toolGroupName("read", '{"path":"README.md"}', true), "read");
});

Deno.test("aggregateToolCalls calculates event-weighted runtime distributions", () => {
  const result = aggregateToolCalls([
    {
      modelCallID: 1,
      name: "read",
      startedAt: 100,
      completedAt: 200,
      modelStartedAt: 0,
      modelCompletedAt: 1_000,
    },
    {
      modelCallID: 1,
      name: "read",
      startedAt: 200,
      completedAt: 500,
      modelStartedAt: 0,
      modelCompletedAt: 1_000,
    },
    {
      modelCallID: 2,
      name: "bash",
      inputPreview: '{"command":"mkdir output"}',
      startedAt: 300,
      completedAt: 500,
      modelStartedAt: 0,
      modelCompletedAt: 2_000,
    },
  ], 30, 0, 3_000, true);

  strictEqual(result.tools[0].tool, "read");
  strictEqual(result.tools[0].count, 2);
  strictEqual(result.tools[0].modelCalls, 1);
  strictEqual(result.tools[0].callsPerModelCall, 2);
  deepStrictEqual(result.tools[0].toolRuntime, {
    average: 200,
    median: 200,
    p95: 290,
  });
  deepStrictEqual(result.tools[0].modelRuntime, {
    average: 1_000,
    median: 1_000,
    p95: 1_000,
  });
  strictEqual(result.tools[1].tool, "bash mkdir");
});
