import { z } from "zod";
import {
  type SessionDetail,
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import {
  type JsonObject,
  type JsonValue,
  jsonValueSchema,
} from "../shared/json.ts";
import { usageCallsFromSession } from "./usage.ts";
import type {
  CompactionCheckpointItemImport,
  CompactionDetailImport,
  ConversationCallImport,
  ConversationContentImport,
  ConversationContextEventImport,
  ConversationToolImport,
  ConversationTurnImport,
  ReasoningSettingImport,
} from "./conversationImportTypes.ts";
import {
  contentText,
  messageCheckpointItem,
  nonnegativeInteger,
  numberCheckpointItems,
  objectValue,
  referenceCheckpointItem,
  serializedJsonValue,
  stringValue,
} from "./compactionImport.ts";

const contentPreviewLimit = 2_048;

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.string().optional(),
}).passthrough();

// Codex writes an explicit null when a scope leaves reasoning effort unset, so
// null is read as absent rather than rejected.
const reasoningEffortSettingsSchema = z.object({
  reasoning_effort: z.string().nullable().optional(),
}).passthrough();

const collaborationModeSchema = z.object({
  settings: reasoningEffortSettingsSchema.optional(),
}).passthrough();

const threadSettingsSchema = reasoningEffortSettingsSchema.extend({
  collaboration_mode: collaborationModeSchema.optional(),
}).passthrough();

const recordSchema = z.object({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    collaboration_mode: collaborationModeSchema.optional(),
    thread_settings: threadSettingsSchema.optional(),
    role: z.string().optional(),
    phase: z.string().nullable().optional(),
    name: z.string().optional(),
    input: jsonValueSchema.optional(),
    output: jsonValueSchema.optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
    turn_id: z.string().optional(),
    forked_from_id: z.string().optional(),
    cwd: z.string().optional(),
    message: jsonValueSchema.optional(),
    summary: jsonValueSchema.optional(),
    replacement_history: jsonValueSchema.optional(),
    first_window_id: jsonValueSchema.optional(),
    previous_window_id: jsonValueSchema.optional(),
    window_id: jsonValueSchema.optional(),
    window_number: jsonValueSchema.optional(),
    status: z.string().optional(),
    started_at: z.number().nonnegative().optional(),
    completed_at: z.number().nonnegative().optional(),
    duration_ms: z.number().nonnegative().optional(),
    time_to_first_token_ms: z.number().nonnegative().optional(),
    content: z.array(contentBlockSchema).nullable().optional(),
    info: z.object({
      last_token_usage: z.object({
        input_tokens: z.number().int().nonnegative().default(0),
        cached_input_tokens: z.number().int().nonnegative().default(0),
        output_tokens: z.number().int().nonnegative().default(0),
        reasoning_output_tokens: z.number().int().nonnegative().default(0),
        total_tokens: z.number().int().nonnegative().optional(),
      }).optional(),
    }).passthrough().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

type Record = z.infer<typeof recordSchema>;

const completedUserMessageSchema = z.object({
  type: z.literal("event_msg"),
  payload: z.object({
    type: z.literal("item_completed"),
    item: z.object({
      type: z.literal("UserMessage"),
      content: z.array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }).passthrough(),
      ),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const legacyUserMessageSchema = z.object({
  type: z.literal("event_msg"),
  timestamp: z.string(),
  payload: z.object({
    type: z.literal("user_message"),
    message: z.string(),
  }).passthrough(),
}).passthrough();

type LegacyUserMessage = z.infer<typeof legacyUserMessageSchema>;
export type CodexSessionCandidate = {
  id: string;
  path: string;
  artifactPath: string;
  updatedAt: number;
  size: number;
};

const emptyTokens = (): TokenUsage => ({
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: undefined,
  cacheWrite5m: undefined,
  cacheWrite1h: undefined,
  freshPrompt: 0,
  output: 0,
  reasoning: 0,
  processed: 0,
});

function addTokens(total: TokenUsage, usage: TokenUsage) {
  total.uncachedInput += usage.uncachedInput;
  total.cacheRead += usage.cacheRead;
  total.freshPrompt += usage.freshPrompt;
  total.output += usage.output;
  total.reasoning += usage.reasoning;
  total.processed += usage.processed;
}

function readRecordsFromText(text: string, strict = false) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const result = z.array(recordSchema).safeParse(JSON.parse(trimmed));
      if (result.success) return result.data;
      if (strict) throw result.error;
      return [];
    } catch (error) {
      if (strict) throw error;
      return [];
    }
  }

  const records: Record[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const result = recordSchema.safeParse(JSON.parse(line));
      if (result.success) records.push(result.data);
      else if (strict) throw result.error;
    } catch (error) {
      if (strict) throw error;
      // A partially written final line should not hide the rest of the session.
    }
  }
  return records;
}

function readRecords(path: string) {
  return readRecordsFromText(Deno.readTextFileSync(path));
}

function preview(value: string): ConversationContentImport {
  return {
    kind: "text",
    preview: value.slice(0, contentPreviewLimit),
    originalLength: value.length,
    truncated: value.length > contentPreviewLimit,
  };
}

function serializedPreview(value: JsonValue | undefined) {
  if (value === undefined) return undefined;
  const text = serializedJsonValue(value);
  if (text === undefined) return undefined;
  const metadata = preview(text);
  return {
    preview: metadata.preview,
    originalLength: metadata.originalLength,
    truncated: metadata.truncated,
  };
}

function messageContent(
  record: Record,
  sourceOrder?: number,
): ConversationContentImport[] {
  return (record.payload?.content ?? []).flatMap((block, index) => {
    const identity = record.payload?.id === undefined
      ? {}
      : { sourceID: `${record.payload.id}:content:${index + 1}` };
    const order = sourceOrder === undefined ? {} : { sourceOrder };
    if (block.text !== undefined) {
      return [{ ...preview(block.text), ...identity, ...order }];
    }
    if (block.type !== "input_image") return [];
    const mimeType = block.image_url?.match(/^data:([^;,]+)[;,]/)?.[1];
    return [{ kind: "image", mimeType, ...identity, ...order }];
  });
}

function timestamp(record: Record) {
  return Date.parse(record.timestamp ?? "") || 0;
}

function userText(record: Record) {
  if (
    record.type !== "response_item" || record.payload?.type !== "message" ||
    record.payload.role !== "user"
  ) return undefined;
  return record.payload.content?.find((block) => block.type === "input_text")
    ?.text ??
    record.payload.content?.find((block) => block.type === "text")?.text;
}

function legacyUserMessage(record: Record): LegacyUserMessage | undefined {
  const result = legacyUserMessageSchema.safeParse(record);
  return result.success ? result.data : undefined;
}

function legacyUserText(record: Record) {
  return legacyUserMessage(record)?.payload.message;
}

function completedUserText(record: Record) {
  const result = completedUserMessageSchema.safeParse(record);
  if (!result.success) return undefined;
  return result.data.payload.item.content.find((block) =>
    block.type === "text" && block.text?.trim()
  )?.text;
}

function sessionPrompt(records: Record[]) {
  // Codex writes startup instructions as response_item user content, before
  // the actual turn prompt. Prefer explicit user-authored prompt events from
  // current and older Codex formats when either is available.
  return records.map(completedUserText).find((value) => value?.trim()) ??
    records.map(legacyUserText).find((value) => value?.trim()) ??
    records.map(userText).find((value) => value?.trim());
}

function tokenUsageSignature(record: Record) {
  if (
    record.type !== "event_msg" || record.payload?.type !== "token_count" ||
    !record.payload.info?.last_token_usage
  ) return undefined;
  const usage = record.payload.info.last_token_usage;
  if (
    usage.input_tokens === 0 && usage.cached_input_tokens === 0 &&
    usage.output_tokens === 0 && usage.reasoning_output_tokens === 0 &&
    (usage.total_tokens ?? 0) === 0
  ) return undefined;
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens ?? 0,
  ].join(":");
}

function toolName(record: Record) {
  const payload = record.payload;
  if (payload?.type !== "custom_tool_call" || !payload.name) return undefined;
  const input = stringValue(payload.input);
  if (input === undefined) return payload.name;
  const match = input.match(/tools\.([A-Za-z0-9_]+)/);
  return match ? `${payload.name} -> ${match[1]}` : payload.name;
}

function hasText(record: Record) {
  const payload = record.payload;
  return payload?.type === "message" && payload.role === "assistant" &&
    (payload.phase === "final_answer" ||
      payload.content?.some((block) =>
          (block.type === "output_text" || block.type === "text") &&
          block.text?.trim()
        ) === true);
}

function sessionBounds(
  turns: Array<
    {
      startedAt: number;
      calls: Array<{ startedAt: number; completedAt?: number }>;
    }
  >,
) {
  if (turns.length === 0) return {};
  const startedAt = Math.min(...turns.map((turn) => turn.startedAt));
  const ends = turns.flatMap((turn) =>
    turn.calls.map((call) => call.completedAt ?? call.startedAt)
  );
  const endedAt = ends.length > 0
    ? Math.max(...ends)
    : Math.max(...turns.map((turn) => turn.startedAt));
  return { startedAt, endedAt };
}

type CodexCallTiming = {
  startedAt: number;
  completedAt?: number;
  sourceOrderStart: number;
  sourceOrderEnd: number;
};

type CodexTurnTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  calls: CodexCallTiming[];
  tokenIndexes: number[];
  startIndex: number;
  inputAt?: number;
};

function eventTime(record: Record) {
  const timestampValue = timestamp(record);
  if (timestampValue > 0) return timestampValue;
  const payload = record.payload;
  if (payload?.completed_at !== undefined) return payload.completed_at * 1_000;
  if (payload?.started_at !== undefined) return payload.started_at * 1_000;
  return 0;
}

function taskCompleteTime(record: Record) {
  const time = timestamp(record);
  if (time > 0) return time;
  const payload = record.payload;
  if (payload?.completed_at !== undefined) return payload.completed_at * 1_000;
  if (payload?.started_at !== undefined && payload.duration_ms !== undefined) {
    return payload.started_at * 1_000 + payload.duration_ms;
  }
  return 0;
}

function maxRecordTime(records: Record[]) {
  const times = records.map(eventTime).filter((time) => time > 0);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function maxToolOutputTime(records: Record[]) {
  return maxRecordTime(
    records.filter((record) =>
      record.type === "response_item" &&
      (record.payload?.type === "custom_tool_call_output" ||
        record.payload?.type === "function_call_output")
    ),
  );
}

function isAssistantOutput(record: Record) {
  return record.type === "response_item" && hasText(record);
}

function inferCodexCallTimings(records: Record[]) {
  const turns: CodexTurnTiming[] = [];
  let current: CodexTurnTiming | undefined;
  let userInputPending = false;

  for (const [recordIndex, record] of records.entries()) {
    const payload = record.payload;
    const time = eventTime(record);

    if (record.type === "event_msg" && payload?.type === "task_started") {
      current = {
        startedAt: time,
        calls: [],
        tokenIndexes: [],
        startIndex: recordIndex,
      };
      turns.push(current);
      userInputPending = false;
      continue;
    }
    if (!current) continue;

    if (
      record.type === "response_item" && payload?.type === "message" &&
      payload.role === "user"
    ) {
      if (current.tokenIndexes.length > 0) {
        current = {
          startedAt: time,
          calls: [],
          tokenIndexes: [],
          startIndex: recordIndex,
        };
        turns.push(current);
      }
      current.inputAt = time;
      userInputPending = true;
    } else if (
      record.type === "event_msg" && payload?.type === "user_message"
    ) {
      // response_item/user and event_msg/user_message are usually duplicate
      // representations of one prompt. Only the latter may be present, so
      // split here when a prompt was not already seen in the open turn.
      if (current.tokenIndexes.length > 0 && !userInputPending) {
        current = {
          startedAt: time,
          calls: [],
          tokenIndexes: [],
          startIndex: recordIndex,
        };
        turns.push(current);
      }
      if (!userInputPending) current.inputAt = time;
      userInputPending = true;
    }

    if (record.type === "event_msg" && payload?.type === "token_count") {
      if (tokenUsageSignature(record) !== undefined) {
        current.tokenIndexes.push(recordIndex);
        userInputPending = false;
      }
    }

    if (record.type === "event_msg" && payload?.type === "task_complete") {
      current.completedAt = taskCompleteTime(record) || undefined;
      current.durationMs = payload.duration_ms;
    }
  }

  return turns.map((turn) => {
    const calls: CodexCallTiming[] = [];
    let previousTokenIndex = -1;
    let previousModelOutputIndex: number | undefined;

    for (const [callIndex, tokenIndex] of turn.tokenIndexes.entries()) {
      const rangeStart = callIndex === 0
        ? turn.startIndex
        : previousTokenIndex + 1;
      const range = records.slice(rangeStart, tokenIndex + 1);
      const toolRequestIndexes = range.flatMap((record, index) =>
        record.type === "response_item" &&
          record.payload?.type === "custom_tool_call"
          ? [rangeStart + index]
          : []
      );
      const assistantOutputIndexes = range.flatMap((record, index) =>
        isAssistantOutput(record) ? [rangeStart + index] : []
      );
      const firstModelOutputIndex = [
        ...toolRequestIndexes,
        ...assistantOutputIndexes,
      ].sort((a, b) => a - b)[0];

      let startedAt: number | undefined;
      if (callIndex === 0) {
        startedAt = turn.inputAt ?? turn.startedAt;
      } else {
        const outputRangeStart = previousModelOutputIndex ?? turn.startIndex;
        const outputRangeEnd = firstModelOutputIndex ?? tokenIndex;
        startedAt = maxToolOutputTime(
          records.slice(outputRangeStart, outputRangeEnd),
        );
      }
      startedAt ??= eventTime(records[tokenIndex]);

      const toolEnd = maxRecordTime(
        toolRequestIndexes.map((index) => records[index]),
      );
      const assistantEnd = maxRecordTime(
        assistantOutputIndexes.map((index) => records[index]),
      );
      const hasToolRequest = toolRequestIndexes.length > 0;
      let completedAt = hasToolRequest ? toolEnd : assistantEnd;
      if (
        completedAt === undefined &&
        callIndex === turn.tokenIndexes.length - 1 &&
        !hasToolRequest
      ) {
        completedAt = turn.completedAt ?? (
          turn.durationMs === undefined
            ? undefined
            : turn.startedAt + turn.durationMs
        );
      }
      if (completedAt !== undefined && completedAt <= startedAt) {
        completedAt = undefined;
      }

      calls.push({
        startedAt,
        completedAt,
        sourceOrderStart: rangeStart + 1,
        sourceOrderEnd: tokenIndex + 1,
      });
      previousTokenIndex = tokenIndex;
      previousModelOutputIndex = toolRequestIndexes.at(-1) ??
        assistantOutputIndexes.at(-1) ?? tokenIndex;
    }

    return { ...turn, calls };
  });
}

function codexReasoningSetting(payload: NonNullable<Record["payload"]>) {
  if (payload.effort !== undefined) {
    return {
      settingName: "effort",
      settingValue: payload.effort,
      sourceFieldPath: "payload.effort",
    };
  }
  const collaborationEffort = payload.collaboration_mode?.settings
    ?.reasoning_effort;
  if (collaborationEffort != null) {
    return {
      settingName: "reasoning_effort",
      settingValue: collaborationEffort,
      sourceFieldPath: "payload.collaboration_mode.settings.reasoning_effort",
    };
  }
  const threadEffort = payload.thread_settings?.reasoning_effort;
  if (threadEffort != null) {
    return {
      settingName: "reasoning_effort",
      settingValue: threadEffort,
      sourceFieldPath: "payload.thread_settings.reasoning_effort",
    };
  }
  const threadCollaborationEffort = payload.thread_settings
    ?.collaboration_mode?.settings?.reasoning_effort;
  if (threadCollaborationEffort != null) {
    return {
      settingName: "reasoning_effort",
      settingValue: threadCollaborationEffort,
      sourceFieldPath:
        "payload.thread_settings.collaboration_mode.settings.reasoning_effort",
    };
  }
  return undefined;
}

function markCodexContextOperation(call: ConversationCallImport) {
  if (!call.id.startsWith("context-operation:")) {
    call.id = `context-operation:${call.id}`;
  }
  if (
    call.sourceID !== undefined &&
    !call.sourceID.startsWith("context-operation:")
  ) {
    call.sourceID = `context-operation:${call.sourceID}`;
  }
}

function codexCompactionDetails(record: Record): CompactionDetailImport {
  const payload = record.payload;
  const issues: string[] = [];
  const replacement = payload?.replacement_history;
  const replacementItems = Array.isArray(replacement) ? replacement : undefined;
  if (replacement !== undefined && replacementItems === undefined) {
    issues.push("replacement-history-not-array");
  }
  let encryptedCheckpoint = false;
  let sourceID: string | undefined;
  const checkpointItems: CompactionCheckpointItemImport[] = [];
  const payloadMessage = stringValue(payload?.message);
  if (payloadMessage?.trim()) {
    checkpointItems.push({
      sourceEntryID: stringValue(payload?.window_id),
      kind: "summary",
      role: "user",
      contentAvailability: "plaintext",
      contentPreview: payloadMessage.slice(0, contentPreviewLimit),
      originalLength: payloadMessage.length,
      truncated: payloadMessage.length > contentPreviewLimit,
    });
  }
  for (const [index, value] of (replacementItems ?? []).entries()) {
    const item = objectValue(value);
    if (item === undefined) {
      issues.push("replacement-item-not-object");
      continue;
    }
    const type = stringValue(item.type) ?? "other";
    const itemID = stringValue(item.id);
    if (type === "compaction") {
      sourceID ??= itemID;
      const encrypted = stringValue(item.encrypted_content);
      if (encrypted !== undefined) {
        encryptedCheckpoint = true;
        checkpointItems.push({
          sourceEntryID: itemID,
          kind: "opaque-checkpoint",
          contentAvailability: "encrypted",
          originalLength: encrypted.length,
          truncated: false,
          nativeMetadata: { replacementIndex: index },
        });
        continue;
      }
      const plaintext = contentText(item.content ?? item.message);
      if (plaintext !== undefined) {
        checkpointItems.push({
          sourceEntryID: itemID,
          kind: "summary",
          role: "user",
          contentAvailability: "plaintext",
          contentPreview: plaintext.slice(0, contentPreviewLimit),
          originalLength: plaintext.length,
          truncated: plaintext.length > contentPreviewLimit,
          nativeMetadata: { replacementIndex: index },
        });
      } else {
        issues.push("compaction-item-content-missing");
        checkpointItems.push(referenceCheckpointItem({
          sourceEntryID: itemID,
          kind: "opaque-checkpoint",
          nativeMetadata: { replacementIndex: index },
        }));
      }
      continue;
    }
    const role = stringValue(item.role);
    checkpointItems.push(messageCheckpointItem({
      sourceEntryID: itemID,
      role,
      content: item.content,
      kind: role === "developer"
        ? "developer-message"
        : role === "system"
        ? "system-message"
        : type === "message"
        ? "message"
        : type,
      nativeMetadata: {
        replacementIndex: index,
        sourceType: type,
      },
    }));
  }
  const invalidItems = replacementItems === undefined
    ? 0
    : replacementItems.length - checkpointItems.length +
      (payloadMessage?.trim() ? 1 : 0);
  const windowNumber = nonnegativeInteger(payload?.window_number);
  const firstWindowID = stringValue(payload?.first_window_id);
  const previousWindowID = stringValue(payload?.previous_window_id);
  const windowID = stringValue(payload?.window_id);
  if (payload?.window_number !== undefined && windowNumber === undefined) {
    issues.push("window-number-invalid");
  }
  const nativeMetadata: JsonObject = {
    replacementItemCount: replacementItems?.length ?? 0,
  };
  if (firstWindowID !== undefined) nativeMetadata.firstWindowID = firstWindowID;
  if (previousWindowID !== undefined) {
    nativeMetadata.previousWindowID = previousWindowID;
  }
  if (windowID !== undefined) nativeMetadata.windowID = windowID;
  if (windowNumber !== undefined) nativeMetadata.windowNumber = windowNumber;
  if (payloadMessage !== undefined) {
    nativeMetadata.payloadMessageLength = payloadMessage.length;
  }
  if (issues.length > 0) nativeMetadata.captureIssues = issues;
  return {
    sourceID: sourceID ?? stringValue(payload?.window_id),
    trigger: "unknown",
    resultKind: encryptedCheckpoint
      ? "encrypted-checkpoint"
      : checkpointItems.some((item) => item.kind === "summary")
      ? "plaintext-summary"
      : "unavailable",
    checkpointCompleteness: replacementItems === undefined
      ? "unknown"
      : invalidItems > 0
      ? "partial"
      : "complete",
    retainedItemCount: checkpointItems.length,
    nativeMetadata,
    checkpointItems,
  };
}

function decodeRecords(records: Record[]) {
  const turns: ConversationTurnImport[] = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<string, ConversationToolImport>();
  let currentModel = "unknown";
  let pendingHasText = false;
  let pendingTools: ConversationToolImport[] = [];
  let pendingContent: ConversationContentImport[] = [];
  // Codex forks can retain agent_message events while omitting their matching
  // structured response_item records. Keep those messages as content unless a
  // structured assistant response supersedes the same text.
  const pendingAgentMessageContent = new Set<ConversationContentImport>();
  let pendingCallSourceIDs: string[] = [];
  const callTimings = inferCodexCallTimings(records);
  type PendingContextEvent = ConversationContextEventImport & {
    affectedCallReference?: ConversationCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];
  let pendingCompaction: CompactionDetailImport | undefined;
  let pendingCompactionSource:
    | { sourceOrder: number; occurredAt?: number }
    | undefined;
  // Newer Codex rollouts omit context_compacted. Defer their standalone
  // compacted record until the following record, so the legacy marker retains
  // its original behavior when it is still present.
  let deferredStandaloneCompaction:
    | {
      compaction: CompactionDetailImport;
      sourceOrder: number;
      occurredAt?: number;
    }
    | undefined;
  let lastCall: ConversationCallImport | undefined;
  let activeReasoningSetting:
    | Omit<ReasoningSettingImport, "provenance">
    | undefined;

  for (const [recordIndex, record] of records.entries()) {
    const payload = record.payload;
    const time = timestamp(record);

    if (
      deferredStandaloneCompaction !== undefined &&
      !(record.type === "event_msg" && payload?.type === "context_compacted")
    ) {
      const event: PendingContextEvent = {
        type: "compaction",
        sourceOrder: deferredStandaloneCompaction.sourceOrder,
        compaction: numberCheckpointItems(
          deferredStandaloneCompaction.compaction,
        ),
      };
      if (deferredStandaloneCompaction.occurredAt !== undefined) {
        event.occurredAt = deferredStandaloneCompaction.occurredAt;
      }
      contextEvents.push(event);
      pendingContextEvents.push(event);
      pendingCompaction = undefined;
      pendingCompactionSource = undefined;
      deferredStandaloneCompaction = undefined;
    }

    if (record.type === "compacted") {
      pendingCompaction = codexCompactionDetails(record);
      pendingCompactionSource = { sourceOrder: recordIndex + 1 };
      if (time !== 0) pendingCompactionSource.occurredAt = time;
      continue;
    }

    if (record.type === "event_msg" && payload?.type === "context_compacted") {
      if (
        lastCall && lastCall.tokens.uncachedInput === 0 &&
        lastCall.tokens.cacheRead === 0 && lastCall.tokens.output === 0 &&
        lastCall.tokens.reasoning === 0 && lastCall.tokens.processed > 0 &&
        !lastCall.activity.hasText && lastCall.activity.tools.length === 0
      ) {
        // Codex emits this opaque total-only call for compaction itself. Keep
        // it canonical, but tag it so only Codex hydration hides the machinery.
        markCodexContextOperation(lastCall);
      }
      const event: PendingContextEvent = {
        type: "compaction",
        sourceOrder: recordIndex + 1,
        compaction: numberCheckpointItems(
          pendingCompaction ?? {
            trigger: "unknown",
            resultKind: "unavailable",
            checkpointCompleteness: "unknown",
            nativeMetadata: { captureIssues: ["compacted-record-missing"] },
            checkpointItems: [],
          },
        ),
      };
      if (time !== 0) event.occurredAt = time;
      pendingCompaction = undefined;
      pendingCompactionSource = undefined;
      deferredStandaloneCompaction = undefined;
      contextEvents.push(event);
      pendingContextEvents.push(event);
      continue;
    }

    if (record.type === "turn_context" && payload) {
      if (pendingCompaction !== undefined && payload.summary === "auto") {
        pendingCompaction.trigger = "automatic";
        pendingCompaction.nativeMetadata = {
          ...pendingCompaction.nativeMetadata,
          nativeTrigger: "auto",
        };
      }
      if (payload.model) currentModel = payload.model;
      const setting = codexReasoningSetting(payload);
      if (setting !== undefined) {
        activeReasoningSetting = {
          ...setting,
          sourceOrder: recordIndex + 1,
        };
        if (time !== 0) activeReasoningSetting.observedAt = time;
        // Codex emits task_started before the turn_context that contains the
        // setting for that same turn. Attach the setting to the open turn so
        // turn-level summaries do not lag one turn behind.
        const currentTurn = turns.at(-1);
        if (currentTurn?.calls.length === 0) {
          currentTurn.reasoningSetting = {
            ...activeReasoningSetting,
            provenance: "inherited" as const,
          };
        }
      }
      continue;
    }

    if (record.type === "event_msg" && payload?.type === "task_started") {
      const turn: ConversationTurnImport = {
        number: turns.length + 1,
        sourceOrderStart: recordIndex + 1,
        startedAt: eventTime(record),
        calls: [],
      };
      if (payload.turn_id !== undefined) {
        turn.sourceID = payload.turn_id;
        turn.identityBasis = "stable-id";
      }
      if (activeReasoningSetting !== undefined) {
        turn.reasoningSetting = {
          ...activeReasoningSetting,
          provenance: "inherited",
        };
      }
      turns.push(turn);
      pendingHasText = false;
      pendingTools = [];
      pendingContent = [];
      pendingAgentMessageContent.clear();
      pendingCallSourceIDs = [];
      continue;
    }

    if (turns.length === 0) continue;

    if (
      record.type === "response_item" && payload?.type === "message" &&
      payload.role === "user"
    ) {
      const currentTurn = turns.at(-1)!;
      if (currentTurn.calls.length > 0) {
        const turn: ConversationTurnImport = {
          number: turns.length + 1,
          sourceOrderStart: recordIndex + 1,
          identityBasis: "unresolved",
          startedAt: time,
          calls: [],
        };
        if (activeReasoningSetting !== undefined) {
          turn.reasoningSetting = {
            ...activeReasoningSetting,
            provenance: "inherited",
          };
        }
        turns.push(turn);
      }
      const inputTurn = turns.at(-1)!;
      if (
        inputTurn.identityBasis === "unresolved" && payload.id !== undefined
      ) {
        // Queued prompts can start a logical turn without a new task_started
        // event. The message ID survives rewind copies and is strong identity
        // evidence for canonicalizing that turn across fork artifacts.
        inputTurn.sourceID = `user-message:${payload.id}`;
        inputTurn.identityBasis = "stable-id";
      }
      inputTurn.inputs = messageContent(record, recordIndex + 1);
      continue;
    }

    if (
      record.type === "event_msg" && payload?.type === "user_message"
    ) {
      const currentTurn = turns.at(-1)!;
      if (currentTurn.calls.length > 0) {
        const turn: ConversationTurnImport = {
          number: turns.length + 1,
          sourceOrderStart: recordIndex + 1,
          identityBasis: "unresolved",
          startedAt: time,
          calls: [],
        };
        if (activeReasoningSetting !== undefined) {
          turn.reasoningSetting = {
            ...activeReasoningSetting,
            provenance: "inherited",
          };
        }
        turns.push(turn);
      } else {
        const eventMessage = stringValue(payload.message);
        if (currentTurn.inputs === undefined && eventMessage?.trim()) {
          currentTurn.inputs = [preview(eventMessage)];
        }
      }
      continue;
    }

    if (
      record.type === "response_item" && payload?.type === "custom_tool_call"
    ) {
      const name = toolName(record);
      if (!name) continue;
      const input = serializedPreview(payload.input);
      const tool: ConversationToolImport = {
        name,
        status: "pending",
        startedAt: time,
        sourceID: payload.call_id ?? payload.id,
        sourceEntryID: payload.id,
        sourceOrderStart: recordIndex + 1,
        input,
      };
      if (input?.preview !== undefined) tool.inputPreview = input.preview;
      pendingTools.push(tool);
      if (record.payload!.id !== undefined) {
        pendingCallSourceIDs.push(record.payload!.id);
      }
      if (tool.sourceID) tools.set(tool.sourceID, tool);
      continue;
    }

    if (
      record.type === "event_msg" && payload?.type === "agent_message"
    ) {
      const message = stringValue(payload.message);
      if (message !== undefined) {
        const content = {
          ...preview(message),
          sourceOrder: recordIndex + 1,
        };
        pendingContent.push(content);
        pendingAgentMessageContent.add(content);
        pendingHasText = true;
      }
      continue;
    }

    if (
      record.type === "response_item" &&
      (payload?.type === "custom_tool_call_output" ||
        payload?.type === "function_call_output")
    ) {
      const tool = payload.call_id ? tools.get(payload.call_id) : undefined;
      if (tool) {
        tool.status = "completed";
        tool.completedAt = time;
        tool.output = serializedPreview(payload.output);
        tool.outputPreview = tool.output?.preview;
        tool.outputSourceEntryID = payload.id;
        tool.sourceOrderEnd = recordIndex + 1;
      }
      continue;
    }

    if (record.type === "response_item" && hasText(record)) {
      pendingHasText = true;
      const content = messageContent(record, recordIndex + 1);
      // Full Codex logs store an agent_message immediately before the matching
      // structured assistant response. Prefer the latter's stable source ID.
      if (payload?.role === "assistant" && content.length === 1) {
        for (let index = pendingContent.length - 1; index >= 0; index--) {
          const fallback = pendingContent[index];
          if (
            !pendingAgentMessageContent.has(fallback) ||
            fallback.preview !== content[0].preview ||
            fallback.originalLength !== content[0].originalLength
          ) continue;
          pendingContent.splice(index, 1);
          pendingAgentMessageContent.delete(fallback);
          break;
        }
      }
      pendingContent.push(...content);
      if (record.payload?.id !== undefined) {
        pendingCallSourceIDs.push(record.payload.id);
      }
      continue;
    }

    if (
      record.type !== "event_msg" || payload?.type !== "token_count" ||
      !payload.info?.last_token_usage
    ) continue;

    const source = payload.info.last_token_usage;
    const standaloneCompactionOperation = pendingCompaction !== undefined &&
      source.input_tokens === 0 && source.cached_input_tokens === 0 &&
      source.output_tokens === 0 && source.reasoning_output_tokens === 0 &&
      (source.total_tokens ?? 0) > 0;
    const cacheRead = Math.min(source.cached_input_tokens, source.input_tokens);
    const uncachedInput = source.input_tokens - cacheRead;
    const callTokens: TokenUsage = {
      uncachedInput,
      cacheRead,
      cacheWrite: undefined,
      cacheWrite5m: undefined,
      cacheWrite1h: undefined,
      freshPrompt: uncachedInput,
      output: source.output_tokens,
      reasoning: source.reasoning_output_tokens,
      processed: Math.max(
        source.input_tokens + source.output_tokens +
          source.reasoning_output_tokens,
        source.total_tokens ?? 0,
      ),
    };
    if (callTokens.processed === 0) continue;

    const turn = turns.at(-1)!;
    const timing = callTimings[turn.number - 1]?.calls[turn.calls.length];
    const images = turn.calls.length === 0
      ? turn.inputs?.filter((input) => input.kind === "image").length
      : 0;
    const textPreview = pendingContent.find((item) => item.kind === "text")
      ?.preview;
    const call: ConversationCallImport = {
      id: `${turn.number}-${turn.calls.length + 1}`,
      ...(pendingCallSourceIDs[0] === undefined
        ? turn.sourceID === undefined
          ? { identityBasis: "unresolved" as const }
          : {
            sourceID: `${turn.sourceID}:call:${turn.calls.length + 1}`,
            identityBasis: "explicit-lineage" as const,
          }
        : {
          sourceID: pendingCallSourceIDs[0],
          identityBasis: "stable-id" as const,
        }),
      sourceOrderStart: timing?.sourceOrderStart ?? recordIndex + 1,
      sourceOrderEnd: timing?.sourceOrderEnd ?? recordIndex + 1,
      callWithinTurn: turn.calls.length + 1,
      provider: "openai",
      model: currentModel,
      startedAt: timing?.startedAt ?? time,
      completedAt: timing?.completedAt,
      tokens: callTokens,
      activity: {
        hasText: pendingHasText,
        hasReasoning: source.reasoning_output_tokens > 0,
        tools: pendingTools,
      },
      content: pendingContent,
    };
    if (textPreview !== undefined) call.preview = textPreview;
    if (activeReasoningSetting !== undefined) {
      call.reasoningSetting = {
        ...activeReasoningSetting,
        provenance: "inherited",
      };
    }
    if (images) call.activity.images = images;

    providers.add("openai");
    models.delete(currentModel);
    models.add(currentModel);
    addTokens(tokens, callTokens);
    turn.calls.push(call);
    lastCall = call;
    for (const event of pendingContextEvents) {
      event.affectedCallReference = call;
    }
    pendingContextEvents.length = 0;
    pendingHasText = false;
    pendingTools = [];
    pendingContent = [];
    pendingAgentMessageContent.clear();
    pendingCallSourceIDs = [];
    if (standaloneCompactionOperation) {
      markCodexContextOperation(call);
      deferredStandaloneCompaction = {
        compaction: pendingCompaction!,
        sourceOrder: pendingCompactionSource?.sourceOrder ?? recordIndex + 1,
      };
      if (pendingCompactionSource?.occurredAt !== undefined) {
        deferredStandaloneCompaction.occurredAt =
          pendingCompactionSource.occurredAt;
      }
    }
  }

  for (const [index, turn] of turns.entries()) {
    turn.sourceOrderEnd =
      (turns[index + 1]?.sourceOrderStart ?? records.length + 1) - 1;
  }

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  const normalizedContextEvents: ConversationContextEventImport[] =
    contextEvents
      .map(
        ({ affectedCallReference, ...event }) => {
          if (affectedCallReference === undefined) return event;
          const turn = nonEmptyTurns.find((candidate) =>
            candidate.calls.includes(affectedCallReference)
          );
          return turn === undefined ? event : {
            ...event,
            affectedCall: {
              turn: turn.number,
              call: affectedCallReference.callWithinTurn,
            },
          };
        },
      );
  return {
    turns: nonEmptyTurns,
    contextEvents: normalizedContextEvents,
    tokens,
    providers,
    models,
  };
}

function hasLegacyUsageEvidence(records: Record[]) {
  return records.some(legacyUserMessage) && records.some(tokenUsageSignature);
}

function decodeLegacyRecords(records: Record[]) {
  const adapted: Record[] = [];
  let previousUsageSignature: string | undefined;
  for (const record of records) {
    const legacyUser = legacyUserMessage(record);
    if (legacyUser) {
      adapted.push({
        type: "event_msg",
        timestamp: legacyUser.timestamp,
        payload: { type: "task_started" },
      });
      adapted.push({
        type: "response_item",
        timestamp: legacyUser.timestamp,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: legacyUser.payload.message }],
        },
      });
      previousUsageSignature = undefined;
      continue;
    }
    const usageSignature = tokenUsageSignature(record);
    if (usageSignature !== undefined) {
      if (usageSignature === previousUsageSignature) continue;
      previousUsageSignature = usageSignature;
    }
    adapted.push(record);
  }
  return decodeRecords(adapted);
}

export class CodexRepository {
  constructor(private directory: string) {}

  #files() {
    return discoverCodexSessions(this.directory);
  }

  listSessions(page: number, pageSize: number) {
    const files = this.#files();
    const items = files.map((file) =>
      this.#summary(file.id, file.path, file.updatedAt)
    ).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .slice((page - 1) * pageSize, page * pageSize);
    return sessionListResponseSchema.parse({
      items,
      pagination: {
        page,
        pageSize,
        totalItems: files.length,
        totalPages: Math.ceil(files.length / pageSize),
      },
    });
  }

  getSession(id: string) {
    const file = this.#files().find((entry) => entry.id === id);
    if (!file) return undefined;
    return this.#detail(file);
  }

  listUsageCalls(startedAt?: number) {
    return this.#files().filter((file) =>
      startedAt === undefined || file.updatedAt >= startedAt
    ).flatMap((file) => usageCallsFromSession(this.#detail(file))).filter((
      call,
    ) => startedAt === undefined || call.startedAt >= startedAt);
  }

  #summary(id: string, path: string, updatedAt: number): SessionSummary {
    return codexSession(readRecords(path), id, updatedAt).summary;
  }

  #detail(file: CodexSessionCandidate): SessionDetail {
    const normalized = codexSession(
      readRecords(file.path),
      file.id,
      file.updatedAt,
    );
    const turns = normalized.turns.map((turn) => ({
      ...turn,
      calls: turn.calls.filter((call) =>
        !call.id.startsWith("context-operation:")
      ).map((call) => {
        const contextEventsBefore = normalized.contextEvents.filter((event) =>
          event.affectedCall?.turn === turn.number &&
          event.affectedCall.call === call.callWithinTurn
        ).map(({ affectedCall: _affectedCall, ...event }) => event);
        if (contextEventsBefore.length === 0) return call;
        return { ...call, contextEventsBefore };
      }),
    })).filter((turn) => turn.calls.length > 0).map((turn, index) => ({
      ...turn,
      number: index + 1,
    }));
    const contextEvents = normalized.contextEvents.filter((event) =>
      event.affectedCall === undefined
    );
    const detail = {
      ...normalized.summary,
      userTurns: turns.length,
      modelCalls: turns.reduce((total, turn) => total + turn.calls.length, 0),
      parentID: undefined,
      turns,
      subagents: [],
    };
    return sessionDetailSchema.parse(
      contextEvents.length === 0 ? detail : { ...detail, contextEvents },
    );
  }
}

function collectCodexSessions(
  directory: string,
  prefix = "",
): CodexSessionCandidate[] {
  const files: CodexSessionCandidate[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    const path = `${directory}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      files.push(...collectCodexSessions(path, relative));
      continue;
    }
    if (
      !entry.isFile ||
      (!entry.name.startsWith("rollout-") &&
        !entry.name.startsWith("rollout_")) ||
      !entry.name.endsWith(".jsonl")
    ) {
      continue;
    }
    const stat = Deno.statSync(path);
    files.push({
      id: relative.slice(0, -6),
      path,
      artifactPath: relative,
      updatedAt: stat.mtime?.getTime() ?? 0,
      size: stat.size,
    });
  }
  return files;
}

export function discoverCodexSessions(directory: string) {
  return collectCodexSessions(directory).sort((a, b) =>
    b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
  );
}

function codexSession(records: Record[], id: string, updatedAt: number) {
  const current = decodeRecords(records);
  const usesLegacyDecoder = current.turns.length === 0 &&
    hasLegacyUsageEvidence(records);
  const decoded = usesLegacyDecoder ? decodeLegacyRecords(records) : current;
  const prompt = sessionPrompt(records);
  const promptTitle = prompt?.replace(
    /\s+/g,
    " ",
  )
    .trim().slice(0, 100);
  const transcriptUpdatedAt = [...records].reverse().find((record) =>
    record.timestamp && Number.isFinite(Date.parse(record.timestamp))
  )?.timestamp;
  const bounds = sessionBounds(decoded.turns);
  const summary: SessionSummary = {
    id,
    harness: "codex",
    title: promptTitle ??
      `Codex session ${id.split("/").at(-1)?.slice(8, 16) ?? id.slice(0, 8)}`,
    updatedAt: transcriptUpdatedAt
      ? Date.parse(transcriptUpdatedAt)
      : updatedAt,
    startedAt: bounds.startedAt,
    endedAt: bounds.endedAt,
    providers: [...decoded.providers],
    models: [...decoded.models],
    userTurns: decoded.turns.length,
    modelCalls: decoded.turns.reduce(
      (sum, turn) => sum + turn.calls.length,
      0,
    ),
    tokens: decoded.tokens,
  };
  return {
    summary,
    turns: decoded.turns,
    contextEvents: decoded.contextEvents,
  };
}

function sessionWorkingDirectory(records: Record[]) {
  return records.find((record) =>
    record.type === "session_meta" && record.payload?.cwd
  )?.payload?.cwd ?? records.find((record) =>
    record.payload?.cwd
  )?.payload?.cwd;
}

export function normalizeCodexSession(
  candidate: CodexSessionCandidate,
  text: string,
) {
  const records = readRecordsFromText(text, true);
  const normalized = codexSession(records, candidate.id, candidate.updatedAt);
  const workingDirectory = sessionWorkingDirectory(records);
  return workingDirectory === undefined
    ? normalized
    : { ...normalized, workingDirectory };
}

export type CodexSourceArtifactMetadata = {
  sourceIdentity?: string;
  parentSourceIdentity?: string;
};

export function codexSourceArtifactMetadata(
  text: string,
): CodexSourceArtifactMetadata {
  const records = readRecordsFromText(text, true);
  const metadata = records.find((record) => record.type === "session_meta")
    ?.payload;
  const result: CodexSourceArtifactMetadata = {};
  if (metadata?.id !== undefined) result.sourceIdentity = metadata.id;
  if (metadata?.forked_from_id !== undefined) {
    result.parentSourceIdentity = metadata.forked_from_id;
  }
  return result;
}
