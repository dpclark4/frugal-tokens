import { z } from "zod";
import {
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { usageCallsFromSession } from "./usage.ts";
import type {
  ReasoningSettingImport,
  SessionCallImport,
  SessionContentImport,
  SessionContextEventImport,
  SessionToolImport,
  SessionTurnImport,
} from "./sessionRepository.ts";

const contentPreviewLimit = 2_048;

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.string().optional(),
}).passthrough();

const reasoningEffortSettingsSchema = z.object({
  reasoning_effort: z.string().optional(),
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
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
    turn_id: z.string().optional(),
    message: z.string().optional(),
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

function preview(value: string): SessionContentImport {
  return {
    kind: "text",
    preview: value.slice(0, contentPreviewLimit),
    originalLength: value.length,
    truncated: value.length > contentPreviewLimit,
  };
}

function serializedPreview(value: unknown) {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const metadata = preview(text);
  return {
    preview: metadata.preview,
    originalLength: metadata.originalLength,
    truncated: metadata.truncated,
  };
}

function messageContent(record: Record): SessionContentImport[] {
  return (record.payload?.content ?? []).flatMap((block) => {
    if (block.text !== undefined) return [preview(block.text)];
    if (block.type !== "input_image") return [];
    const mimeType = block.image_url?.match(/^data:([^;,]+)[;,]/)?.[1];
    return [{ kind: "image", mimeType }];
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

function sessionPrompt(records: Record[]) {
  // Codex writes startup instructions as response_item user content, before
  // the actual turn prompt. The event_msg user_message is the user-authored
  // prompt and is therefore the better title source when it is available.
  return records.map(legacyUserText).find((value) => value?.trim()) ??
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
  if (typeof payload.input !== "string") return payload.name;
  const match = payload.input.match(/tools\.([A-Za-z0-9_]+)/);
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
  return maxRecordTime(records.filter((record) =>
    record.type === "response_item" &&
    (record.payload?.type === "custom_tool_call_output" ||
      record.payload?.type === "function_call_output")
  ));
}

function isAssistantOutput(record: Record) {
  return record.type === "response_item" && hasText(record);
}

function inferCodexCallTimings(records: Record[]) {
  const turns: CodexTurnTiming[] = [];
  let current: CodexTurnTiming | undefined;

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
      continue;
    }
    if (!current) continue;

    if (
      record.type === "response_item" && payload?.type === "message" &&
      payload.role === "user"
    ) {
      current.inputAt = time;
    } else if (
      record.type === "event_msg" && payload?.type === "user_message"
    ) {
      current.inputAt = time;
    }

    if (record.type === "event_msg" && payload?.type === "token_count") {
      if (tokenUsageSignature(record) !== undefined) {
        current.tokenIndexes.push(recordIndex);
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
        completedAt === undefined && callIndex === turn.tokenIndexes.length - 1 &&
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

      calls.push({ startedAt, completedAt });
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
  const collaborationEffort =
    payload.collaboration_mode?.settings?.reasoning_effort;
  if (collaborationEffort !== undefined) {
    return {
      settingName: "reasoning_effort",
      settingValue: collaborationEffort,
      sourceFieldPath:
        "payload.collaboration_mode.settings.reasoning_effort",
    };
  }
  const threadEffort = payload.thread_settings?.reasoning_effort;
  if (threadEffort !== undefined) {
    return {
      settingName: "reasoning_effort",
      settingValue: threadEffort,
      sourceFieldPath: "payload.thread_settings.reasoning_effort",
    };
  }
  const threadCollaborationEffort = payload.thread_settings
    ?.collaboration_mode?.settings?.reasoning_effort;
  if (threadCollaborationEffort !== undefined) {
    return {
      settingName: "reasoning_effort",
      settingValue: threadCollaborationEffort,
      sourceFieldPath:
        "payload.thread_settings.collaboration_mode.settings.reasoning_effort",
    };
  }
  return undefined;
}

function decodeRecords(records: Record[]) {
  const turns: SessionTurnImport[] = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<string, SessionToolImport>();
  let currentModel = "unknown";
  let pendingHasText = false;
  let pendingTools: SessionToolImport[] = [];
  let pendingContent: SessionContentImport[] = [];
  const callTimings = inferCodexCallTimings(records);
  type PendingContextEvent = SessionContextEventImport & {
    affectedCallReference?: SessionCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];
  let lastCall: SessionCallImport | undefined;
  let activeReasoningSetting:
    | Omit<ReasoningSettingImport, "provenance">
    | undefined;

  for (const [recordIndex, record] of records.entries()) {
    const payload = record.payload;
    const time = timestamp(record);

    if (record.type === "event_msg" && payload?.type === "context_compacted") {
      if (
        lastCall && lastCall.tokens.uncachedInput === 0 &&
        lastCall.tokens.cacheRead === 0 && lastCall.tokens.output === 0 &&
        lastCall.tokens.reasoning === 0 && lastCall.tokens.processed > 0 &&
        !lastCall.activity.hasText && lastCall.activity.tools.length === 0
      ) {
        // Codex emits this opaque total-only call for compaction itself. Keep
        // it canonical, but tag it so only Codex hydration hides the machinery.
        lastCall.id = `context-operation:${lastCall.id}`;
      }
      const event: PendingContextEvent = {
        type: "compaction",
        sourceOrder: recordIndex + 1,
        ...(time === 0 ? {} : { occurredAt: time }),
      };
      contextEvents.push(event);
      pendingContextEvents.push(event);
      continue;
    }

    if (record.type === "turn_context" && payload) {
      if (payload.model) currentModel = payload.model;
      const setting = codexReasoningSetting(payload);
      if (setting !== undefined) {
        activeReasoningSetting = {
          ...setting,
          sourceOrder: recordIndex + 1,
          ...(time === 0 ? {} : { observedAt: time }),
        };
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
      turns.push({
        number: turns.length + 1,
        startedAt: eventTime(record),
        ...(activeReasoningSetting === undefined ? {} : {
          reasoningSetting: {
            ...activeReasoningSetting,
            provenance: "inherited" as const,
          },
        }),
        calls: [],
      });
      pendingHasText = false;
      pendingTools = [];
      pendingContent = [];
      continue;
    }

    if (turns.length === 0) continue;

    if (
      record.type === "response_item" && payload?.type === "message" &&
      payload.role === "user"
    ) {
      turns.at(-1)!.inputs = messageContent(record);
      continue;
    }

    if (
      record.type === "response_item" && payload?.type === "custom_tool_call"
    ) {
      const name = toolName(record);
      if (!name) continue;
      const input = serializedPreview(payload.input);
      const tool = {
        name,
        status: "pending",
        startedAt: time,
        sourceID: payload.call_id ?? payload.id,
        input,
        ...(input?.preview === undefined
          ? {}
          : { inputPreview: input.preview }),
      };
      pendingTools.push(tool);
      if (tool.sourceID) tools.set(tool.sourceID, tool);
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
      }
      continue;
    }

    if (record.type === "response_item" && hasText(record)) {
      pendingHasText = true;
      pendingContent.push(...messageContent(record));
      continue;
    }

    if (
      record.type !== "event_msg" || payload?.type !== "token_count" ||
      !payload.info?.last_token_usage
    ) continue;

    const source = payload.info.last_token_usage;
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
    const call: SessionCallImport = {
      id: `${turn.number}-${turn.calls.length + 1}`,
      callWithinTurn: turn.calls.length + 1,
      ...(pendingContent.find((item) => item.kind === "text")?.preview ===
          undefined
        ? {}
        : {
          preview: pendingContent.find((item) => item.kind === "text")!.preview,
        }),
      provider: "openai",
      model: currentModel,
      startedAt: timing?.startedAt ?? time,
      completedAt: timing?.completedAt,
      tokens: callTokens,
      ...(activeReasoningSetting === undefined ? {} : {
        reasoningSetting: {
          ...activeReasoningSetting,
          provenance: "inherited" as const,
        },
      }),
      activity: {
        ...(images ? { images } : {}),
        hasText: pendingHasText,
        hasReasoning: source.reasoning_output_tokens > 0,
        tools: pendingTools,
      },
      content: pendingContent,
    };

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
  }

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  const normalizedContextEvents: SessionContextEventImport[] = contextEvents
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
    return sessionDetailSchema.parse(this.#detail(file));
  }

  listUsageCalls(startedAt?: number) {
    return this.#files().filter((file) =>
      startedAt === undefined || file.updatedAt >= startedAt
    ).flatMap((file) =>
      usageCallsFromSession(sessionDetailSchema.parse(this.#detail(file)))
    ).filter((call) => startedAt === undefined || call.startedAt >= startedAt);
  }

  #summary(id: string, path: string, updatedAt: number): SessionSummary {
    return codexSession(readRecords(path), id, updatedAt).summary;
  }

  #detail(file: CodexSessionCandidate): unknown {
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
        return {
          ...call,
          ...(contextEventsBefore.length === 0 ? {} : { contextEventsBefore }),
        };
      }),
    })).filter((turn) => turn.calls.length > 0).map((turn, index) => ({
      ...turn,
      number: index + 1,
    }));
    const contextEvents = normalized.contextEvents.filter((event) =>
      event.affectedCall === undefined
    );
    return {
      ...normalized.summary,
      userTurns: turns.length,
      modelCalls: turns.reduce((total, turn) => total + turn.calls.length, 0),
      parentID: undefined,
      turns,
      ...(contextEvents.length === 0 ? {} : { contextEvents }),
      subagents: [],
    };
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

export function normalizeCodexSession(
  candidate: CodexSessionCandidate,
  text: string,
) {
  return codexSession(
    readRecordsFromText(text, true),
    candidate.id,
    candidate.updatedAt,
  );
}
