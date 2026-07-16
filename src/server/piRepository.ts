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
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  isError: z.boolean().optional(),
  mime: z.string().optional(),
  mediaType: z.string().optional(),
  arguments: z.unknown().optional(),
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
export type PiSessionCandidate = {
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

function readRecordsFromText(text: string, strict = false) {
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

function contentMetadata(
  blocks: z.infer<typeof contentBlockSchema>[],
  includeReasoning = false,
): SessionContentImport[] {
  return blocks.flatMap((block) => {
    if (block.type === "text" && block.text !== undefined) {
      return [preview(block.text)];
    }
    if (block.type === "thinking") {
      return includeReasoning ? [{ kind: "reasoning" }] : [];
    }
    if (block.type === "image" || block.type === "input_image") {
      return [{ kind: "image", mimeType: block.mime ?? block.mediaType }];
    }
    return [];
  });
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

function userText(record: Record) {
  return record.message?.content?.find((block) => block.type === "text")?.text;
}

function userImages(record: Record) {
  const content = record.message?.content ?? [];
  const blocks =
    content.filter((block) =>
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
  const turns: Array<SessionTurnImport & { images?: number }> = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<string, SessionToolImport>();
  let reportedCost = 0;
  type PendingContextEvent = SessionContextEventImport & {
    affectedCallReference?: SessionCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];

  for (const [recordIndex, record] of records.entries()) {
    const timestamp = Date.parse(record.timestamp ?? "") || 0;
    if (record.type === "compaction") {
      const event: PendingContextEvent = {
        type: "compaction",
        sourceOrder: recordIndex + 1,
        ...(timestamp === 0 ? {} : { occurredAt: timestamp }),
      };
      contextEvents.push(event);
      pendingContextEvents.push(event);
      continue;
    }
    const message = record.message;
    if (record.type !== "message" || !message?.role) continue;

    if (message.role === "user") {
      const text = userText(record);
      if (text?.trim()) {
        turns.push({
          number: turns.length + 1,
          startedAt: timestamp,
          calls: [],
          inputs: contentMetadata(record.message?.content ?? []),
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
      tool.output = serializedPreview(
        message.content?.map((block) => block.text ?? block.thinking).filter(
          Boolean,
        )
          .join("\n"),
      );
      tool.outputPreview = tool.output?.preview;
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
    const content = contentMetadata(message.content ?? [], true);
    const call: SessionCallImport = {
      id: record.id ?? `${turn.number}-${turn.calls.length + 1}`,
      callWithinTurn: turn.calls.length + 1,
      ...(content.find((item) => item.kind === "text")?.preview === undefined
        ? {}
        : {
          preview: content.find((item) => item.kind === "text")!.preview,
        }),
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
      content,
    };

    for (const block of message.content ?? []) {
      if (block.type === "text") call.activity.hasText = true;
      if (block.type === "thinking") call.activity.hasReasoning = true;
      if (block.type === "toolCall" && block.id && block.name) {
        const input = serializedPreview(block.arguments);
        const tool = {
          sourceID: block.id,
          name: block.name,
          status: "pending",
          startedAt: timestamp,
          input,
          ...(input?.preview === undefined
            ? {}
            : { inputPreview: input.preview }),
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
    for (const event of pendingContextEvents) {
      event.affectedCallReference = call;
    }
    pendingContextEvents.length = 0;
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
    reportedCost,
  };
}

export class PiRepository {
  constructor(private directory: string) {}

  #files() {
    return discoverPiSessions(this.directory);
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
    return piSession(readRecords(path), id, updatedAt).summary;
  }

  #detail(file: PiSessionCandidate): unknown {
    const normalized = piSession(
      readRecords(file.path),
      file.id,
      file.updatedAt,
    );
    const turns = normalized.turns.map((turn) => ({
      ...turn,
      calls: turn.calls.map((call) => ({
        ...call,
        contextEventsBefore: normalized.contextEvents.filter((event) =>
          event.affectedCall?.turn === turn.number &&
          event.affectedCall.call === call.callWithinTurn
        ).map(({ affectedCall: _affectedCall, ...event }) => event),
      })),
    }));
    return {
      ...normalized.summary,
      parentID: undefined,
      turns,
      contextEvents: normalized.contextEvents.filter((event) =>
        event.affectedCall === undefined
      ),
      subagents: [],
    };
  }
}

export function discoverPiSessions(directory: string) {
  const files: PiSessionCandidate[] = [];
  for (const project of Deno.readDirSync(directory)) {
    if (!project.isDirectory) continue;
    const projectPath = `${directory}/${project.name}`;
    for (const entry of Deno.readDirSync(projectPath)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = `${projectPath}/${entry.name}`;
      const stat = Deno.statSync(path);
      files.push({
        id: `${project.name}/${entry.name.slice(0, -6)}`,
        path,
        artifactPath: `${project.name}/${entry.name}`,
        updatedAt: stat.mtime?.getTime() ?? 0,
        size: stat.size,
      });
    }
  }
  return files.sort((a, b) =>
    b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
  );
}

function piSession(records: Record[], id: string, updatedAt: number) {
  const decoded = decodeRecords(records);
  const header = records.find((record) => record.type === "session");
  const firstPrompt = records.find((record) =>
    record.type === "message" && record.message?.role === "user" &&
    userText(record)?.trim()
  );
  const promptTitle = userText(firstPrompt ?? { type: "" })?.replace(
    /\s+/g,
    " ",
  )
    .trim().slice(0, 100);
  const title = promptTitle ??
    `Pi session ${basename(header?.cwd) ?? id.split("/").at(-1)?.slice(0, 8)}`;
  const transcriptUpdatedAt = [...records].reverse().find((record) =>
    record.timestamp && Number.isFinite(Date.parse(record.timestamp))
  )?.timestamp;
  const bounds = sessionBounds(decoded.turns);
  const summary: SessionSummary = {
    id,
    harness: "pi",
    title,
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
    reportedCost: decoded.reportedCost,
    tokens: decoded.tokens,
  };
  return {
    summary,
    turns: decoded.turns,
    contextEvents: decoded.contextEvents,
  };
}

export function normalizePiSession(
  candidate: PiSessionCandidate,
  text: string,
) {
  return piSession(
    readRecordsFromText(text, true),
    candidate.id,
    candidate.updatedAt,
  );
}
