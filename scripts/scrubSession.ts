import { basename, resolve } from "node:path";
import { z } from "zod";

type Harness = "pi" | "codex";

/** Untrusted transcript content: concrete JSON leaves, never an opaque top type. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface RawRecord {
  [key: string]: JsonValue;
}

interface ScrubContext {
  name: string;
  delta: number;
  ids: Map<string, string>;
  paths: Map<string, string>;
  omittedFields: number;
}

interface EditReplacement {
  oldText: string;
  newText: string;
}

interface ScrubbedToolArguments {
  path?: string | null;
  file_path?: string | null;
  command?: string;
  cmd?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  old_string?: string;
  new_string?: string;
  offset?: number;
  limit?: number;
  timeout?: number;
  edits?: EditReplacement[];
}

interface ScrubbedBlock {
  type: string;
  text?: string;
  thinking?: string;
  mimeType?: string;
  data?: string;
  arguments?: ScrubbedToolArguments;
  id?: string | null;
  name?: string;
}

interface ScrubbedPiCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface ScrubbedPiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  totalTokens?: number;
  reasoning?: number;
  cost?: ScrubbedPiCost;
}

interface ScrubbedPiMessage {
  role?: string;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolCallId?: string | null;
  toolName?: string;
  timestamp?: string | number;
  isError?: boolean;
  content?: ScrubbedBlock[] | null;
  usage?: ScrubbedPiUsage;
}

interface ScrubbedPiCompactionDetails {
  readFiles?: (string | null)[];
  modifiedFiles?: (string | null)[];
}

interface ScrubbedPiRow {
  type: string;
  timestamp?: string | number;
  id?: string | null;
  parentId?: string | null;
  version?: number;
  cwd?: string | null;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  firstKeptEntryId?: string | null;
  tokensBefore?: number;
  fromHook?: boolean;
  customType?: string;
  data?: RawRecord;
  summary?: string;
  usage?: ScrubbedPiUsage;
  details?: ScrubbedPiCompactionDetails;
  message?: ScrubbedPiMessage;
}

interface ScrubbedCollaborationSettings {
  model?: string;
  reasoning_effort?: string | null;
}

interface ScrubbedCollaborationMode {
  mode?: string;
  settings?: ScrubbedCollaborationSettings;
}

interface ScrubbedCodexSettings {
  model?: string;
  model_provider_id?: string;
  reasoning_effort?: string | null;
  cwd?: string | null;
  collaboration_mode?: ScrubbedCollaborationMode;
}

interface ScrubbedTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface ScrubbedCodexInfo {
  model_context_window?: number;
  last_token_usage?: ScrubbedTokenUsage;
  total_token_usage?: ScrubbedTokenUsage;
}

interface ScrubbedCodexDuration {
  secs?: number;
  nanos?: number;
}

interface ScrubbedCodexItem {
  type: string;
  content?: ScrubbedBlock[] | null;
  duration?: ScrubbedCodexDuration;
  command?: string;
  aggregated_output?: string;
  formatted_output?: string;
  stdout?: string;
  stderr?: string;
  id?: string | null;
  phase?: string | null;
  status?: string;
  exit_code?: number;
}

interface ScrubbedCodexPayload {
  model?: string;
  model_provider_id?: string;
  reasoning_effort?: string | null;
  cwd?: string | null;
  collaboration_mode?: ScrubbedCollaborationMode;
  type?: string;
  content?: ScrubbedBlock[] | null;
  summary?: ScrubbedBlock[] | null;
  input?: string;
  output?: ScrubbedBlock[] | string;
  message?: string;
  last_agent_message?: string;
  effort?: string;
  role?: string;
  phase?: string | null;
  name?: string;
  call_id?: string | null;
  id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  status?: string;
  started_at?: number;
  completed_at?: number;
  started_at_ms?: number;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
  timestamp?: string | number;
  model_context_window?: number;
  thread_settings?: ScrubbedCodexSettings;
  info?: ScrubbedCodexInfo | null;
  item?: ScrubbedCodexItem;
}

interface ScrubbedCodexRow {
  type: string;
  timestamp?: string | number;
  ordinal?: number;
  payload: ScrubbedCodexPayload;
}

type ScrubbedRecord =
  | ScrubbedPiRow
  | ScrubbedPiMessage
  | ScrubbedPiUsage
  | ScrubbedPiCost
  | ScrubbedPiCompactionDetails
  | ScrubbedBlock
  | ScrubbedToolArguments
  | ScrubbedCodexRow
  | ScrubbedCodexPayload
  | ScrubbedCodexSettings
  | ScrubbedCollaborationMode
  | ScrubbedCollaborationSettings
  | ScrubbedTokenUsage
  | ScrubbedCodexInfo
  | ScrubbedCodexDuration
  | ScrubbedCodexItem;

export const SCRUB_ANCHOR_ISO = "2026-01-15T12:00:00Z";
const SCRUB_ANCHOR_MS = Date.parse(SCRUB_ANCHOR_ISO);

const EXAMPLE_TEXT = "Example session content.";
const EXAMPLE_COMMAND = 'printf "example\\n"';
const EXAMPLE_TOOL_OUTPUT = "Example tool output.";
const EXAMPLE_THINKING = "Review the example configuration.";
const EXAMPLE_SUMMARY = "Synthetic compaction summary.";
const EXAMPLE_EDIT_OLD_TEXT = "Original example content.";
const EXAMPLE_EDIT_NEW_TEXT = "Updated example content.";

/** Placeholder that keeps Pi's clipboard-image detection without original paths. */
export const CLIPBOARD_IMAGE_TEXT =
  "Example attachment: /workspace/example/image.png";

/** Fixed 1×1 PNG: preserve image presence, never original pixels/metadata. */
export const SYNTHETIC_IMAGE_MIME_TYPE = "image/png";
export const SYNTHETIC_IMAGE_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";

export const TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "exec",
  "exec_command",
  "shell",
  "shell_command",
  "apply_patch",
  "update_plan",
  "wait",
  "write_stdin",
] as const;

const CLIPBOARD_IMAGE_PATTERN =
  /(?:^|[\s"'(])[^\s"')]+\.(?:png|jpe?g|gif|webp|bmp)(?:$|[\s"')])/i;

/** Matches Pi's userImages heuristic without retaining the original path. */
export function isClipboardImageReference(text: string): boolean {
  return CLIPBOARD_IMAGE_PATTERN.test(text);
}

const PI_ROW_TYPES = [
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "custom",
  "compaction",
];
const PI_ROLES = [
  "assistant",
  "user",
  "developer",
  "system",
  "toolResult",
  "tool",
];
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const PI_STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted"];
const CONTENT_BLOCK_TYPES = [
  "text",
  "Text",
  "input_text",
  "output_text",
  "thinking",
  "image",
  "toolCall",
];
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const PHASES = ["commentary", "final_answer"];
const STATUSES = ["completed", "in_progress", "failed", "interrupted"];
const COLLAB_MODES = ["default", "plan"];
const CODEX_ROW_TYPES = [
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "world_state",
];
const CODEX_PAYLOAD_TYPES = [
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "item_completed",
  "task_complete",
  "task_started",
  "thread_settings_applied",
  "token_count",
  "user_message",
  "agent_message",
];
const CODEX_ITEM_TYPES = ["AgentMessage", "CommandExecution", "UserMessage"];
const CODEX_ITEM_TEXT_FIELDS = [
  "aggregated_output",
  "formatted_output",
  "stdout",
  "stderr",
] as const;
const PI_USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "totalTokens",
  "reasoning",
] as const;
const PI_COST_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "total",
] as const;
const TOKEN_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
const COMPACTION_FILE_FIELDS = ["readFiles", "modifiedFiles"] as const;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_./:-]{1,120}$/;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);
const recordSchema = z.record(z.string(), jsonValueSchema);

function parseRecord(value: JsonValue): RawRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error("Expected an object");
  return parsed.data;
}

function parseNumber(value: JsonValue): number {
  const parsed = z.number().safeParse(value);
  if (!parsed.success || !Number.isFinite(parsed.data)) {
    throw new Error("Invalid numeric telemetry");
  }
  return parsed.data;
}

function parseBooleanFlag(value: JsonValue): boolean {
  const parsed = z.boolean().safeParse(value);
  if (!parsed.success) throw new Error("Invalid error flag");
  return parsed.data;
}

function parseIdentifier(value: JsonValue): string {
  // Model/provider identifiers remain reviewable; never retain arbitrary prose here.
  const parsed = z.string().regex(IDENTIFIER_PATTERN).safeParse(value);
  if (!parsed.success) {
    throw new Error("Unsupported model/provider identifier");
  }
  return parsed.data;
}

function parseEnum(value: JsonValue, allowed: readonly string[]): string {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || !allowed.includes(parsed.data)) {
    throw new Error("Unsupported enum value");
  }
  return parsed.data;
}

function parseNullableEnum(
  value: JsonValue,
  allowed: readonly string[],
): string | null {
  if (value === null) return null;
  return parseEnum(value, allowed);
}

/** Count source fields dropped by an explicit projection. */
function countOmitted(
  ctx: ScrubContext,
  source: RawRecord,
  result: ScrubbedRecord,
): void {
  for (const key of Object.keys(source)) {
    if (!(key in result)) ctx.omittedFields += 1;
  }
}

function remapped(
  map: Map<string, string>,
  prefix: string,
  value: JsonValue,
): string | null {
  if (value === null) return null;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    throw new Error("Expected a string identifier or path");
  }
  const existing = map.get(parsed.data);
  if (existing !== undefined) return existing;
  const fresh = `${prefix}${map.size + 1}`;
  map.set(parsed.data, fresh);
  return fresh;
}

function remapId(ctx: ScrubContext, value: JsonValue): string | null {
  return remapped(ctx.ids, `${ctx.name}-id-`, value);
}

function remapPath(ctx: ScrubContext, value: JsonValue): string | null {
  return remapped(ctx.paths, "/workspace/example/path-", value);
}

function shiftTimestamp(ctx: ScrubContext, value: JsonValue): string | number {
  const asString = z.string().safeParse(value);
  if (asString.success) {
    const ms = Date.parse(asString.data);
    if (!Number.isFinite(ms)) throw new Error("Invalid timestamp");
    return new Date(ms + ctx.delta).toISOString();
  }
  const asNumber = z.number().safeParse(value);
  if (!asNumber.success || !Number.isFinite(asNumber.data)) {
    throw new Error("Invalid timestamp");
  }
  return asNumber.data + ctx.delta;
}

function scrubToolArguments(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedToolArguments {
  const args = parseRecord(value);
  const result: ScrubbedToolArguments = {};
  for (const [key, argValue] of Object.entries(args)) {
    if (key === "path" || key === "file_path") {
      result[key] = remapPath(ctx, argValue);
    } else if (key === "command" || key === "cmd") {
      result[key] = EXAMPLE_COMMAND;
    } else if (
      key === "content" || key === "oldText" || key === "newText" ||
      key === "old_string" || key === "new_string"
    ) {
      result[key] = EXAMPLE_TEXT;
    } else if (key === "offset" || key === "limit" || key === "timeout") {
      result[key] = parseNumber(argValue);
    } else if (key === "edits" && Array.isArray(argValue)) {
      result[key] = argValue.map((entry) => {
        const edit = parseRecord(entry);
        if (
          Object.keys(edit).some((editKey) =>
            editKey !== "oldText" && editKey !== "newText"
          )
        ) {
          throw new Error("Unsupported edit shape");
        }
        const oldText = z.string().safeParse(edit.oldText);
        const newText = z.string().safeParse(edit.newText);
        if (!oldText.success || !newText.success) {
          throw new Error("Unsupported edit shape");
        }
        return {
          oldText: EXAMPLE_EDIT_OLD_TEXT,
          newText: EXAMPLE_EDIT_NEW_TEXT,
        };
      });
    } else {
      throw new Error("Unsupported tool argument key");
    }
  }
  return result;
}

function scrubContentBlocks(
  ctx: ScrubContext,
  value: JsonValue,
  preserveClipboardImages = false,
): ScrubbedBlock[] | null {
  if (value === null) return null;
  const parsed = z.array(jsonValueSchema).safeParse(value);
  if (!parsed.success) throw new Error("Expected content blocks");
  return parsed.data.map((entry) => {
    const block = parseRecord(entry);
    const type = parseEnum(block.type, CONTENT_BLOCK_TYPES);
    const result: ScrubbedBlock = { type };
    if (type === "image") {
      result.mimeType = SYNTHETIC_IMAGE_MIME_TYPE;
      result.data = SYNTHETIC_IMAGE_DATA;
    }
    if ("text" in block) {
      const text = z.string().safeParse(block.text);
      const clipboardImage = preserveClipboardImages && type === "text" &&
        text.success && isClipboardImageReference(text.data);
      result.text = clipboardImage ? CLIPBOARD_IMAGE_TEXT : EXAMPLE_TEXT;
    }
    if ("thinking" in block) result.thinking = EXAMPLE_THINKING;
    if ("arguments" in block) {
      result.arguments = scrubToolArguments(ctx, block.arguments);
    }
    if ("id" in block) result.id = remapId(ctx, block.id);
    if ("name" in block) result.name = parseEnum(block.name, TOOL_NAMES);
    countOmitted(ctx, block, result);
    return result;
  });
}

function scrubPiCost(ctx: ScrubContext, value: JsonValue): ScrubbedPiCost {
  const source = parseRecord(value);
  const result: ScrubbedPiCost = {};
  for (const key of PI_COST_FIELDS) {
    if (key in source) result[key] = parseNumber(source[key]);
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubPiUsage(ctx: ScrubContext, value: JsonValue): ScrubbedPiUsage {
  const source = parseRecord(value);
  const result: ScrubbedPiUsage = {};
  for (const key of PI_USAGE_FIELDS) {
    if (key in source) result[key] = parseNumber(source[key]);
  }
  if ("cost" in source) result.cost = scrubPiCost(ctx, source.cost);
  countOmitted(ctx, source, result);
  return result;
}

function scrubPiMessage(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedPiMessage {
  const source = parseRecord(value);
  const result: ScrubbedPiMessage = {};
  if ("role" in source) result.role = parseEnum(source.role, PI_ROLES);
  if ("api" in source) result.api = parseIdentifier(source.api);
  if ("provider" in source) {
    result.provider = parseIdentifier(source.provider);
  }
  if ("model" in source) result.model = parseIdentifier(source.model);
  if ("stopReason" in source) {
    result.stopReason = parseEnum(source.stopReason, PI_STOP_REASONS);
  }
  if ("toolCallId" in source) {
    result.toolCallId = remapId(ctx, source.toolCallId);
  }
  if ("toolName" in source) {
    result.toolName = parseEnum(source.toolName, TOOL_NAMES);
  }
  if ("timestamp" in source) {
    result.timestamp = shiftTimestamp(ctx, source.timestamp);
  }
  if ("isError" in source) {
    result.isError = parseBooleanFlag(source.isError);
  }
  if ("content" in source) {
    result.content = scrubContentBlocks(
      ctx,
      source.content,
      source.role === "user",
    );
  }
  if ("usage" in source) result.usage = scrubPiUsage(ctx, source.usage);
  countOmitted(ctx, source, result);
  return result;
}

function scrubPiCompactionDetails(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedPiCompactionDetails {
  const source = parseRecord(value);
  const result: ScrubbedPiCompactionDetails = {};
  for (const key of COMPACTION_FILE_FIELDS) {
    if (!(key in source)) continue;
    const parsed = z.array(jsonValueSchema).safeParse(source[key]);
    if (!parsed.success) {
      throw new Error("Unsupported compaction file list");
    }
    result[key] = parsed.data.map((path) => remapPath(ctx, path));
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubPiRow(ctx: ScrubContext, row: RawRecord): ScrubbedPiRow {
  const type = parseEnum(row.type, PI_ROW_TYPES);
  const result: ScrubbedPiRow = { type };
  if ("timestamp" in row) {
    result.timestamp = shiftTimestamp(ctx, row.timestamp);
  }
  if ("id" in row) result.id = remapId(ctx, row.id);
  if ("parentId" in row) result.parentId = remapId(ctx, row.parentId);
  if ("version" in row) result.version = parseNumber(row.version);
  if ("cwd" in row) result.cwd = remapPath(ctx, row.cwd);
  if ("thinkingLevel" in row) {
    result.thinkingLevel = parseEnum(row.thinkingLevel, PI_THINKING_LEVELS);
  }
  if ("provider" in row) result.provider = parseIdentifier(row.provider);
  if ("modelId" in row) result.modelId = parseIdentifier(row.modelId);
  if ("firstKeptEntryId" in row) {
    result.firstKeptEntryId = remapId(ctx, row.firstKeptEntryId);
  }
  if ("tokensBefore" in row) {
    result.tokensBefore = parseNumber(row.tokensBefore);
  }
  if ("fromHook" in row) result.fromHook = parseBooleanFlag(row.fromHook);
  if (type === "custom") {
    result.customType = "fixture-state";
    result.data = {};
  }
  if (type === "compaction") {
    if ("retainedTail" in row) {
      throw new Error("Explicit retained-tail compactions require review");
    }
    const summary = z.string().safeParse(row.summary);
    if (!summary.success) {
      throw new Error("Unsupported compaction summary");
    }
    result.summary = EXAMPLE_SUMMARY;
    if ("usage" in row) result.usage = scrubPiUsage(ctx, row.usage);
    if ("details" in row) {
      result.details = scrubPiCompactionDetails(ctx, row.details);
    }
  }
  if ("message" in row) result.message = scrubPiMessage(ctx, row.message);
  countOmitted(ctx, row, result);
  return result;
}

function scrubCollaborationSettings(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCollaborationSettings {
  const source = parseRecord(value);
  const result: ScrubbedCollaborationSettings = {};
  if ("model" in source) result.model = parseIdentifier(source.model);
  if ("reasoning_effort" in source) {
    result.reasoning_effort = parseNullableEnum(
      source.reasoning_effort,
      REASONING_EFFORTS,
    );
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubCollaborationMode(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCollaborationMode {
  const mode = parseRecord(value);
  const result: ScrubbedCollaborationMode = {};
  if ("mode" in mode) result.mode = parseEnum(mode.mode, COLLAB_MODES);
  if ("settings" in mode) {
    result.settings = scrubCollaborationSettings(ctx, mode.settings);
  }
  countOmitted(ctx, mode, result);
  return result;
}

function scrubCodexSettings(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCodexSettings {
  const source = parseRecord(value);
  const result: ScrubbedCodexSettings = {};
  if ("model" in source) result.model = parseIdentifier(source.model);
  if ("model_provider_id" in source) {
    result.model_provider_id = parseIdentifier(source.model_provider_id);
  }
  if ("reasoning_effort" in source) {
    result.reasoning_effort = parseNullableEnum(
      source.reasoning_effort,
      REASONING_EFFORTS,
    );
  }
  if ("cwd" in source) result.cwd = remapPath(ctx, source.cwd);
  if ("collaboration_mode" in source) {
    result.collaboration_mode = scrubCollaborationMode(
      ctx,
      source.collaboration_mode,
    );
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexTokenUsage(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedTokenUsage {
  const source = parseRecord(value);
  const result: ScrubbedTokenUsage = {};
  for (const key of TOKEN_USAGE_FIELDS) {
    if (key in source) result[key] = parseNumber(source[key]);
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexInfo(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCodexInfo | null {
  if (value === null) return null;
  const source = parseRecord(value);
  const result: ScrubbedCodexInfo = {};
  if ("model_context_window" in source) {
    result.model_context_window = parseNumber(source.model_context_window);
  }
  if ("last_token_usage" in source) {
    result.last_token_usage = scrubCodexTokenUsage(
      ctx,
      source.last_token_usage,
    );
  }
  if ("total_token_usage" in source) {
    result.total_token_usage = scrubCodexTokenUsage(
      ctx,
      source.total_token_usage,
    );
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexDuration(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCodexDuration {
  const source = parseRecord(value);
  const result: ScrubbedCodexDuration = {};
  if ("secs" in source) result.secs = parseNumber(source.secs);
  if ("nanos" in source) result.nanos = parseNumber(source.nanos);
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexItem(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCodexItem {
  const source = parseRecord(value);
  const result: ScrubbedCodexItem = {
    type: parseEnum(source.type, CODEX_ITEM_TYPES),
  };
  if ("content" in source) {
    result.content = scrubContentBlocks(ctx, source.content);
  }
  if ("duration" in source) {
    result.duration = scrubCodexDuration(ctx, source.duration);
  }
  if ("command" in source) result.command = EXAMPLE_COMMAND;
  for (const key of CODEX_ITEM_TEXT_FIELDS) {
    if (key in source) {
      result[key] = source[key] === "" ? "" : EXAMPLE_TOOL_OUTPUT;
    }
  }
  if ("id" in source) result.id = remapId(ctx, source.id);
  if ("phase" in source) {
    result.phase = parseNullableEnum(source.phase, PHASES);
  }
  if ("status" in source) {
    result.status = parseEnum(source.status, STATUSES);
  }
  if ("exit_code" in source) {
    result.exit_code = parseNumber(source.exit_code);
  }
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexPayload(
  ctx: ScrubContext,
  value: JsonValue,
): ScrubbedCodexPayload {
  const source = parseRecord(value);
  const result: ScrubbedCodexPayload = {};
  if ("model" in source) result.model = parseIdentifier(source.model);
  if ("model_provider_id" in source) {
    result.model_provider_id = parseIdentifier(source.model_provider_id);
  }
  if ("reasoning_effort" in source) {
    result.reasoning_effort = parseNullableEnum(
      source.reasoning_effort,
      REASONING_EFFORTS,
    );
  }
  if ("cwd" in source) result.cwd = remapPath(ctx, source.cwd);
  if ("collaboration_mode" in source) {
    result.collaboration_mode = scrubCollaborationMode(
      ctx,
      source.collaboration_mode,
    );
  }
  if ("type" in source) {
    result.type = parseEnum(source.type, CODEX_PAYLOAD_TYPES);
  }
  if ("content" in source) {
    result.content = scrubContentBlocks(ctx, source.content);
  }
  if ("summary" in source) {
    result.summary = scrubContentBlocks(ctx, source.summary);
  }
  if ("input" in source) result.input = EXAMPLE_COMMAND;
  if ("arguments" in source) {
    // Function tools need their own argument schema, not a fabricated command string.
    throw new Error(
      "Function-call arguments require a tool-specific scrubber",
    );
  }
  if ("output" in source) {
    result.output = Array.isArray(source.output)
      ? scrubContentBlocks(ctx, source.output) ?? EXAMPLE_TOOL_OUTPUT
      : EXAMPLE_TOOL_OUTPUT;
  }
  if ("message" in source) result.message = EXAMPLE_TEXT;
  if ("last_agent_message" in source) {
    result.last_agent_message = EXAMPLE_TEXT;
  }
  if ("effort" in source) {
    result.effort = parseEnum(source.effort, EFFORT_LEVELS);
  }
  if ("role" in source) result.role = parseEnum(source.role, PI_ROLES);
  if ("phase" in source) {
    result.phase = parseNullableEnum(source.phase, PHASES);
  }
  if ("name" in source) result.name = parseEnum(source.name, TOOL_NAMES);
  if ("call_id" in source) result.call_id = remapId(ctx, source.call_id);
  if ("id" in source) result.id = remapId(ctx, source.id);
  if ("turn_id" in source) result.turn_id = remapId(ctx, source.turn_id);
  if ("session_id" in source) {
    result.session_id = remapId(ctx, source.session_id);
  }
  if ("thread_id" in source) {
    result.thread_id = remapId(ctx, source.thread_id);
  }
  if ("status" in source) {
    result.status = parseEnum(source.status, STATUSES);
  }
  if ("started_at" in source) {
    result.started_at = parseNumber(source.started_at) + ctx.delta / 1000;
  }
  if ("completed_at" in source) {
    result.completed_at = parseNumber(source.completed_at) + ctx.delta / 1000;
  }
  if ("started_at_ms" in source) {
    result.started_at_ms = parseNumber(source.started_at_ms) + ctx.delta;
  }
  if ("completed_at_ms" in source) {
    result.completed_at_ms = parseNumber(source.completed_at_ms) + ctx.delta;
  }
  if ("duration_ms" in source) {
    result.duration_ms = parseNumber(source.duration_ms);
  }
  if ("time_to_first_token_ms" in source) {
    result.time_to_first_token_ms = parseNumber(
      source.time_to_first_token_ms,
    );
  }
  if ("timestamp" in source) {
    result.timestamp = shiftTimestamp(ctx, source.timestamp);
  }
  if ("model_context_window" in source) {
    result.model_context_window = parseNumber(source.model_context_window);
  }
  if ("thread_settings" in source) {
    result.thread_settings = scrubCodexSettings(ctx, source.thread_settings);
  }
  if ("info" in source) result.info = scrubCodexInfo(ctx, source.info);
  if ("item" in source) result.item = scrubCodexItem(ctx, source.item);
  countOmitted(ctx, source, result);
  return result;
}

function scrubCodexRow(ctx: ScrubContext, row: RawRecord): ScrubbedCodexRow {
  const type = parseEnum(row.type, CODEX_ROW_TYPES);
  const payload = scrubCodexPayload(ctx, row.payload);
  const result: ScrubbedCodexRow = { type, payload };
  if ("timestamp" in row) {
    result.timestamp = shiftTimestamp(ctx, row.timestamp);
  }
  if ("ordinal" in row) result.ordinal = parseNumber(row.ordinal);
  countOmitted(ctx, row, result);
  return result;
}

/** Deliberately supports a narrow set of transcript shapes, not every harness version. */
export function scrubSession(harness: Harness, input: string, name: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "Fixture name must use lowercase letters, digits, and hyphens",
    );
  }
  const rows = input.split(/\r?\n/).filter((line) => line.trim()).map(
    (line, i) => {
      try {
        return recordSchema.parse(JSON.parse(line));
      } catch {
        // JSON parser and schema diagnostics may contain private source content.
        throw new Error(`Invalid JSON object at nonblank line ${i + 1}`);
      }
    },
  );
  if (rows.length === 0) throw new Error("Session is empty");
  const firstTimestamp = z.string().safeParse(rows[0].timestamp);
  if (
    !firstTimestamp.success || !Number.isFinite(Date.parse(firstTimestamp.data))
  ) {
    throw new Error("First event must have an ISO timestamp");
  }
  const ctx: ScrubContext = {
    name,
    delta: SCRUB_ANCHOR_MS - Date.parse(firstTimestamp.data),
    ids: new Map<string, string>(),
    paths: new Map<string, string>(),
    omittedFields: 0,
  };
  const output = rows.map((row, index) => {
    try {
      return harness === "pi" ? scrubPiRow(ctx, row) : scrubCodexRow(ctx, row);
    } catch (error) {
      // Never include original values or raw parser diagnostics in CLI output.
      throw new Error(
        `Event ${index + 1}: ${
          error instanceof Error ? error.message : "unsupported structure"
        }`,
      );
    }
  });
  return {
    jsonl: output.map((row) => JSON.stringify(row)).join("\n") + "\n",
    events: rows.length,
    omittedFields: ctx.omittedFields,
  };
}

export async function scrubFile(
  harness: Harness,
  input: string,
  output: string,
  name: string,
) {
  if (resolve(input) === resolve(output)) {
    throw new Error("Input and output must differ");
  }
  const result = scrubSession(harness, await Deno.readTextFile(input), name);
  // createNew also prevents overwriting the input via a symlink or hard link.
  await Deno.writeTextFile(output, result.jsonl, { createNew: true });
  return result;
}

if (import.meta.main) {
  try {
    const args = new Map<string, string>();
    for (let i = 0; i < Deno.args.length; i += 2) {
      const key = Deno.args[i];
      const value = Deno.args[i + 1];
      if (
        !["--harness", "--input", "--output", "--name"].includes(key) ||
        !value || args.has(key)
      ) throw new Error("Invalid arguments");
      args.set(key, value);
    }
    const harness = args.get("--harness");
    const input = args.get("--input");
    const output = args.get("--output");
    if ((harness !== "pi" && harness !== "codex") || !input || !output) {
      throw new Error(
        "Usage: --harness pi|codex --input FILE --output FILE [--name scenario-name]",
      );
    }
    const result = await scrubFile(
      harness,
      input,
      output,
      args.get("--name") ?? basename(output, ".jsonl"),
    );
    console.log(
      `Scrubbed ${result.events} events; ${result.omittedFields} field omissions (including nested projections). Review before publishing.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Scrubbing failed");
    Deno.exitCode = 1;
  }
}
