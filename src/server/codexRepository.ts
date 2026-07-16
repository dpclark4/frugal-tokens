import { z } from "zod";
import {
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { usageCallsFromSession } from "./usage.ts";
import type {
  SessionCallImport,
  SessionContentImport,
  SessionContextEventImport,
  SessionToolImport,
  SessionTurnImport,
} from "./sessionRepository.ts";

const contentPreviewLimit = 512;

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

const recordSchema = z.object({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    phase: z.string().nullable().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
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
  return (record.payload?.content ?? []).flatMap((block) =>
    block.text === undefined ? [] : [preview(block.text)]
  );
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
  type PendingContextEvent = SessionContextEventImport & {
    affectedCallReference?: SessionCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];
  let lastCall: SessionCallImport | undefined;

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

    if (record.type === "turn_context" && payload?.model) {
      currentModel = payload.model;
      continue;
    }

    if (record.type === "event_msg" && payload?.type === "task_started") {
      turns.push({
        number: turns.length + 1,
        startedAt: time,
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
      startedAt: time,
      completedAt: time,
      tokens: callTokens,
      activity: {
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
  const decoded = decodeRecords(records);
  const firstPrompt = records.find((record) => userText(record)?.trim());
  const promptTitle = userText(firstPrompt ?? { type: "" })?.replace(
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
