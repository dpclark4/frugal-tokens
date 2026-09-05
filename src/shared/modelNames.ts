const modelDisplayNames = new Map<string, string>([
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-mythos-5", "Claude Mythos 5"],
  ["claude-mythos-5-1", "Claude Mythos 5.1"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-opus-4-5", "Claude Opus 4.5"],
  ["claude-opus-4-1", "Claude Opus 4.1"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ["claude-haiku-3-5", "Claude Haiku 3.5"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.7-flash", "Gemini 3.7 Flash"],
  ["gpt-6-astra", "GPT 6 Astra"],
  ["gpt-5.6-terra", "GPT 5.6 Terra"],
  ["gpt-5.6-sol", "GPT 5.6 Sol"],
  ["gpt-5.6-luna", "GPT 5.6 Luna"],
  ["grok-4-6", "Grok 4.6"],
  ["grok-4-5", "Grok 4.5"],
  ["kimi-k3", "Kimi K3"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["grok-build-0.1", "Grok Build 0.1"],
  ["muse-spark-1.2", "Muse Spark 1.2"],
]);

const genericNames = new Map<string, string>([
  ["gpt", "GPT"],
  ["openai", "OpenAI"],
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["glm", "GLM"],
  ["deepseek", "DeepSeek"],
  ["kimi", "Kimi"],
  ["moonshotai", "MoonshotAI"],
  ["minimax", "MiniMax"],
  ["qwen", "Qwen"],
  ["ai", "AI"],
  ["z", "Z"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["sol", "Sol"],
  ["terra", "Terra"],
  ["luna", "Luna"],
  ["gemini", "Gemini"],
  ["pro", "Pro"],
  ["mini", "Mini"],
  ["nano", "Nano"],
  ["o1", "O1"],
  ["o3", "O3"],
  ["o4", "O4"],
]);

function withoutProviderPrefix(model: string) {
  const normalized = model.toLowerCase();
  // Bedrock IDs can be routed through a region or inference profile, e.g.
  // "us.anthropic.claude-opus-4-7". Keep the model portion for display and
  // grouping without changing the persisted ID.
  return normalized.replace(
    /^.*?(?=(?:claude|gemini|gpt|grok|kimi|glm|minimax|muse)-)/,
    "",
  );
}

function withoutReleaseSuffix(model: string) {
  // Anthropic model IDs can append a release date; Bedrock IDs can also append
  // a provider revision such as "-v1:0". Keep the base ID as the lookup key.
  return model
    .replace(/[-_]\d{8}(?:-v\d+(?::\d+)?)?$/, "")
    .replace(/-v\d+(?::\d+)?$/, "");
}

function withoutVersionSeparator(model: string) {
  // Some provider aliases use "4.7" where Anthropic IDs use "4-7".
  return model.replace(
    /^(claude-(?:fable|mythos|opus|sonnet|haiku)-\d+)\.(\d+)$/,
    "$1-$2",
  );
}

/** Normalize provider aliases without changing the persisted model ID. */
export function canonicalModelId(model: string) {
  return withoutVersionSeparator(
    withoutReleaseSuffix(withoutProviderPrefix(model)),
  );
}

/** Return the user-facing name for a persisted provider model ID. */
export function displayModelName(model: string) {
  if (model === "all") return "All models";
  if (model === "Other") return model;

  const canonical = canonicalModelId(model);
  const mapped = modelDisplayNames.get(model) ??
    modelDisplayNames.get(canonical);
  if (mapped) return mapped;

  return canonical.split(/[-_/]/).map((part) =>
    genericNames.get(part.toLowerCase()) ??
      (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
  ).join(" ");
}
