import { modelMetadata } from "../shared/modelMetadata.ts";
import chatGPTIcon from "./assets/icons/chatgpt-light.svg";
import claudeIcon from "./assets/icons/claude.svg";
import grokIcon from "./assets/icons/grok-dark.svg";
import moonshotIcon from "./assets/icons/moonshot.svg";

const providerIcons = {
  anthropic: claudeIcon,
  openai: chatGPTIcon,
  xai: grokIcon,
  moonshot: moonshotIcon,
} as const;

export function modelIcon(model: string) {
  const provider = modelMetadata(model).provider;
  const source = providerIcons[provider as keyof typeof providerIcons];
  return source ? { provider, source } : undefined;
}
