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
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  isError: z.boolean().optional(),
}).passthrough();

const recordSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z.object({
    role: z.string().optional(),
    content: z.array(contentBlockSchema).optional(),
    api: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    stopReason: z.string().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    usage: z.object({
      input: z.number().int().nonnegative().default(0),
      output: z.number().int().nonnegative().default(0),
      cacheRead: z.number().int().nonnegative().default(0),
      cacheWrite: z.number().int().nonnegative().default(0),
      cacheWrite1h: z.number().int().nonnegative().default(0),
      totalTokens: z.number().int().nonnegative().optional(),
      reasoning: z.number().int().nonnegative().default(0),
      cost: z.object({
        total: z.number().nonnegative().default(0),
      }).passthrough().optional(),
    }).optional(),
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
  if (usage.cacheWrite !== undefined) {
    total.cacheWrite = (total.cacheWrite ?? 0) + usage.cacheWrite;
  }
  if (usage.cacheWrite5m !== undefined) {
    total.cacheWrite5m = (total.cacheWrite5m ?? 0) + usage.cacheWrite5m;
  }
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
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

function userText(record: Record) {
  return record.message?.content?.find((block) => block.type === "text")?.text;
}

function userImages(record: Record) {
  const content = record.message?.content ?? [];
  const blocks = content.filter((block) =>
    block.type === "image" || block.type === "input_image"
  ).length;
  if (blocks > 0) return blocks;
  // Pi may persist a clipboard attachment as its temporary image path in a
  // text block rather than as an image content block.
  return content.filter((block) =>
    block.type === "text" &&
    /(?:^|[\s"'(])[^\s"')]+\.(?:png|jpe?g|gif|webp|bmp)(?:$|[\s"')])/i.test(
      block.text ?? "",
    )
  ).length;
}

function basename(path: string | undefined) {
  if (!path) return undefined;
  return path.split("/").filter(Boolean).at(-1);
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
    { number: number; startedAt: number; calls: ModelCall[]; images?: number }
  > = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<
    string,
    ModelCall["activity"]["tools"][number]
  >();
  let reportedCost = 0;

  for (const record of records) {
    const timestamp = Date.parse(record.timestamp ?? "") || 0;
    const message = record.message;
    if (record.type !== "message" || !message?.role) continue;

    if (message.role === "user") {
      const text = userText(record);
      if (text?.trim()) {
        turns.push({
          number: turns.length + 1,
          startedAt: timestamp,
          calls: [],
          images: userImages(record),
        });
      }
      continue;
    }

    if (message.role === "toolResult") {
      if (!message.toolCallId) continue;
      const tool = tools.get(message.toolCallId);
      if (!tool) continue;
      tool.status = message.isError ? "error" : "completed";
      tool.completedAt = timestamp;
      continue;
    }

    if (message.role !== "assistant" || !message.usage || turns.length === 0) {
      continue;
    }

    const source = message.usage;
    const cacheWrite = source.cacheWrite > 0 ? source.cacheWrite : undefined;
    const cacheWrite1h = source.cacheWrite1h;
    const cacheWrite5m = cacheWrite === undefined
      ? undefined
      : Math.max(0, cacheWrite - cacheWrite1h);
    const callTokens: TokenUsage = {
      uncachedInput: source.input,
      cacheRead: source.cacheRead,
      cacheWrite,
      cacheWrite5m,
      cacheWrite1h: cacheWrite === undefined ? undefined : cacheWrite1h,
      freshPrompt: source.input + (cacheWrite ?? 0),
      output: source.output,
      reasoning: source.reasoning,
      processed: source.totalTokens ??
        source.input + source.cacheRead + source.cacheWrite + source.output +
          source.reasoning,
    };
    const cost = source.cost?.total ?? 0;
    if (callTokens.processed === 0 && cost === 0) continue;

    const turn = turns.at(-1)!;
    const provider = message.provider ?? "unknown";
    const model = message.model ?? "unknown";
    const call: ModelCall = {
      id: record.id ?? `${turn.number}-${turn.calls.length + 1}`,
      callWithinTurn: turn.calls.length + 1,
      provider,
      model,
      startedAt: timestamp,
      completedAt: timestamp,
      reportedCost: cost,
      tokens: callTokens,
      activity: {
        finishReason: message.stopReason,
        ...(turn.images && turn.calls.length === 0
          ? { images: turn.images }
          : {}),
        hasText: false,
        hasReasoning: source.reasoning > 0,
        tools: [],
      },
    };

    for (const block of message.content ?? []) {
      if (block.type === "text") call.activity.hasText = true;
      if (block.type === "thinking") call.activity.hasReasoning = true;
      if (block.type === "toolCall" && block.id && block.name) {
        const tool = {
          name: block.name,
          status: "pending",
          startedAt: timestamp,
        };
        call.activity.tools.push(tool);
        tools.set(block.id, tool);
      }
    }

    providers.add(provider);
    models.delete(model);
    models.add(model);
    addTokens(tokens, callTokens);
    reportedCost += cost;
    turn.calls.push(call);
  }

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  return { turns: nonEmptyTurns, tokens, providers, models, reportedCost };
}

export class PiRepository {
  constructor(private directory: string) {}

  #files() {
    const files: FileEntry[] = [];
    for (const project of Deno.readDirSync(this.directory)) {
      if (!project.isDirectory) continue;
      const projectPath = `${this.directory}/${project.name}`;
      for (const entry of Deno.readDirSync(projectPath)) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const path = `${projectPath}/${entry.name}`;
        files.push({
          id: `${project.name}/${entry.name.slice(0, -6)}`,
          path,
          updatedAt: Deno.statSync(path).mtime?.getTime() ?? 0,
        });
      }
    }
    return files.sort((a, b) =>
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
    const header = records.find((record) => record.type === "session");
    const firstPrompt = records.find((record) =>
      record.type === "message" && record.message?.role === "user" &&
      userText(record)?.trim()
    );
    const promptTitle = userText(firstPrompt ?? { type: "" })?.replace(/\s+/g, " ")
      .trim().slice(0, 100);
    const title = promptTitle ??
      `Pi session ${basename(header?.cwd) ?? id.split("/").at(-1)?.slice(0, 8)}`;
    const transcriptUpdatedAt = [...records].reverse().find((record) =>
      record.timestamp && Number.isFinite(Date.parse(record.timestamp))
    )?.timestamp;
    const bounds = sessionBounds(decoded.turns);
    return {
      id,
      harness: "pi",
      title,
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
      reportedCost: decoded.reportedCost,
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
