import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import type { UsageCall } from "./usage.ts";
import type {
  CompactionCheckpointItemImport,
  CompactionDetailImport,
  ConversationCallImport,
  ConversationContentImport,
  ConversationContextEventImport,
  ConversationToolImport,
  ConversationTurnImport,
  LinearConversationImport,
} from "./conversationImportTypes.ts";
import type { ProjectionCheckpoint } from "./sourceArtifactRepository.ts";
import {
  booleanValue,
  numberCheckpointItems,
  objectValue,
  referenceCheckpointItem,
  stringValue,
} from "./compactionImport.ts";

const contentPreviewLimit = 2_048;

const messageDataSchema = z.object({
  role: z.string(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  variant: z.string().optional(),
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
  text: z.unknown().optional(),
  synthetic: z.boolean().optional(),
  mime: z.string().optional(),
  callID: z.string().optional(),
  tool: z.string().optional(),
  auto: z.unknown().optional(),
  overflow: z.unknown().optional(),
  tail_start_id: z.unknown().optional(),
  state: z.object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.object({
      sessionId: z.string().optional(),
    }).optional(),
    time: z.object({
      start: z.number().optional(),
      end: z.number().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

export type OpenCodeSessionRow = {
  [column: string]: unknown;
  id: string;
  parent_id: string | null;
  title: string;
  model: string | null;
  agent: string | null;
  directory?: string | null;
  time_created: number;
  time_updated: number;
};

export type OpenCodeMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

type UsageMessageRow = OpenCodeMessageRow;
type UsageSessionRow = {
  id: string;
  parent_id: string | null;
  time_created: number;
};

export type OpenCodePartRow = {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

type SessionRow = OpenCodeSessionRow;
type MessageRow = OpenCodeMessageRow;
type PartRow = OpenCodePartRow;

type DecodedParts = {
  activity: ConversationCallImport["activity"];
  content: ConversationContentImport[];
  compaction?: {
    sourceID: string;
    auto?: unknown;
    overflow?: unknown;
    tailStartID?: unknown;
  };
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

function preview(value: string): ConversationContentImport {
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
  const valuePreview = preview(text);
  return {
    preview: valuePreview.preview,
    originalLength: valuePreview.originalLength,
    truncated: valuePreview.truncated,
  };
}

function decodeParts(rows: OpenCodePartRow[], strict = false) {
  const decoded = new Map<string, DecodedParts>();
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.data);
    } catch (error) {
      if (strict) throw error;
      continue;
    }
    const result = partDataSchema.safeParse(raw);
    if (!result.success) {
      if (strict) throw result.error;
      continue;
    }
    const part = result.data;
    const current = decoded.get(row.message_id) ?? {
      activity: {
        hasText: false,
        hasReasoning: false,
        tools: [],
      },
      content: [],
    };
    if (part.type === "text" && !part.synthetic) {
      current.activity.hasText = typeof part.text === "string";
      if (typeof part.text === "string") {
        current.content.push(preview(part.text));
      }
    }
    if (part.type === "reasoning") {
      current.activity.hasReasoning = true;
      current.content.push({ kind: "reasoning" });
    }
    if (part.type === "file") {
      const image = part.mime?.startsWith("image/") === true;
      if (image) {
        current.activity.images = (current.activity.images ?? 0) + 1;
      }
      current.content.push({
        kind: image ? "image" : "file",
        mimeType: part.mime,
      });
    }
    if (part.type === "tool" && part.tool) {
      const input = serializedPreview(part.state?.input);
      const output = serializedPreview(part.state?.output);
      current.activity.tools.push({
        sourceID: part.callID,
        name: part.tool,
        status: part.state?.status ?? "unknown",
        startedAt: part.state?.time?.start,
        completedAt: part.state?.time?.end,
        childExternalID: part.state?.metadata?.sessionId,
        input,
        output,
        ...(input?.preview === undefined
          ? {}
          : { inputPreview: input.preview }),
        ...(output?.preview === undefined
          ? {}
          : { outputPreview: output.preview }),
      });
    }
    if (part.type === "compaction") {
      current.compaction = {
        sourceID: row.id,
        auto: part.auto,
        overflow: part.overflow,
        tailStartID: part.tail_start_id,
      };
    }
    decoded.set(row.message_id, current);
  }
  return decoded;
}

function openCodeCheckpointItem(
  row: OpenCodeMessageRow,
  partsByMessage: Map<string, DecodedParts>,
): CompactionCheckpointItemImport | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(row.data);
  } catch {
    return undefined;
  }
  const parsed = messageDataSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  const parts = partsByMessage.get(row.id);
  const text = parts?.content.find((item) =>
    item.kind === "text" && item.preview !== undefined
  );
  const nativeMetadata = {
    ...(parts?.activity.tools.length
      ? { toolCount: parts.activity.tools.length }
      : {}),
  };
  if (text?.preview !== undefined) {
    return {
      sourceEntryID: row.id,
      kind: "message",
      role: message.role,
      contentAvailability: "plaintext",
      contentPreview: text.preview,
      originalLength: text.originalLength,
      truncated: text.truncated ?? false,
      nativeMetadata,
    };
  }
  return referenceCheckpointItem({
    sourceEntryID: row.id,
    kind: "message",
    role: message.role,
    nativeMetadata,
  });
}

function openCodeCompactionDetails(
  markerRow: OpenCodeMessageRow,
  markerIndex: number,
  marker: NonNullable<DecodedParts["compaction"]>,
  rows: OpenCodeMessageRow[],
  partsByMessage: Map<string, DecodedParts>,
): CompactionDetailImport {
  const issues: string[] = [];
  const auto = booleanValue(marker.auto);
  const overflow = booleanValue(marker.overflow);
  if (marker.auto !== undefined && auto === undefined) {
    issues.push("auto-not-boolean");
  }
  if (marker.overflow !== undefined && overflow === undefined) {
    issues.push("overflow-not-boolean");
  }
  const tailStartID = stringValue(marker.tailStartID);
  if (marker.tailStartID !== undefined && tailStartID === undefined) {
    issues.push("tail-start-id-not-string");
  }
  let retainedValues: OpenCodeMessageRow[] | undefined;
  if (tailStartID !== undefined) {
    const tailIndex = rows.findIndex((row) => row.id === tailStartID);
    if (tailIndex >= 0 && tailIndex < markerIndex) {
      retainedValues = rows.slice(tailIndex, markerIndex);
    } else {
      issues.push("tail-start-message-missing");
    }
  }
  const retainedItems = (retainedValues ?? []).flatMap((row) => {
    const item = openCodeCheckpointItem(row, partsByMessage);
    return item === undefined ? [] : [item];
  });
  if (
    retainedValues !== undefined &&
    retainedItems.length !== retainedValues.length
  ) {
    issues.push("retained-message-unsupported");
  }
  return {
    sourceID: marker.sourceID,
    trigger: overflow === true
      ? "overflow"
      : auto === true
      ? "automatic"
      : auto === false
      ? "manual"
      : "unknown",
    resultKind: "unavailable",
    checkpointCompleteness: retainedValues === undefined
      ? "unknown"
      : "partial",
    retainedItemCount: retainedItems.length,
    droppedItemCount: retainedValues === undefined
      ? undefined
      : Math.max(0, markerIndex - retainedValues.length),
    nativeMetadata: {
      markerMessageID: markerRow.id,
      ...(tailStartID === undefined ? {} : { tailStartID }),
      ...(auto === undefined ? {} : { auto }),
      ...(overflow === undefined ? {} : { overflow }),
      ...(issues.length === 0 ? {} : { captureIssues: issues }),
    },
    checkpointItems: retainedItems,
  };
}

function completeOpenCodeCompaction(
  compaction: CompactionDetailImport,
  summaryRow: OpenCodeMessageRow,
  parts?: DecodedParts,
) {
  const summary = parts?.content.find((item) =>
    item.kind === "text" && item.preview !== undefined
  );
  const metadata = objectValue(compaction.nativeMetadata) ?? {};
  const issues = Array.isArray(metadata.captureIssues)
    ? metadata.captureIssues.filter((issue): issue is string =>
      typeof issue === "string"
    )
    : [];
  if (summary?.preview === undefined) {
    issues.push("summary-text-missing");
    compaction.checkpointCompleteness = compaction.checkpointItems.length > 0
      ? "partial"
      : "unknown";
  } else {
    compaction.resultKind = "plaintext-summary";
    const retainedContextIncomplete = issues.some((issue) =>
      issue === "tail-start-message-missing" ||
      issue === "retained-message-unsupported"
    );
    compaction.checkpointCompleteness = compaction.checkpointItems.length > 0
      ? retainedContextIncomplete ? "partial" : "complete"
      : "summary-only";
    compaction.checkpointItems.unshift({
      sourceEntryID: summaryRow.id,
      kind: "summary",
      role: "assistant",
      contentAvailability: "plaintext",
      contentPreview: summary.preview,
      originalLength: summary.originalLength,
      truncated: summary.truncated ?? false,
    });
  }
  compaction.nativeMetadata = {
    ...metadata,
    summaryMessageID: summaryRow.id,
    ...(issues.length === 0 ? {} : { captureIssues: issues }),
  };
  numberCheckpointItems(compaction);
}

function decodeMessages(
  rows: OpenCodeMessageRow[],
  partsByMessage = new Map<string, DecodedParts>(),
  strict = false,
) {
  const turns: ConversationTurnImport[] = [];
  const providers = new Set<string>();
  const models = new Set<string>();
  const tokens = emptyTokens();
  let reportedCost = 0;
  let pendingImages = 0;
  type PendingContextEvent = ConversationContextEventImport & {
    operationSeen: boolean;
    affectedCallReference?: ConversationCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];

  for (const [messageIndex, row] of rows.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.data);
    } catch (error) {
      if (strict) throw error;
      continue;
    }
    const result = messageDataSchema.safeParse(raw);
    if (!result.success) {
      const invalidTokenCount = result.error.issues.every((issue) =>
        issue.code === "too_small" && issue.path[0] === "tokens"
      );
      if (strict && !invalidTokenCount) throw result.error;
      continue;
    }
    const message = result.data;
    const explicitReasoningSetting = message.variant === undefined
      ? undefined
      : {
        settingName: "variant",
        settingValue: message.variant,
        sourceFieldPath: "message.data.variant",
        sourceOrder: messageIndex + 1,
        observedAt: row.time_created,
        provenance: "explicit" as const,
      };

    if (message.role === "user") {
      const parts = partsByMessage.get(row.id);
      if (parts?.compaction) {
        const event: PendingContextEvent = {
          type: "compaction",
          sourceOrder: messageIndex + 1,
          occurredAt: row.time_created,
          operationSeen: false,
          compaction: numberCheckpointItems(openCodeCompactionDetails(
            row,
            messageIndex,
            parts.compaction,
            rows,
            partsByMessage,
          )),
        };
        contextEvents.push(event);
        pendingContextEvents.push(event);
      }
      pendingImages = parts?.activity.images ?? 0;
      turns.push({
        number: turns.length + 1,
        startedAt: row.time_created,
        calls: [],
        inputs: parts?.content ?? [],
        reasoningSetting: explicitReasoningSetting,
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const operationEvents = pendingContextEvents.filter((event) =>
      !event.operationSeen
    );
    const compactionOperation = operationEvents.length > 0;
    for (const event of operationEvents) {
      event.operationSeen = true;
      if (event.compaction !== undefined) {
        completeOpenCodeCompaction(
          event.compaction,
          row,
          partsByMessage.get(row.id),
        );
      }
    }
    if (!message.tokens || turns.length === 0) continue;

    // session.model is mutable session metadata, not a historical record of
    // the variant used for each call. Only use variants recorded on messages;
    // otherwise a later setting change backfills earlier calls.
    const reasoningSetting = explicitReasoningSetting;
    const turn = turns.at(-1)!;
    if (turn.reasoningSetting === undefined && reasoningSetting !== undefined) {
      turn.reasoningSetting = {
        ...reasoningSetting,
        provenance: reasoningSetting.provenance === "explicit"
          ? "inherited"
          : reasoningSetting.provenance,
      };
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

    const provider = message.providerID ?? "unknown";
    const model = message.modelID ?? "unknown";
    const decodedParts = partsByMessage.get(row.id);
    const activity = decodedParts?.activity ?? {
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
    models.delete(model);
    models.add(model);
    addTokens(tokens, callTokens);
    reportedCost += cost;
    const textPreview = compactionOperation
      ? undefined
      : decodedParts?.content.find((item) => item.kind === "text")?.preview;
    const call: ConversationCallImport = {
      id: row.id,
      callWithinTurn: turn.calls.length + 1,
      ...(textPreview === undefined ? {} : { preview: textPreview }),
      provider,
      model,
      startedAt: message.time?.created ?? row.time_created,
      completedAt: message.time?.completed,
      reportedCost: cost,
      tokens: callTokens,
      reasoningSetting,
      activity,
      content: compactionOperation ? [] : decodedParts?.content ?? [],
    };
    turn.calls.push(call);
    if (!compactionOperation) {
      for (let index = pendingContextEvents.length - 1; index >= 0; index--) {
        const event = pendingContextEvents[index];
        if (!event.operationSeen) continue;
        event.affectedCallReference = call;
        pendingContextEvents.splice(index, 1);
      }
    }
  }

  const nonEmptyTurns = turns
    .filter((turn) => turn.calls.length > 0)
    .map((turn, index) => ({ ...turn, number: index + 1 }));
  const normalizedContextEvents: ConversationContextEventImport[] =
    contextEvents
      .map(
        (
          { operationSeen: _operationSeen, affectedCallReference, ...event },
        ) => {
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
    providers,
    models,
    tokens,
    reportedCost,
  };
}

function decodeUsageMessage(
  row: MessageRow,
  session: {
    id: string;
    rootID: string;
    parentID?: string;
    rootStartedAt: number;
  },
) {
  let raw: unknown;
  try {
    raw = JSON.parse(row.data);
  } catch {
    return undefined;
  }
  const result = messageDataSchema.safeParse(raw);
  if (!result.success) return undefined;
  const message = result.data;
  if (message.role !== "assistant" || !message.tokens) {
    return { role: message.role };
  }

  const source = message.tokens;
  const cacheWrite = source.cache.write > 0 ? source.cache.write : undefined;
  const tokens: TokenUsage = {
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
  const reportedCost = message.cost ?? 0;
  if (tokens.processed === 0 && reportedCost === 0) {
    return { role: message.role };
  }
  return {
    role: message.role,
    call: {
      harness: "opencode",
      session: {
        id: session.id,
        rootID: session.rootID,
        parentID: session.parentID,
      },
      cacheChainID: (row as UsageMessageRow).session_id,
      turnID: "unassigned",
      turnOrdinal: 0,
      sessionStartedAt: session.rootStartedAt,
      provider: message.providerID ?? "unknown",
      model: message.modelID ?? "unknown",
      startedAt: message.time?.created ?? row.time_created,
      reportedCost,
      tokens,
    } satisfies UsageCall,
  };
}

function fallbackModel(modelJson: string | null) {
  if (!modelJson) return undefined;
  try {
    const model = z.object({
      id: z.string(),
      providerID: z.string(),
      variant: z.string().optional(),
    }).safeParse(JSON.parse(modelJson));
    return model.success ? model.data : undefined;
  } catch {
    return undefined;
  }
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

function summaryFromDecoded(
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

export function normalizeOpenCodeSessionTree(options: {
  sessions: OpenCodeSessionRow[];
  messages: OpenCodeMessageRow[];
  parts: OpenCodePartRow[];
  sourceID: number;
  observedAt: number;
  checkpoint: ProjectionCheckpoint;
}): LinearConversationImport[] {
  const messagesBySession = Map.groupBy(
    options.messages,
    (message) => message.session_id,
  );
  const partsBySession = Map.groupBy(options.parts, (part) => part.session_id);
  return options.sessions.map((row) => {
    const sessionMessages = messagesBySession.get(row.id) ?? [];
    const decoded = decodeMessages(
      sessionMessages,
      decodeParts(partsBySession.get(row.id) ?? [], true),
      true,
    );
    const summary = summaryFromDecoded(row, decoded);
    return {
      sourceID: options.sourceID,
      externalID: row.id,
      parentExternalID: row.parent_id ?? undefined,
      artifactPath: `session:${row.id}`,
      ...(row.directory ? { workingDirectory: row.directory } : {}),
      observedAt: options.observedAt,
      checkpoint: options.checkpoint,
      session: {
        title: summary.title,
        agent: row.agent ?? undefined,
        updatedAt: summary.updatedAt,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        providers: summary.providers,
        models: summary.models,
        userTurns: summary.userTurns,
        modelCalls: summary.modelCalls,
        reportedCost: summary.reportedCost,
        tokens: summary.tokens,
        turns: decoded.turns,
        contextEvents: decoded.contextEvents,
      },
    };
  });
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

  listUsageCalls(startedAt?: number) {
    const sessionRows = this.#db.prepare(`
      SELECT id, parent_id, time_created
      FROM session
    `).all() as UsageSessionRow[];
    const rowsByID = new Map(sessionRows.map((row) => [row.id, row]));
    const sessionRoots = new Map<
      string,
      { id: string; rootID: string; parentID?: string; rootStartedAt: number }
    >();
    for (const row of sessionRows) {
      let root = row;
      const visited = new Set([row.id]);
      while (root.parent_id && !visited.has(root.parent_id)) {
        const parent = rowsByID.get(root.parent_id);
        if (!parent) break;
        root = parent;
        visited.add(root.id);
      }
      sessionRoots.set(row.id, {
        id: row.id,
        rootID: root.id,
        parentID: row.parent_id ?? undefined,
        rootStartedAt: root.time_created,
      });
    }
    const imageRows = this.#db.prepare(`
      SELECT message_id, COUNT(*) AS count
      FROM part
      WHERE json_valid(data)
        AND json_extract(data, '$.type') = 'file'
        AND json_extract(data, '$.mime') LIKE 'image/%'
      GROUP BY message_id
    `).all() as Array<{ message_id: string; count: number }>;
    const imagesByMessage = new Map(
      imageRows.map((row) => [row.message_id, row.count]),
    );
    const sessionsWithUserTurn = new Set<string>();
    const activeTurnIDs = new Map<string, string>();
    const activeTurnOrdinals = new Map<string, number>();
    const pendingTurnImages = new Map<string, number>();
    if (startedAt !== undefined) {
      const priorSessions = this.#db.prepare(`
        SELECT id, session_id
        FROM message
        WHERE time_created < ?
          AND json_valid(data)
          AND json_extract(data, '$.role') = 'user'
        ORDER BY time_created, id
      `).all(startedAt) as Array<{ id: string; session_id: string }>;
      priorSessions.forEach(({ id, session_id }) => {
        sessionsWithUserTurn.add(session_id);
        activeTurnIDs.set(session_id, id);
        activeTurnOrdinals.set(
          session_id,
          (activeTurnOrdinals.get(session_id) ?? 0) + 1,
        );
        pendingTurnImages.set(session_id, imagesByMessage.get(id) ?? 0);
      });
    }
    const rows = startedAt === undefined
      ? this.#db.prepare(`
        SELECT id, session_id, time_created, data
        FROM message
        ORDER BY time_created, id
      `).all() as UsageMessageRow[]
      : this.#db.prepare(`
        SELECT id, session_id, time_created, data
        FROM message
        WHERE time_created >= ?
        ORDER BY time_created, id
      `).all(startedAt) as UsageMessageRow[];
    const calls: UsageCall[] = [];
    for (const row of rows) {
      const session = sessionRoots.get(row.session_id);
      if (!session) continue;
      const decoded = decodeUsageMessage(row, session);
      if (!decoded) continue;
      if (decoded.role === "user") {
        sessionsWithUserTurn.add(row.session_id);
        activeTurnIDs.set(row.session_id, row.id);
        activeTurnOrdinals.set(
          row.session_id,
          (activeTurnOrdinals.get(row.session_id) ?? 0) + 1,
        );
        pendingTurnImages.set(
          row.session_id,
          imagesByMessage.get(row.id) ?? 0,
        );
        continue;
      }
      if (decoded.call && sessionsWithUserTurn.has(row.session_id)) {
        const images = pendingTurnImages.get(row.session_id) ?? 0;
        calls.push({
          ...decoded.call,
          turnID: `${row.session_id}:${
            activeTurnIDs.get(row.session_id) ?? "prior"
          }`,
          turnOrdinal: activeTurnOrdinals.get(row.session_id) ?? 0,
          ...(images > 0 ? { images } : {}),
        });
        pendingTurnImages.set(row.session_id, 0);
      }
    }
    return calls;
  }

  #summary(row: SessionRow): SessionSummary {
    return this.#toSummary(row, this.#decodeSession(row));
  }

  #detail(row: SessionRow, visited: Set<string>): unknown {
    visited.add(row.id);
    const decoded = this.#decodeSession(row, true);
    const children = this.#db.prepare(`
      SELECT id, parent_id, title, model, agent, time_updated
      FROM session
      WHERE parent_id = ?
      ORDER BY time_created, id
    `).all(row.id) as SessionRow[];
    const turns = decoded.turns.map((turn) => ({
      ...turn,
      calls: turn.calls.map((call) => ({
        ...call,
        contextEventsBefore: decoded.contextEvents.filter((event) =>
          event.affectedCall?.turn === turn.number &&
          event.affectedCall.call === call.callWithinTurn
        ).map(({ affectedCall: _affectedCall, ...event }) => event),
      })),
    }));
    return {
      ...this.#toSummary(row, decoded),
      parentID: row.parent_id ?? undefined,
      agent: row.agent ?? undefined,
      turns,
      contextEvents: decoded.contextEvents.filter((event) =>
        event.affectedCall === undefined
      ),
      subagents: children
        .filter((child) => !visited.has(child.id))
        .map((child) => this.#detail(child, new Set(visited))),
    };
  }

  #decodeSession(row: SessionRow, includeActivity = false) {
    const messages = this.#db.prepare(`
      SELECT id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(row.id) as MessageRow[];
    if (!includeActivity) {
      return decodeMessages(messages, undefined, false);
    }
    const parts = this.#db.prepare(`
      SELECT message_id, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(row.id) as PartRow[];
    return decodeMessages(
      messages,
      decodeParts(parts),
      false,
    );
  }

  #toSummary(
    row: SessionRow,
    decoded: ReturnType<typeof decodeMessages>,
  ): SessionSummary {
    return summaryFromDecoded(row, decoded);
  }
}
