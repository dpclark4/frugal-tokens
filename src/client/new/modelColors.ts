import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";

type CompositionModel = SpendCompositionData["models"][number];
export type ModelColorIdentity = Pick<
  CompositionModel,
  "model" | "provider" | "tier" | "tierRank" | "generation"
>;

type ProviderPalette = {
  lightness: readonly number[];
  chroma: readonly number[];
  hue: readonly number[];
};

const providers = {
  openai: {
    lightness: [0.52, 0.63, 0.74, 0.82],
    chroma: [0.104, 0.095, 0.078, 0.062],
    hue: [250, 250, 250, 250],
  },
  anthropic: {
    lightness: [0.55, 0.65, 0.75, 0.82],
    chroma: [0.132, 0.12, 0.094, 0.072],
    hue: [50, 53, 56, 59],
  },
  xai: {
    lightness: [0.54, 0.64, 0.74, 0.82],
    chroma: [0.095, 0.085, 0.07, 0.055],
    hue: [315, 315, 315, 315],
  },
  moonshot: {
    lightness: [0.54, 0.64, 0.74, 0.82],
    chroma: [0.09, 0.08, 0.065, 0.05],
    hue: [190, 190, 190, 190],
  },
  other: {
    lightness: [0.68, 0.68, 0.73, 0.78],
    chroma: [0.025, 0.025, 0.022, 0.02],
    hue: [210, 210, 210, 210],
  },
} satisfies Record<CompositionModel["provider"], ProviderPalette>;

function generationValue(value?: string) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NEGATIVE_INFINITY;
}

/** Provider owns hue; tier owns the major lightness step; age is a small shift. */
export function modelColor(
  model: ModelColorIdentity,
  models: ModelColorIdentity[],
) {
  const palette = providers[model.provider];
  const peers = models.filter((candidate) =>
    candidate.provider === model.provider && candidate.tier === model.tier
  ).toSorted((a, b) =>
    generationValue(b.generation) - generationValue(a.generation) ||
    b.model.localeCompare(a.model)
  );
  const generationRank = Math.max(
    0,
    peers.findIndex((peer) => peer.model === model.model),
  );
  const tier = Math.min(model.tierRank, palette.lightness.length - 1);
  const nextTierLightness = palette.lightness[tier + 1] ?? 0.88;
  const lightness = Math.min(
    palette.lightness[tier] + generationRank * 0.014,
    nextTierLightness - 0.03,
  );
  const chroma = Math.max(
    0.018,
    palette.chroma[tier] - generationRank * 0.005,
  );
  return `oklch(${lightness} ${chroma} ${palette.hue[tier]})`;
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
