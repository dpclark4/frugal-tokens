import { strictEqual } from "node:assert/strict";
import type { TokenUsage } from "../shared/sessionSchemas.ts";
import { computeModelCallCost } from "./pricing.ts";

const timestamp = Date.parse("2026-07-15T00:00:00Z");

function tokens(values: Partial<TokenUsage>): TokenUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    freshPrompt: 0,
    output: 0,
    reasoning: 0,
    processed: 0,
    ...values,
  };
}

function closeTo(actual: number | undefined, expected: number) {
  strictEqual(
    actual !== undefined && Math.abs(actual - expected) < 1e-10,
    true,
  );
}

Deno.test("switches GPT pricing at the long-context boundary", () => {
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 271_999 }),
      "gpt-5.6-sol",
      timestamp,
    ),
    271_999 * 5 / 1_000_000,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 272_000 }),
      "gpt-5.6-sol",
      timestamp,
    ),
    272_000 * 10 / 1_000_000,
  );
});

Deno.test("uses long-context rates for every priced token category", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 100_000,
        cacheRead: 100_000,
        cacheWrite: 72_000,
        output: 8_000,
        reasoning: 2_000,
      }),
      "gpt-5.6-sol",
      timestamp,
    ),
    2.45,
  );
});

Deno.test("uses the published long-context model rates", () => {
  const expected = new Map([
    ["gpt-5.6-sol", 55],
    ["gpt-5.6-terra", 27.5],
    ["gpt-5.6-luna", 11],
    ["gpt-5.5", 55],
    ["gpt-5.5-pro", 330],
    ["gpt-5.4", 27.5],
    ["gpt-5.4-pro", 330],
  ]);
  for (const [model, cost] of expected) {
    closeTo(
      computeModelCallCost(
        tokens({ uncachedInput: 1_000_000, output: 1_000_000 }),
        model,
        timestamp,
      ),
      cost,
    );
  }
});

Deno.test("uses Luna and Terra prices effective July 30 at 4 PM Eastern", () => {
  const before = Date.parse("2026-07-30T19:59:59.999Z");
  const effectiveAt = Date.parse("2026-07-30T20:00:00Z");
  const cases = [
    ["gpt-5.6-terra", 2.5, 2, 5, 4],
    ["gpt-5.6-luna", 1, 0.2, 2, 0.4],
  ] as const;

  for (const [model, oldShort, newShort, oldLong, newLong] of cases) {
    closeTo(
      computeModelCallCost(tokens({ uncachedInput: 100_000 }), model, before),
      oldShort / 10,
    );
    closeTo(
      computeModelCallCost(tokens({ uncachedInput: 100_000 }), model, effectiveAt),
      newShort / 10,
    );
    closeTo(
      computeModelCallCost(tokens({ uncachedInput: 1_000_000 }), model, before),
      oldLong,
    );
    closeTo(
      computeModelCallCost(
        tokens({ uncachedInput: 1_000_000 }),
        model,
        effectiveAt,
      ),
      newLong,
    );
  }
});

Deno.test("prices Claude Opus 5 at its published rates", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 2_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        output: 1_000_000,
      }),
      "claude-opus-5",
      timestamp,
    ),
    46.75,
  );
});

Deno.test("prices Kimi K3 cache hits, misses, writes, and output", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "moonshotai/kimi-k3",
      timestamp,
    ),
    21.3,
  );
});

Deno.test("prices Codex models at their published rates", () => {
  const expected = new Map([
    ["gpt-5.3-codex", 15.925],
    ["gpt-5.2-codex", 15.925],
    ["gpt-5-codex", 11.375],
    ["gpt-5.1-codex-max", 11.375],
    ["gpt-5.1-codex", 11.38],
    ["gpt-5.1-codex-mini", 2.275],
  ]);
  for (const [model, cost] of expected) {
    closeTo(
      computeModelCallCost(
        tokens({ uncachedInput: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }),
        model,
        timestamp,
      ),
      cost,
    );
  }
});

Deno.test("uses the published Codex rates for long contexts", () => {
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 272_000 }),
      "gpt-5.3-codex",
      timestamp,
    ),
    0.476,
  );
});

Deno.test("leaves models without long-context rates unpriced", () => {
  strictEqual(
    computeModelCallCost(
      tokens({ uncachedInput: 272_000 }),
      "gpt-5.4-mini",
      timestamp,
    ),
    undefined,
  );
  strictEqual(
    computeModelCallCost(
      tokens({ uncachedInput: 272_000 }),
      "gpt-5.4-nano",
      timestamp,
    ),
    undefined,
  );
});

Deno.test("leaves aggregate-only usage unpriced", () => {
  strictEqual(
    computeModelCallCost(
      tokens({ processed: 7_963 }),
      "gpt-5.6-sol",
      timestamp,
    ),
    undefined,
  );
});

Deno.test("prices each call from its own effective context size", () => {
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 300_000 }),
      "gpt-5.6-sol",
      timestamp,
    ),
    3,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 100_000 }),
      "gpt-5.6-sol",
      timestamp,
    ),
    0.5,
  );
});
