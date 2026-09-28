import { modelMetadata } from "../../shared/modelMetadata.ts";
import { modelColor } from "./modelColors.ts";

function color(model: string) {
  return modelColor({ model, ...modelMetadata(model) });
}

function lightness(model: string) {
  return Number(color(model).match(/^oklch\((\S+)/)?.[1]);
}

Deno.test("reference pricing makes Astra darker than Sol and Sol darker than Luna", () => {
  if (
    !(lightness("gpt-6-astra") < lightness("gpt-6-sol")) ||
    !(lightness("gpt-6-sol") < lightness("gpt-6-luna"))
  ) throw new Error("OpenAI shades must follow reference prices");
});

Deno.test("Astra and Sol have a stronger lightness separation", () => {
  if (lightness("gpt-6-sol") - lightness("gpt-6-astra") < 0.12) {
    throw new Error("Astra and Sol need distinct lightness levels");
  }
  if (Math.abs(lightness("gpt-5.5-pro") - 0.42) > 1e-10) {
    throw new Error("Prices above $30 must clamp to the darkest shade");
  }
});

Deno.test("reference pricing compares Anthropic families regardless of generation", () => {
  if (!(lightness("claude-fable-5-1") < lightness("claude-opus-5-5"))) {
    throw new Error(
      "Fable's higher reference price must produce a darker shade",
    );
  }
});

Deno.test("equal prices have equal shades regardless of name and age", () => {
  if (color("gpt-5.1-codex-max") !== color("gpt-5.1-codex")) {
    throw new Error("Max must not imply a higher price");
  }
  if (color("claude-fable-5") !== color("claude-fable-5-1")) {
    throw new Error("Generation must not alter equal-price shades");
  }
});

Deno.test("Cursor routing and quality aliases use the base model shade", () => {
  for (const base of ["claude-sonnet-4-6", "gpt-5.1-codex-max"]) {
    for (const suffix of ["high", "medium", "low", "max", "fast", "slow"]) {
      if (color(`${base}-${suffix}`) !== color(base)) {
        throw new Error(`${base}-${suffix} must use its base model's rates`);
      }
    }
  }
  if (color("gpt-99-unknown-high") !== "oklch(0.68 0.025 250)") {
    throw new Error("Unsupported Cursor aliases must keep the fallback shade");
  }
});

Deno.test("unknown rates use a muted provider hue", () => {
  if (color("gpt-99-unknown") !== "oklch(0.68 0.025 250)") {
    throw new Error("Unknown OpenAI models must retain a muted blue hue");
  }
});

Deno.test("free and expensive models remain on the bounded scale", () => {
  if (lightness("gpt-free") !== 0.86) {
    throw new Error("Free models must use the lightest shade");
  }
  for (const model of ["gpt-6-luna", "gpt-6-astra", "gpt-5.5-pro"]) {
    const value = lightness(model);
    if (!(value >= 0.42 && value <= 0.86)) {
      throw new Error(`${model} is outside the fixed lightness range`);
    }
  }
});

Deno.test("colors are independent of selection, order, and tier metadata", () => {
  const models = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
  const all = models.map(color);
  const filtered = models.toReversed().filter((model) => model !== "gpt-6-sol");
  for (const model of filtered) {
    if (color(model) !== all[models.indexOf(model)]) {
      throw new Error("Filtering must not change model colors");
    }
  }
  const model = { model: "gpt-6-astra", ...modelMetadata("gpt-6-astra") };
  const changedTier = { ...model, tier: "nano", tierRank: 3, generation: "1" };
  if (modelColor(model) !== modelColor(changedTier)) {
    throw new Error(
      "Only provider and reference pricing should determine color",
    );
  }
});
