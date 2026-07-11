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
  mime: z.string().optional(),
  tool: z.string().optional(),
  state: z.object({
    status: z.string().optional(),
    metadata: z.object({
      sessionId: z.string().optional(),
    }).optional(),
    time: z.object({
      start: z.number().optional(),
      end: z.number().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

type SessionRow = {
  id: string;
  parent_id: string | null;
  title: string;
  model: string | null;
  agent: string | null;
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
    if (part.type === "file" && part.mime?.startsWith("image/")) {
      current.images = (current.images ?? 0) + 1;
    }
    if (part.type === "tool" && part.tool) {
      current.tools.push({
        name: part.tool,
        status: part.state?.status ?? "unknown",
        startedAt: part.state?.time?.start,
        completedAt: part.state?.time?.end,
        childSessionID: part.state?.metadata?.sessionId,
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
  let pendingImages = 0;

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
      pendingImages = activityByMessage.get(row.id)?.images ?? 0;
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
      cacheWrite5m: undefined,
      cacheWrite1h: undefined,
      freshPrompt: source.input + (cacheWrite ?? 0),
      output: source.output,
      reasoning: source.reasoning,
      processed: source.input + source.cache.read + source.cache.write +
        source.output + source.reasoning,
    };
    const cost = message.cost ?? 0;
    if (callTokens.processed === 0 && cost === 0) continue;

    const turn = turns.at(-1)!;
    const provider = message.providerID ?? "unknown";
    const model = message.modelID ?? "unknown";
    const activity = activityByMessage.get(row.id) ?? {
      hasText: false,
      hasReasoning: source.reasoning > 0,
      tools: [],
    };
    if (pendingImages > 0) {
      activity.images = pendingImages;
      pendingImages = 0;
    }
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

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  return {
    turns: nonEmptyTurns,
    providers,
    models,
    tokens,
    reportedCost,
  };
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
      (this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM session WHERE parent_id IS NULL",
        )
        .get() as { count: number }).count,
    );
    const rows = this.#db.prepare(`
      SELECT id, parent_id, title, model, agent, time_updated
      FROM session
      WHERE parent_id IS NULL
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
      SELECT id, parent_id, title, model, agent, time_updated
      FROM session
      WHERE id = ?
    `).get(id) as SessionRow | undefined;
    if (!row) return undefined;

    return sessionDetailSchema.parse(this.#detail(row, new Set()));
  }

  #summary(row: SessionRow): SessionSummary {
    return this.#toSummary(row, this.#decodeSession(row.id));
  }

  #detail(row: SessionRow, visited: Set<string>): unknown {
    visited.add(row.id);
    const decoded = this.#decodeSession(row.id, true);
    const children = this.#db.prepare(`
      SELECT id, parent_id, title, model, agent, time_updated
      FROM session
      WHERE parent_id = ?
      ORDER BY time_created, id
    `).all(row.id) as SessionRow[];
    return {
      ...this.#toSummary(row, decoded),
      parentID: row.parent_id ?? undefined,
      agent: row.agent ?? undefined,
      turns: decoded.turns,
      subagents: children
        .filter((child) => !visited.has(child.id))
        .map((child) => this.#detail(child, new Set(visited))),
    };
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
    const bounds = sessionBounds(decoded.turns);
    return {
      id: row.id,
      harness: "opencode",
      title: row.title,
      updatedAt: row.time_updated,
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
}
