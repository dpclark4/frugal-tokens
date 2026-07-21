import { displayModelName } from "./modelNames.ts";

Deno.test("formats known model IDs consistently", () => {
  const cases = {
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251201": "Claude Haiku 4.5",
    "gpt-5.6-terra": "GPT 5.6 Terra",
    "grok-4-5": "Grok 4.5",
  };

  for (const [model, expected] of Object.entries(cases)) {
    if (displayModelName(model) !== expected) {
      throw new Error(
        `${model} formatted as ${displayModelName(model)}, expected ${expected}`,
      );
    }
  }
});

Deno.test("formats unknown IDs without losing their identity", () => {
  if (displayModelName("gpt-9.1-future") !== "GPT 9.1 Future") {
    throw new Error("unknown model IDs should receive a readable fallback");
  }
});
