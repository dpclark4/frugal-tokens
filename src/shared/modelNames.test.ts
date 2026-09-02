import { canonicalModelId, displayModelName } from "./modelNames.ts";

Deno.test("formats known model IDs consistently", () => {
  const cases = {
    "claude-opus-5": "Claude Opus 5",
    "claude-fable-5.1": "Claude Fable 5.1",
    "claude-mythos-5-1": "Claude Mythos 5.1",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251201": "Claude Haiku 4.5",
    "gpt-5.6-terra": "GPT 5.6 Terra",
    "grok-4-5": "Grok 4.5",
    "grok-4-6": "Grok 4.6",
    "grok-4.6": "Grok 4.6",
    "kimi-k3": "Kimi K3",
    "moonshotai/kimi-k3": "Kimi K3",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "minimax/minimax-m3": "MiniMax M3",
    "grok-build-0.1": "Grok Build 0.1",
    "muse-spark-1.2": "Muse Spark 1.2",
    "gemini-3.8-flash": "Gemini 3.8 Flash",
    "google/gemini-3.7-flash": "Gemini 3.7 Flash",
  };

  for (const [model, expected] of Object.entries(cases)) {
    if (displayModelName(model) !== expected) {
      throw new Error(
        `${model} formatted as ${
          displayModelName(model)
        }, expected ${expected}`,
      );
    }
  }
});

Deno.test("formats unknown IDs without losing their identity", () => {
  if (displayModelName("gpt-9.1-future") !== "GPT 9.1 Future") {
    throw new Error("unknown model IDs should receive a readable fallback");
  }
});

Deno.test("formats Bedrock Anthropic IDs as their base model", () => {
  const cases = {
    "anthropic.claude-opus-4-7": "Claude Opus 4.7",
    "us.anthropic.claude-opus-4-8": "Claude Opus 4.8",
    "us.anthropic.claude-opus-4-7-v1:0": "Claude Opus 4.7",
    "anthropic/claude-opus-4.8": "Claude Opus 4.8",
  };

  for (const [model, expected] of Object.entries(cases)) {
    if (displayModelName(model) !== expected) {
      throw new Error(
        `${model} formatted as ${
          displayModelName(model)
        }, expected ${expected}`,
      );
    }
  }

  if (canonicalModelId("us.anthropic.claude-opus-4-7") !== "claude-opus-4-7") {
    throw new Error("Bedrock IDs should canonicalize to the base model ID");
  }
});
