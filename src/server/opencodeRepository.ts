import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type ModelCall,
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";

const messageDataSchema = z.object({
  role: z.string(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  finish: z.string().optional(),
  cost: z.number().nonnegative().optional(),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }).optional(),
  tokens: z.object({
    input: z.number().int().nonnegative().default(0),
    output: z.number().int().nonnegative().default(0),
    reasoning: z.number().int().nonnegative().default(0),
    cache: z.object({
      read: z.number().int().nonnegative().default(0),
      write: z.number().int().nonnegative().default(0),
    }).default({ read: 0, write: 0 }),
  }).optional(),
}).passthrough();

const partDataSchema = z.object({
  type: z.string(),
  tool: z.string().optional(),
  state: z.object({
    status: z.string().optional(),
    time: z.object({
      start: z.number().optional(),
      end: z.number().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

type SessionRow = {
  id: string;
  title: string;
  model: string | null;
  time_updated: number;
};

type MessageRow = {
  id: string;
  time_created: number;
  data: string;
};

type PartRow = {
  message_id: string;
  data: string;
};

type CallActivity = ModelCall["activity"];

const emptyTokens = (): TokenUsage => ({
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: undefined,
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
}

function decodeParts(rows: PartRow[]) {
  const activity = new Map<string, CallActivity>();
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.data);
    } catch {
      continue;
    }
    const result = partDataSchema.safeParse(raw);
    if (!result.success) continue;
    const part = result.data;
    const current = activity.get(row.message_id) ?? {
      hasText: false,
      hasReasoning: false,
      tools: [],
    };
    if (part.type === "text") current.hasText = true;
    if (part.type === "reasoning") current.hasReasoning = true;
    if (part.type === "tool" && part.tool) {
      current.tools.push({
        name: part.tool,
        status: part.state?.status ?? "unknown",
        startedAt: part.state?.time?.start,
        completedAt: part.state?.time?.end,
      });
    }
    activity.set(row.message_id, current);
  }
  return activity;
}

function decodeMessages(
  rows: MessageRow[],
  activityByMessage = new Map<string, CallActivity>(),
) {
  const turns: Array<
    { number: number; startedAt: number; calls: ModelCall[] }
  > = [];
  const providers = new Set<string>();
  const models = new Set<string>();
  const tokens = emptyTokens();
  let reportedCost = 0;

  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.data);
    } catch {
      continue;
    }
    const result = messageDataSchema.safeParse(raw);
    if (!result.success) continue;
    const message = result.data;

    if (message.role === "user") {
      turns.push({
        number: turns.length + 1,
        startedAt: row.time_created,
        calls: [],
      });
      continue;
    }
    if (message.role !== "assistant" || !message.tokens || turns.length === 0) {
      continue;
    }

    const source = message.tokens;
    const cacheWrite = source.cache.write > 0 ? source.cache.write : undefined;
    const callTokens: TokenUsage = {
      uncachedInput: source.input,
      cacheRead: source.cache.read,
      cacheWrite,
      freshPrompt: source.input + (cacheWrite ?? 0),
      output: source.output,
      reasoning: source.reasoning,
      processed: source.input + source.cache.read + source.cache.write +
        source.output + source.reasoning,
    };
    if (callTokens.processed === 0) continue;

    const turn = turns.at(-1)!;
    const provider = message.providerID ?? "unknown";
    const model = message.modelID ?? "unknown";
    const cost = message.cost ?? 0;
    const activity = activityByMessage.get(row.id) ?? {
      hasText: false,
      hasReasoning: source.reasoning > 0,
      tools: [],
    };
    activity.finishReason = message.finish;
    providers.add(provider);
    models.add(model);
    addTokens(tokens, callTokens);
    reportedCost += cost;
    turn.calls.push({
      id: row.id,
      callWithinTurn: turn.calls.length + 1,
      provider,
      model,
      startedAt: message.time?.created ?? row.time_created,
      completedAt: message.time?.completed,
      reportedCost: cost,
      tokens: callTokens,
      activity,
    });
  }

  return { turns, providers, models, tokens, reportedCost };
}

function fallbackModel(modelJson: string | null) {
  if (!modelJson) return undefined;
  try {
    const model = z.object({ id: z.string(), providerID: z.string() })
      .safeParse(JSON.parse(modelJson));
    return model.success ? model.data : undefined;
  } catch {
    return undefined;
  }
}

export class OpenCodeRepository {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
  }

  close() {
    this.#db.close();
  }

  listSessions(page: number, pageSize: number) {
    const totalItems = Number(
      (this.#db.prepare("SELECT COUNT(*) AS count FROM session").get() as {
        count: number;
      }).count,
    );
    const rows = this.#db.prepare(`
      SELECT id, title, model, time_updated
      FROM session
      ORDER BY time_updated DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize) as SessionRow[];
    const items = rows.map((row) => this.#summary(row));

    return sessionListResponseSchema.parse({
      items,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    });
  }

  getSession(id: string) {
    const row = this.#db.prepare(`
      SELECT id, title, model, time_updated
      FROM session
      WHERE id = ?
    `).get(id) as SessionRow | undefined;
    if (!row) return undefined;

    const decoded = this.#decodeSession(id, true);
    return sessionDetailSchema.parse({
      ...this.#toSummary(row, decoded),
      turns: decoded.turns,
    });
  }

  #summary(row: SessionRow): SessionSummary {
    return this.#toSummary(row, this.#decodeSession(row.id));
  }

  #decodeSession(id: string, includeActivity = false) {
    const messages = this.#db.prepare(`
      SELECT id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(id) as MessageRow[];
    if (!includeActivity) return decodeMessages(messages);
    const parts = this.#db.prepare(`
      SELECT message_id, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(id) as PartRow[];
    return decodeMessages(messages, decodeParts(parts));
  }

  #toSummary(
    row: SessionRow,
    decoded: ReturnType<typeof decodeMessages>,
  ): SessionSummary {
    const fallback = fallbackModel(row.model);
    if (decoded.providers.size === 0 && fallback) {
      decoded.providers.add(fallback.providerID);
    }
    if (decoded.models.size === 0 && fallback) decoded.models.add(fallback.id);
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.time_updated,
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
}
