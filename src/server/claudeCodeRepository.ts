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
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
}).passthrough();

const recordSchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  aiTitle: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  promptSource: z.string().optional(),
  origin: z.object({ kind: z.string().optional() }).passthrough().optional(),
  message: z.object({
    id: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    usage: z.object({
      input_tokens: z.number().int().nonnegative().default(0),
      cache_read_input_tokens: z.number().int().nonnegative().default(0),
      cache_creation_input_tokens: z.number().int().nonnegative().default(0),
      output_tokens: z.number().int().nonnegative().default(0),
      cache_creation: z.object({
        ephemeral_5m_input_tokens: z.number().int().nonnegative().default(0),
        ephemeral_1h_input_tokens: z.number().int().nonnegative().default(0),
      }).optional(),
    }).optional(),
  }).passthrough().optional(),
  toolUseResult: z.object({
    agentId: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

type Record = z.infer<typeof recordSchema>;
type IndexEntry = { summary?: string; firstPrompt?: string };

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

function blocks(record: Record) {
  return Array.isArray(record.message?.content) ? record.message.content : [];
}

function userText(record: Record) {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  return content?.find((block) => block.type === "text")?.text;
}

function startsTurn(record: Record, hasTurns: boolean) {
  if (record.type !== "user" || record.isMeta) return false;
  const text = userText(record);
  if (!text) return false;
  return record.origin?.kind === "human" ||
    record.promptSource === "typed" || record.promptSource === "sdk" ||
    text.startsWith("❯ ") || (record.isSidechain === true && !hasTurns);
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
  const calls = new Map<
    string,
    { call: ModelCall; blocks: ReturnType<typeof blocks> }
  >();
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();

  for (const record of records) {
    const timestamp = Date.parse(record.timestamp ?? "") || 0;
    if (record.type === "user") {
      const content = record.message?.content;
      if (startsTurn(record, turns.length > 0)) {
        turns.push({
          number: turns.length + 1,
          startedAt: timestamp,
          calls: [],
        });
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          for (const value of calls.values()) {
            const tool = value.call.activity.tools.find((item) =>
              (item as { id?: string }).id === block.tool_use_id
            );
            if (tool) {
              tool.status = block.is_error ? "error" : "completed";
              tool.completedAt = timestamp;
              if (record.toolUseResult?.agentId) {
                tool.childSessionID = record.toolUseResult.agentId;
              }
            }
          }
        }
      }
      continue;
    }
    if (
      record.type !== "assistant" || !record.message?.id ||
      !record.message.usage || turns.length === 0
    ) continue;

    const id = record.message.id;
    let decoded = calls.get(id);
    if (!decoded) {
      const source = record.message.usage;
      const cacheWrite = source.cache_creation_input_tokens || undefined;
      const cacheWrite5m = source.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      const cacheWrite1h = source.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const callTokens: TokenUsage = {
        uncachedInput: source.input_tokens,
        cacheRead: source.cache_read_input_tokens,
        cacheWrite,
        cacheWrite5m,
        cacheWrite1h,
        freshPrompt: source.input_tokens + (cacheWrite ?? 0),
        output: source.output_tokens,
        reasoning: 0,
        processed: source.input_tokens + source.cache_read_input_tokens +
          source.cache_creation_input_tokens + source.output_tokens,
      };
      if (callTokens.processed === 0) continue;
      const turn = turns.at(-1)!;
      const model = record.message.model ?? "unknown";
      const call: ModelCall = {
        id,
        callWithinTurn: turn.calls.length + 1,
        provider: "anthropic",
        model,
        startedAt: timestamp,
        tokens: callTokens,
        activity: { hasText: false, hasReasoning: false, tools: [] },
      };
      turn.calls.push(call);
      decoded = { call, blocks: [] };
      calls.set(id, decoded);
      providers.add("anthropic");
      models.add(model);
      addTokens(tokens, callTokens);
    }

    decoded.call.completedAt = timestamp;
    decoded.call.activity.finishReason = record.message.stop_reason ??
      undefined;
    for (const block of blocks(record)) {
      const key = JSON.stringify(block);
      if (decoded.blocks.some((existing) => JSON.stringify(existing) === key)) {
        continue;
      }
      decoded.blocks.push(block);
      if (block.type === "text") decoded.call.activity.hasText = true;
      if (block.type === "thinking") decoded.call.activity.hasReasoning = true;
      if (block.type === "tool_use" && block.name && block.id) {
        decoded.call.activity.tools.push(
          {
            name: block.name,
            status: "pending",
            startedAt: timestamp,
            // Kept internally while matching the later tool_result record.
            id: block.id,
          } as ModelCall["activity"]["tools"][number],
        );
      }
    }
  }
  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  return { turns: nonEmptyTurns, tokens, providers, models };
}

export class ClaudeCodeRepository {
  #index = new Map<string, IndexEntry>();

  constructor(private directory: string) {
    try {
      const parsed = z.object({
        entries: z.array(z.object({
          sessionId: z.string(),
          summary: z.string().optional(),
          firstPrompt: z.string().optional(),
        })),
      }).parse(
        JSON.parse(Deno.readTextFileSync(`${directory}/sessions-index.json`)),
      );
      for (const entry of parsed.entries) {
        this.#index.set(entry.sessionId, entry);
      }
    } catch {
      // The transcript is authoritative; the optional index only improves titles.
    }
  }

  #files() {
    return [...Deno.readDirSync(this.directory)]
      .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const path = `${this.directory}/${entry.name}`;
        return {
          id: entry.name.slice(0, -6),
          path,
          updatedAt: Deno.statSync(path).mtime?.getTime() ?? 0,
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
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
    const path = `${this.directory}/${id}.jsonl`;
    try {
      const stat = Deno.statSync(path);
      return sessionDetailSchema.parse(
        this.#detail(id, path, stat.mtime?.getTime() ?? 0),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  listUsageCalls(startedAt?: number) {
    return this.#files().filter((file) =>
      startedAt === undefined || file.updatedAt >= startedAt
    ).flatMap((file) =>
      usageCallsFromSession(
        sessionDetailSchema.parse(
          this.#detail(file.id, file.path, file.updatedAt),
        ),
      )
    ).filter((call) => startedAt === undefined || call.startedAt >= startedAt);
  }

  #summary(id: string, path: string, updatedAt: number): SessionSummary {
    const records = readRecords(path);
    const decoded = decodeRecords(records);
    const generatedTitle = [...records].reverse().find((record) =>
      record.aiTitle
    )?.aiTitle;
    const firstPrompt = records.find((record) => startsTurn(record, false));
    const promptTitle = userText(firstPrompt ?? { type: "" })?.replace(/\s+/g, " ")
      .trim().slice(0, 100);
    const transcriptUpdatedAt = [...records].reverse().find((record) =>
      record.timestamp && Number.isFinite(Date.parse(record.timestamp))
    )?.timestamp;
    const title = this.#index.get(id)?.summary ?? generatedTitle ??
      this.#index.get(id)?.firstPrompt ??
      promptTitle ?? `Claude Code session ${id.slice(0, 8)}`;
    const bounds = sessionBounds(decoded.turns);
    return {
      id,
      harness: "claude-code",
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
      tokens: decoded.tokens,
    };
  }

  #detail(
    id: string,
    path: string,
    updatedAt: number,
    parentID?: string,
    title?: string,
  ): unknown {
    const records = readRecords(path);
    const decoded = decodeRecords(records);
    const summary = this.#summary(id, path, updatedAt);
    const subagentDirectory = `${path.slice(0, -6)}/subagents`;
    let subagents: unknown[] = [];
    try {
      subagents = [...Deno.readDirSync(subagentDirectory)]
        .filter((entry) =>
          entry.isFile && entry.name.startsWith("agent-") &&
          entry.name.endsWith(".jsonl")
        )
        .map((entry) => {
          const childPath = `${subagentDirectory}/${entry.name}`;
          const childID = entry.name.slice(6, -6);
          let childTitle = `Subagent ${childID}`;
          try {
            const meta = z.object({ description: z.string().optional() }).parse(
              JSON.parse(
                Deno.readTextFileSync(
                  `${subagentDirectory}/agent-${childID}.meta.json`,
                ),
              ),
            );
            childTitle = meta.description ?? childTitle;
          } catch { /* optional metadata */ }
          return this.#detail(
            childID,
            childPath,
            Deno.statSync(childPath).mtime?.getTime() ?? updatedAt,
            id,
            childTitle,
          );
        });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return {
      ...summary,
      title: title ?? summary.title,
      parentID,
      turns: decoded.turns,
      subagents,
    };
  }
}
