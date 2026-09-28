import { modelRateCard } from "../../shared/modelPricing.ts";
import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";

type CompositionModel = SpendCompositionData["models"][number];
export type ModelColorIdentity = Pick<CompositionModel, "model" | "provider">;

const providers = {
  openai: { hue: 250, chroma: 0.104 },
  anthropic: { hue: 53, chroma: 0.132 },
  xai: { hue: 315, chroma: 0.095 },
  moonshot: { hue: 190, chroma: 0.09 },
  other: { hue: 210, chroma: 0.025 },
} satisfies Record<
  CompositionModel["provider"],
  { hue: number; chroma: number }
>;

/**
 * Provider owns hue; reference token price owns depth, never age or visible peers.
 * Use latest configured standard-context rates with a fixed 75% uncached input /
 * 25% output mix, not observed session cost. A shared $0.10–$30 per million
 * logarithmic scale keeps cheap models distinct without letting outliers dominate.
 */
export function modelColor(model: ModelColorIdentity) {
  const palette = providers[model.provider];
  const rates = modelRateCard(model.model, Number.POSITIVE_INFINITY, 0);
  if (!rates) return `oklch(0.68 0.025 ${palette.hue})`;

  const price = 0.75 * rates.input + 0.25 * rates.output;
  const depth = Math.max(
    0,
    Math.min(1, Math.log10(Math.max(0.1, price) / 0.1) / Math.log10(300)),
  );
  const lightness = 0.86 - depth * 0.44;
  const chroma = palette.chroma * (0.6 + depth * 0.4);
  return `oklch(${lightness} ${chroma} ${palette.hue})`;
}

export const otherModelColor = "oklch(0.68 0.025 210)";

const minorModelSlateHues = [195, 210, 225, 235] as const;

/** Give unknown models stable tooltip markers without promoting them to chart colors. */
export function minorModelColor(model: string) {
  let hash = 0;
  for (const character of model) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const hue = minorModelSlateHues[hash % minorModelSlateHues.length];
  const lightness = 0.62 + (hash % 4) * 0.035;
  return `oklch(${lightness} 0.03 ${hue})`;
}
