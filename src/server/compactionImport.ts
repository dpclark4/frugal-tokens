import type {
  CompactionCheckpointItemImport,
  CompactionDetailImport,
} from "./conversationImportTypes.ts";

export const compactionPreviewLimit = 2_048;

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((block) => {
    const object = objectValue(block);
    return typeof object?.text === "string" ? [object.text] : [];
  }).join("");
  return text.length > 0 ? text : undefined;
}

export function contentBlockTypes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const types = value.flatMap((block) => {
    const object = objectValue(block);
    return typeof object?.type === "string" ? [object.type] : [];
  });
  return types.length > 0 ? types : undefined;
}

export function textCheckpointItem(options: {
  kind: string;
  text: string;
  sourceEntryID?: string;
  role?: string;
  nativeMetadata?: Record<string, unknown>;
}): CompactionCheckpointItemImport {
  return {
    sourceEntryID: options.sourceEntryID,
    kind: options.kind,
    role: options.role,
    contentAvailability: "plaintext",
    contentPreview: options.text.slice(0, compactionPreviewLimit),
    originalLength: options.text.length,
    truncated: options.text.length > compactionPreviewLimit,
    nativeMetadata: options.nativeMetadata,
  };
}

export function referenceCheckpointItem(options: {
  kind: string;
  sourceEntryID?: string;
  role?: string;
  nativeMetadata?: Record<string, unknown>;
}): CompactionCheckpointItemImport {
  return {
    sourceEntryID: options.sourceEntryID,
    kind: options.kind,
    role: options.role,
    contentAvailability: "reference-only",
    truncated: false,
    nativeMetadata: options.nativeMetadata,
  };
}

export function messageCheckpointItem(options: {
  sourceEntryID?: string;
  role?: string;
  content?: unknown;
  kind?: string;
  nativeMetadata?: Record<string, unknown>;
}): CompactionCheckpointItemImport {
  const blockTypes = contentBlockTypes(options.content);
  const nativeMetadata = {
    ...options.nativeMetadata,
    ...(blockTypes === undefined ? {} : { contentBlockTypes: blockTypes }),
  };
  const kind = options.kind ??
    (options.role === "toolResult" ? "tool-result" : "message");
  const text = contentText(options.content);
  return text === undefined
    ? referenceCheckpointItem({
      kind,
      sourceEntryID: options.sourceEntryID,
      role: options.role,
      nativeMetadata,
    })
    : textCheckpointItem({
      kind,
      text,
      sourceEntryID: options.sourceEntryID,
      role: options.role,
      nativeMetadata,
    });
}

export function numberCheckpointItems(
  compaction: CompactionDetailImport,
): CompactionDetailImport {
  compaction.checkpointItems = compaction.checkpointItems.map((
    item,
    index,
  ) => ({
    ...item,
    ordinal: index + 1,
  }));
  return compaction;
}
