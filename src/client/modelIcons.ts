import { modelMetadata } from "../shared/modelMetadata.ts";
import chatGPTIcon from "./assets/icons/chatgpt-light.svg";
import claudeIcon from "./assets/icons/claude.svg";
import grokIcon from "./assets/icons/grok-dark.svg";
import moonshotIcon from "./assets/icons/moonshot.svg";

export function modelIcon(model: string) {
  const provider = modelMetadata(model).provider;
  switch (provider) {
    case "anthropic":
      return { provider, source: claudeIcon };
    case "openai":
      return { provider, source: chatGPTIcon };
    case "xai":
      return { provider, source: grokIcon };
    case "moonshot":
      return { provider, source: moonshotIcon };
    default:
      return undefined;
  }
}
