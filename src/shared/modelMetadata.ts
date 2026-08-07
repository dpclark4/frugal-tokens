import { canonicalModelId } from "./modelNames.ts";

export const modelProviderValues = [
  "anthropic",
  "openai",
  "xai",
  "moonshot",
  "other",
] as const;

export type ModelProvider = (typeof modelProviderValues)[number];

export type ModelMetadata = {
  provider: ModelProvider;
  tier: string;
  tierRank: number;
  generation?: string;
  variant?: string;
};

function versionAfter(value: string, marker: RegExp) {
  return value.match(marker)?.[1]?.replaceAll("-", ".");
}

/** Normalize model identity for analytics without assigning presentation colors. */
export function modelMetadata(model: string): ModelMetadata {
  const id = canonicalModelId(model);

  if (id.startsWith("claude-")) {
    const family = id.match(/^claude-(fable|mythos|opus|sonnet|haiku)-/)?.[1];
    const tierRanks: Record<string, number> = {
      fable: 0,
      mythos: 0,
      opus: 1,
      sonnet: 2,
      haiku: 3,
    };
    return {
      provider: "anthropic",
      tier: family ?? "other",
      tierRank: tierRanks[family ?? ""] ?? 2,
      generation: versionAfter(
        id,
        /^claude-(?:fable|mythos|opus|sonnet|haiku)-(\d+(?:-\d+)?)/,
      ),
    };
  }

  if (/^(?:gpt|o\d|chatgpt)-/.test(id)) {
    const namedTier = id.match(/-(sol|terra|luna)(?:-|$)/)?.[1];
    const variant = id.match(/-(pro|max|mini|nano)(?:-|$)/)?.[1];
    const tier = namedTier ?? variant ??
      (id.includes("codex") ? "codex" : "standard");
    const tierRanks: Record<string, number> = {
      pro: 0,
      sol: 0,
      max: 0,
      standard: 1,
      codex: 1,
      terra: 1,
      luna: 2,
      mini: 2,
      nano: 3,
    };
    return {
      provider: "openai",
      tier,
      tierRank: tierRanks[tier] ?? 1,
      generation: versionAfter(id, /^(?:gpt|o|chatgpt)-?(\d+(?:[.-]\d+)?)/),
      variant,
    };
  }

  if (id.startsWith("grok-")) {
    return {
      provider: "xai",
      tier: id.includes("mini") ? "mini" : "grok",
      tierRank: id.includes("mini") ? 2 : 1,
      generation: versionAfter(id, /^grok-(\d+(?:[.-]\d+)?)/),
      variant: id.includes("mini") ? "mini" : undefined,
    };
  }

  if (/^(?:kimi|moonshot)-/.test(id)) {
    return {
      provider: "moonshot",
      tier: id.includes("mini") ? "mini" : "kimi",
      tierRank: id.includes("mini") ? 2 : 1,
      generation: id.match(/^(?:kimi|moonshot)-([^-/]+)/)?.[1],
      variant: id.includes("mini") ? "mini" : undefined,
    };
  }

  return { provider: "other", tier: "other", tierRank: 1 };
}
