import type { LinearConversationImport } from "./conversationImportTypes.ts";

export function normalizedPromptTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 100);
}

const genericTitlePrefixes = [
  "Claude Code session ",
  "Codex session ",
  "OpenCode session ",
  "Pi session ",
];

export function importedTitleNeedsGeneration(
  importedTitle: string,
  firstUserText: string | undefined,
) {
  const promptTitle = firstUserText === undefined
    ? undefined
    : normalizedPromptTitle(firstUserText);
  return importedTitle === promptTitle ||
    genericTitlePrefixes.some((prefix) => importedTitle.startsWith(prefix));
}

export function firstImportedUserText(value: LinearConversationImport) {
  for (const turn of value.session.turns) {
    const input = turn.inputs?.find((candidate) =>
      candidate.kind === "text" &&
      typeof candidate.preview === "string" &&
      candidate.preview.trim() !== ""
    );
    if (input?.preview !== undefined) return input.preview;
  }
  return undefined;
}
