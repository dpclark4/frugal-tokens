import { z } from "zod";
import type {
  CompactionCheckpointItemImport,
  CompactionDetailImport,
} from "./conversationImportTypes.ts";
import {
  type JsonObject,
  jsonObjectSchema,
  type JsonValue,
} from "../shared/json.ts";

export const compactionPreviewLimit = 2_048;

const stringSchema = z.string();
const booleanSchema = z.boolean();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const stringArraySchema = z.array(stringSchema);

export function objectValue(
  value: JsonValue | undefined,
): JsonObject | undefined {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function booleanValue(
  value: JsonValue | undefined,
): boolean | undefined {
  const parsed = booleanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function nonnegativeInteger(
  value: JsonValue | undefined,
): number | undefined {
  const parsed = nonnegativeIntegerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function stringArray(
  value: JsonValue | undefined,
): string[] | undefined {
  const parsed = stringArraySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function serializedJsonValue(
  value: JsonValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value) ?? JSON.stringify(value);
}

export function contentText(value: JsonValue | undefined): string | undefined {
  const directText = stringValue(value);
  if (directText !== undefined) return directText;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((block) => {
    const object = objectValue(block);
    const text = stringValue(object?.text);
    return text === undefined ? [] : [text];
  }).join("");
  return text.length > 0 ? text : undefined;
}

export function contentBlockTypes(
  value: JsonValue | undefined,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const types = value.flatMap((block) => {
    const object = objectValue(block);
    const type = stringValue(object?.type);
    return type === undefined ? [] : [type];
  });
  return types.length > 0 ? types : undefined;
}

export function textCheckpointItem(options: {
  kind: string;
  text: string;
  sourceEntryID?: string;
  role?: string;
  nativeMetadata?: JsonObject;
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
  nativeMetadata?: JsonObject;
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
  content?: JsonValue;
  kind?: string;
  nativeMetadata?: JsonObject;
}): CompactionCheckpointItemImport {
  const blockTypes = contentBlockTypes(options.content);
  const nativeMetadata: JsonObject = { ...options.nativeMetadata };
  if (blockTypes !== undefined) nativeMetadata.contentBlockTypes = blockTypes;
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
