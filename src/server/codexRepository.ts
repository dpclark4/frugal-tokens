import { z } from "zod";
import {
  type ModelCall,
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { usageCallsFromSession } from "./usage.ts";

const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

const recordSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    phase: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
    content: z.array(contentBlockSchema).optional(),
    info: z.object({
      last_token_usage: z.object({
        input_tokens: z.number().int().nonnegative().default(0),
        cached_input_tokens: z.number().int().nonnegative().default(0),
        output_tokens: z.number().int().nonnegative().default(0),
        reasoning_output_tokens: z.number().int().nonnegative().default(0),
      }).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type Record = z.infer<typeof recordSchema>;
type FileEntry = {
  id: string;
  path: string;
  updatedAt: number;
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

function readRecords(path: string) {
  const records: Record[] = [];
  for (const line of Deno.readTextFileSync(path).split("\n")) {
    if (!line) continue;
    try {
      const result = recordSchema.safeParse(JSON.parse(line));
      if (result.success) records.push(result.data);
    } catch {
      // A partially written final line should not hide the rest of the session.
    }
  }
  return records;
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
  turns: Array<{ startedAt: number; calls: Array<{ startedAt: number; completedAt?: number }> }>,
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
  const turns: Array<
    { number: number; startedAt: number; calls: ModelCall[] }
  > = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<string, ModelCall["activity"]["tools"][number]>();
  let currentModel = "unknown";
  let pendingHasText = false;
  let pendingTools: Array<
    ModelCall["activity"]["tools"][number] & { id?: string }
  > = [];

  for (const record of records) {
    const payload = record.payload;
    const time = timestamp(record);

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
      continue;
    }

    if (turns.length === 0) continue;

    if (record.type === "response_item" && payload?.type === "custom_tool_call") {
      const name = toolName(record);
      if (!name) continue;
      const tool = {
        name,
        status: "pending",
        startedAt: time,
        id: payload.call_id ?? payload.id,
      };
      pendingTools.push(tool);
      if (tool.id) tools.set(tool.id, tool);
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
      }
      continue;
    }

    if (record.type === "response_item" && hasText(record)) {
      pendingHasText = true;
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
      processed: source.input_tokens + source.output_tokens +
        source.reasoning_output_tokens,
    };
    if (callTokens.processed === 0) continue;

    const turn = turns.at(-1)!;
    const call: ModelCall = {
      id: `${turn.number}-${turn.calls.length + 1}`,
      callWithinTurn: turn.calls.length + 1,
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
    };

    providers.add("openai");
    models.delete(currentModel);
    models.add(currentModel);
    addTokens(tokens, callTokens);
    turn.calls.push(call);
    pendingHasText = false;
    pendingTools = [];
  }

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  return { turns: nonEmptyTurns, tokens, providers, models };
}

export class CodexRepository {
  constructor(private directory: string) {}

  #collectFiles(directory: string, prefix = ""): FileEntry[] {
    const files: FileEntry[] = [];
    for (const entry of Deno.readDirSync(directory)) {
      const path = `${directory}/${entry.name}`;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        files.push(...this.#collectFiles(path, relative));
        continue;
      }
      if (!entry.isFile || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      files.push({
        id: relative.slice(0, -6),
        path,
        updatedAt: Deno.statSync(path).mtime?.getTime() ?? 0,
      });
    }
    return files;
  }

  #files() {
    return this.#collectFiles(this.directory).sort((a, b) =>
      b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
    );
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
    const records = readRecords(path);
    const decoded = decodeRecords(records);
    const firstPrompt = records.find((record) => userText(record)?.trim());
    const promptTitle = userText(firstPrompt ?? { type: "" })?.replace(/\s+/g, " ")
      .trim().slice(0, 100);
    const transcriptUpdatedAt = [...records].reverse().find((record) =>
      record.timestamp && Number.isFinite(Date.parse(record.timestamp))
    )?.timestamp;
    const bounds = sessionBounds(decoded.turns);
    return {
      id,
      harness: "codex",
      title: promptTitle ?? `Codex session ${id.split("/").at(-1)?.slice(8, 16) ?? id.slice(0, 8)}`,
      updatedAt: transcriptUpdatedAt ? Date.parse(transcriptUpdatedAt) : updatedAt,
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
  }

  #detail(file: FileEntry): unknown {
    const records = readRecords(file.path);
    const decoded = decodeRecords(records);
    return {
      ...this.#summary(file.id, file.path, file.updatedAt),
      parentID: undefined,
      turns: decoded.turns,
      subagents: [],
    };
  }
}
