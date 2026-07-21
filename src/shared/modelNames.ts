const modelDisplayNames: Record<string, string> = {
  "claude-fable-5": "Claude Fable 5",
  "claude-mythos-5": "Claude Mythos 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-haiku-3-5": "Claude Haiku 3.5",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "grok-4-5": "Grok 4.5",
};

const genericNames: Record<string, string> = {
  gpt: "GPT",
  openai: "OpenAI",
  claude: "Claude",
  codex: "Codex",
  glm: "GLM",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  moonshotai: "MoonshotAI",
  minimax: "MiniMax",
  qwen: "Qwen",
  ai: "AI",
  z: "Z",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  sol: "Sol",
  terra: "Terra",
  luna: "Luna",
  gemini: "Gemini",
  pro: "Pro",
  mini: "Mini",
  nano: "Nano",
  o1: "O1",
  o3: "O3",
  o4: "O4",
};

function withoutDateSuffix(model: string) {
  // Anthropic model IDs can append a release date; keep the base ID as the
  // lookup key so new dated revisions do not need individual entries.
  return model.toLowerCase().startsWith("claude-")
    ? model.replace(/[-_]\d{8}$/, "")
    : model;
}

/** Remove a release-date suffix without changing the persisted model ID. */
export function canonicalModelId(model: string) {
  return withoutDateSuffix(model);
}

/** Return the user-facing name for a persisted provider model ID. */
export function displayModelName(model: string) {
  if (model === "all") return "All models";
  if (model === "Other") return model;

  const canonical = canonicalModelId(model);
  const mapped = modelDisplayNames[model] ?? modelDisplayNames[canonical];
  if (mapped) return mapped;

  return canonical.split(/[-_/]/).map((part) =>
    genericNames[part.toLowerCase()] ??
      (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
  ).join(" ");
}
