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

Deno.test("prices GPT-6 Astra at its short and long context rates", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 50_000,
        cacheRead: 50_000,
        cacheWrite: 50_000,
        output: 50_000,
      }),
      "gpt-6-astra",
      timestamp,
    ),
    3.675,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "gpt-6-astra",
      timestamp,
    ),
    122,
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
      computeModelCallCost(
        tokens({ uncachedInput: 100_000 }),
        model,
        effectiveAt,
      ),
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

Deno.test("uses Sol prices effective August 21 at 5 PM Eastern", () => {
  const before = Date.parse("2026-08-21T20:59:59.999Z");
  const effectiveAt = Date.parse("2026-08-21T21:00:00Z");
  const shortTokens = tokens({
    uncachedInput: 100_000,
    cacheRead: 50_000,
    cacheWrite: 50_000,
    output: 100_000,
  });
  const longTokens = tokens({
    uncachedInput: 300_000,
    cacheRead: 50_000,
    cacheWrite: 50_000,
    output: 100_000,
  });

  closeTo(computeModelCallCost(shortTokens, "gpt-5.6-sol", before), 3.8375);
  closeTo(
    computeModelCallCost(shortTokens, "gpt-5.6-sol", effectiveAt),
    2.67,
  );
  closeTo(computeModelCallCost(longTokens, "gpt-5.6-sol", before), 8.175);
  closeTo(
    computeModelCallCost(longTokens, "gpt-5.6-sol", effectiveAt),
    5.94,
  );
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

Deno.test("prices Claude Fable and Mythos 5.1 at published rates", () => {
  for (const model of ["claude-fable-5-1", "claude-mythos-5.1"]) {
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
        model,
        timestamp,
      ),
      92.75,
    );
  }
});

Deno.test("prices Gemini Flash models before and after the 2027 rate change", () => {
  const before = Date.parse("2026-12-31T23:59:59.999Z");
  const effectiveAt = Date.parse("2027-01-01T00:00:00Z");
  for (const model of ["gemini-3.8-flash", "google/gemini-3.7-flash"]) {
    const usage = tokens({
      uncachedInput: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });
    closeTo(computeModelCallCost(usage, model, before), 4.575);
    closeTo(computeModelCallCost(usage, model, effectiveAt), 9.15);
  }
});

Deno.test("normalizes OpenRouter Anthropic model IDs for pricing", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 0,
        output: 1_000_000,
      }),
      "openrouter/anthropic/claude-haiku-4.5",
      timestamp,
    ),
    7.35,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 1_000_000 }),
      "anthropic/claude-haiku-4-5-20251001",
      timestamp,
    ),
    1,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "claude-haiku-4-5",
      timestamp,
    ),
    7.25,
  );
});

Deno.test("prices GLM 5.2 through provider aliases", () => {
  for (const model of ["glm-5.2", "z-ai/glm-5.2"]) {
    closeTo(
      computeModelCallCost(
        tokens({
          uncachedInput: 1_000_000,
          cacheRead: 1_000_000,
          output: 1_000_000,
        }),
        model,
        timestamp,
      ),
      6.06,
    );
  }
});

Deno.test("prices GLM 5, 5.1, and 5.3 at published rates", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "glm-5",
      timestamp,
    ),
    4.4,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "z-ai/glm-5.1",
      timestamp,
    ),
    6.06,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "glm-5.3",
      timestamp,
    ),
    6.06,
  );
});

Deno.test("prices missing GPT 5 family models at OpenAI rates", () => {
  const expected = new Map([
    ["gpt-5.2", 1.5925],
    ["gpt-5.1", 1.1375],
    ["gpt-5", 1.1375],
    ["gpt-5-mini", 0.2275],
    ["gpt-5-nano", 0.0455],
  ]);
  for (const [model, cost] of expected) {
    closeTo(
      computeModelCallCost(
        tokens({ uncachedInput: 100_000, cacheRead: 100_000, output: 100_000 }),
        model,
        timestamp,
      ),
      cost,
    );
  }
});

Deno.test("prices Kimi K2 and MiniMax models at published rates", () => {
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "moonshotai/kimi-k2.7-code",
      timestamp,
    ),
    6.09,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "kimi-k2.6",
      timestamp,
    ),
    5.11,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "kimi-k2.5",
      timestamp,
    ),
    3.7,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 511_999 }),
      "minimax-m3",
      timestamp,
    ),
    511_999 * 0.3 / 1_000_000,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 512_000 }),
      "minimax/minimax-m3",
      timestamp,
    ),
    512_000 * 0.6 / 1_000_000,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "minimax-m2.7",
      timestamp,
    ),
    1.935,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      }),
      "minimax-m2.5",
      timestamp,
    ),
    1.905,
  );
});

Deno.test("prices Grok Build and Muse Spark at published rates", () => {
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 199_999 }),
      "grok-build-0.1",
      timestamp,
    ),
    199_999 / 1_000_000,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 200_000 }),
      "xai/grok-build-0.1",
      timestamp,
    ),
    0.4,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "muse-spark-1.2",
      timestamp,
    ),
    5.65,
  );
});

Deno.test("keeps Claude Sonnet 5 at its published $2/$10 rates", () => {
  for (
    const at of [
      Date.parse("2026-08-31T23:59:59.999Z"),
      Date.parse("2026-09-01T00:00:00Z"),
    ]
  ) {
    closeTo(
      computeModelCallCost(
        tokens({ uncachedInput: 1_000_000 }),
        "openrouter/anthropic/claude-sonnet-5",
        at,
      ),
      2,
    );
  }
});

Deno.test("prices Grok 4.5 and 4.6 at the 200k long-context boundary", () => {
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 199_999 }),
      "grok-4.5",
      timestamp,
    ),
    199_999 * 2 / 1_000_000,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 200_000 }),
      "xai/grok-4-5",
      timestamp,
    ),
    0.8,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 50_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "grok-4.5",
      timestamp,
    ),
    12.8,
  );
  closeTo(
    computeModelCallCost(
      tokens({ uncachedInput: 100_000 }),
      "grok-4-6",
      timestamp,
    ),
    0.2,
  );
  closeTo(
    computeModelCallCost(
      tokens({
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
      "grok-4.6",
      timestamp,
    ),
    17,
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
        tokens({
          uncachedInput: 1_000_000,
          cacheRead: 1_000_000,
          output: 1_000_000,
        }),
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
  for (
    const model of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2", "gpt-5-nano"]
  ) {
    strictEqual(
      computeModelCallCost(
        tokens({ uncachedInput: 272_000 }),
        model,
        timestamp,
      ),
      undefined,
    );
  }
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
