import type { SessionSummary } from "../shared/sessionSchemas.ts";
import claudeCodeIcon from "./assets/icons/claudecode-color.svg";
import codexIcon from "./assets/icons/codex-logo-light.svg";
import cursorIcon from "./assets/icons/cursor-logo.svg";
import openCodeIcon from "./assets/icons/opencode-logo-light.svg";
import piIcon from "./assets/icons/pi-logo.svg";

type Harness = SessionSummary["harness"];

const harnesses = {
  "claude-code": { icon: claudeCodeIcon, name: "Claude Code" },
  codex: { icon: codexIcon, name: "Codex" },
  cursor: { icon: cursorIcon, name: "Cursor" },
  opencode: { icon: openCodeIcon, name: "OpenCode" },
  pi: { icon: piIcon, name: "PI" },
} satisfies Record<Harness, { icon: string; name: string }>;

export function harnessName(harness: Harness) {
  return harnesses[harness].name;
}

export function harnessIcon(harness: Harness) {
  return harnesses[harness].icon;
}
