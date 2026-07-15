import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { TokenUsage } from "./sessionSchemas.ts";
import { contextRange, contextSize } from "./contextMetrics.ts";

function tokens(
  uncachedInput: number,
  cacheRead = 0,
  cacheWrite?: number,
): TokenUsage {
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    freshPrompt: uncachedInput,
    output: 0,
    reasoning: 0,
    processed: uncachedInput + cacheRead + (cacheWrite ?? 0),
  };
}

Deno.test("context size includes every input-side token category", () => {
  strictEqual(contextSize(tokens(10, 20, 30)), 60);
});

Deno.test("context range finds chronological endpoints and peak request", () => {
  const calls = [
    { id: "latest", startedAt: 30, tokens: tokens(80) },
    { id: "first", startedAt: 10, tokens: tokens(100) },
    { id: "peak", startedAt: 20, tokens: tokens(300) },
  ];
  const range = contextRange(calls);
  deepStrictEqual(
    {
      first: range.first?.call.id,
      latest: range.latest?.call.id,
      peak: range.peak?.call.id,
      firstSize: range.first?.size,
      latestSize: range.latest?.size,
      peakSize: range.peak?.size,
    },
    {
      first: "first",
      latest: "latest",
      peak: "peak",
      firstSize: 100,
      latestSize: 80,
      peakSize: 300,
    },
  );
});
