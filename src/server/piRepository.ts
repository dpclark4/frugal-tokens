import { z } from "zod";
import {
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { usageCallsFromSession } from "./usage.ts";
import type {
  CompactionDetailImport,
  ConversationCallImport,
  ConversationContentImport,
  ConversationContextEventImport,
  ConversationToolImport,
  ConversationTurnImport,
  ReasoningSettingImport,
} from "./conversationImportTypes.ts";
import {
  booleanValue,
  messageCheckpointItem,
  nonnegativeInteger,
  numberCheckpointItems,
  objectValue,
  stringValue,
  textCheckpointItem,
} from "./compactionImport.ts";

const contentPreviewLimit = 2_048;

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
  thinkingLevel: z.string().optional(),
  parentId: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  summary: z.unknown().optional(),
  firstKeptEntryId: z.unknown().optional(),
  retainedTail: z.unknown().optional(),
  tokensBefore: z.unknown().optional(),
  fromHook: z.unknown().optional(),
  details: z.unknown().optional(),
  usage: z.unknown().optional(),
  message: z.object({
    role: z.string().optional(),
    content: z.array(contentBlockSchema).optional(),
    api: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    stopReason: z.string().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    timestamp: z.number().optional(),
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

function preview(value: string): ConversationContentImport {
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
): ConversationContentImport[] {
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

function piEntryCheckpointItem(value: unknown) {
  const entry = objectValue(value);
  if (entry === undefined) return undefined;
  const sourceEntryID = stringValue(entry.id);
  if (entry.type === "message") {
    const message = objectValue(entry.message);
    if (message === undefined) return undefined;
    return messageCheckpointItem({
      sourceEntryID,
      role: stringValue(message.role),
      content: message.content,
    });
  }
  // retainedTail stores materialized messages rather than session entries.
  if (typeof entry.role === "string") {
    return messageCheckpointItem({
      sourceEntryID,
      role: entry.role,
      content: entry.content,
    });
  }
  if (entry.type === "custom_message") {
    return messageCheckpointItem({
      sourceEntryID,
      role: "user",
      content: entry.content,
      nativeMetadata: {
        ...(typeof entry.customType === "string"
          ? { customType: entry.customType }
          : {}),
      },
    });
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return textCheckpointItem({
      sourceEntryID,
      kind: "message",
      role: "user",
      text: entry.summary,
      nativeMetadata: { sourceKind: "branch-summary" },
    });
  }
  return undefined;
}

function piCompactionDetails(
  record: Record,
  records: Record[],
): CompactionDetailImport {
  const issues: string[] = [];
  const summary = stringValue(record.summary);
  if (record.summary !== undefined && summary === undefined) {
    issues.push("summary-not-string");
  }
  const tokensBefore = nonnegativeInteger(record.tokensBefore);
  if (record.tokensBefore !== undefined && tokensBefore === undefined) {
    issues.push("tokens-before-invalid");
  }

  const byID = new Map(
    records.flatMap((entry) =>
      entry.id === undefined ? [] : [[entry.id, entry] as const]
    ),
  );
  const branch: Record[] = [];
  const visited = new Set<string>();
  let currentID = record.parentId ?? undefined;
  while (currentID !== undefined && currentID !== null) {
    if (visited.has(currentID)) {
      issues.push("parent-cycle");
      break;
    }
    visited.add(currentID);
    const entry = byID.get(currentID);
    if (entry === undefined) {
      issues.push("parent-entry-missing");
      break;
    }
    branch.push(entry);
    currentID = entry.parentId ?? undefined;
  }
  branch.reverse();

  let retainedValues: unknown[] | undefined;
  let droppedItemCount: number | undefined;
  let boundaryKind = "unknown";
  if (Array.isArray(record.retainedTail)) {
    retainedValues = record.retainedTail;
    boundaryKind = "retained-tail";
  } else {
    if (record.retainedTail !== undefined) {
      issues.push("retained-tail-not-array");
    }
    const firstKeptEntryID = stringValue(record.firstKeptEntryId);
    if (
      record.firstKeptEntryId !== undefined && firstKeptEntryID === undefined
    ) {
      issues.push("first-kept-entry-id-not-string");
    }
    if (firstKeptEntryID !== undefined) {
      const firstKeptIndex = branch.findIndex((entry) =>
        entry.id === firstKeptEntryID
      );
      if (firstKeptIndex >= 0) {
        retainedValues = branch.slice(firstKeptIndex);
        droppedItemCount = firstKeptIndex;
        boundaryKind = "first-kept-entry";
      } else {
        issues.push("first-kept-entry-missing");
      }
    }
  }

  const retainedItems = (retainedValues ?? []).flatMap((entry) => {
    const item = piEntryCheckpointItem(entry);
    return item === undefined ? [] : [item];
  });
  if (
    retainedValues !== undefined &&
    retainedItems.length !== retainedValues.length
  ) {
    issues.push("retained-entry-unsupported");
  }
  const checkpointItems = [
    ...(summary === undefined ? [] : [textCheckpointItem({
      sourceEntryID: record.id,
      kind: "summary",
      role: "user",
      text: summary,
    })]),
    ...retainedItems,
  ];
  const resultKind = summary === undefined
    ? "unavailable" as const
    : "plaintext-summary" as const;
  const checkpointCompleteness = retainedValues !== undefined
    ? summary === undefined ? "partial" as const : "complete" as const
    : summary === undefined
    ? "unknown" as const
    : "summary-only" as const;
  const usage = objectValue(record.usage);
  const fromHook = booleanValue(record.fromHook);
  return {
    sourceID: record.id,
    trigger: "unknown",
    resultKind,
    checkpointCompleteness,
    preContextTokens: tokensBefore,
    retainedItemCount: retainedItems.length,
    droppedItemCount,
    nativeMetadata: {
      boundaryKind,
      ...(stringValue(record.firstKeptEntryId) === undefined
        ? {}
        : { firstKeptEntryID: record.firstKeptEntryId }),
      ...(Array.isArray(record.retainedTail)
        ? { retainedTailCount: record.retainedTail.length }
        : {}),
      ...(fromHook === undefined ? {} : { fromHook }),
      ...(usage === undefined ? {} : { summaryUsage: usage }),
      ...(issues.length === 0 ? {} : { captureIssues: issues }),
    },
    checkpointItems,
  };
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
  const turns: Array<ConversationTurnImport & { images?: number }> = [];
  const tokens = emptyTokens();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Map<string, ConversationToolImport>();
  let reportedCost = 0;
  type PendingContextEvent = ConversationContextEventImport & {
    affectedCallReference?: ConversationCallImport;
  };
  const contextEvents: PendingContextEvent[] = [];
  const pendingContextEvents: PendingContextEvent[] = [];
  type ReasoningSettingState = Omit<ReasoningSettingImport, "provenance">;
  // Pi can persist a thinking-level change while an assistant response is in
  // flight. The response record is written only after it completes, so JSONL
  // order can put the change before the call it occurred during. Associate a
  // timestamped change with calls by start time, using source order only when
  // timestamps are unavailable.
  const reasoningChanges: ReasoningSettingState[] = records.flatMap(
    (record, recordIndex) => {
      const timestamp = Date.parse(record.timestamp ?? "") || 0;
      if (
        record.type !== "thinking_level_change" ||
        record.thinkingLevel === undefined
      ) return [];
      return [{
        settingName: "thinkingLevel",
        settingValue: record.thinkingLevel,
        sourceFieldPath: "thinkingLevel",
        sourceOrder: recordIndex + 1,
        ...(timestamp === 0 ? {} : { observedAt: timestamp }),
      }];
    },
  );
  const reasoningSettingAt = (
    timestamp: number,
    sourceOrder: number,
  ): ReasoningSettingState | undefined => {
    let setting: ReasoningSettingState | undefined;
    for (const change of reasoningChanges) {
      const applies = change.observedAt !== undefined && timestamp > 0
        ? change.observedAt <= timestamp
        : (change.sourceOrder ?? 0) < sourceOrder;
      if (applies) setting = change;
    }
    return setting;
  };

  for (const [recordIndex, record] of records.entries()) {
    const timestamp = Date.parse(record.timestamp ?? "") || 0;
    if (
      record.type === "thinking_level_change" &&
      record.thinkingLevel !== undefined
    ) {
      continue;
    }
    if (record.type === "compaction") {
      const event: PendingContextEvent = {
        type: "compaction",
        sourceOrder: recordIndex + 1,
        ...(timestamp === 0 ? {} : { occurredAt: timestamp }),
        compaction: numberCheckpointItems(
          piCompactionDetails(record, records),
        ),
      };
      contextEvents.push(event);
      pendingContextEvents.push(event);
      continue;
    }
    const message = record.message;
    if (record.type !== "message" || !message?.role) continue;
    const messageTimestamp = message.timestamp ?? timestamp;

    if (message.role === "user") {
      const text = userText(record);
      if (text?.trim()) {
        const reasoningSetting = reasoningSettingAt(
          messageTimestamp,
          recordIndex + 1,
        );
        turns.push({
          number: turns.length + 1,
          startedAt: messageTimestamp,
          calls: [],
          inputs: contentMetadata(record.message?.content ?? []),
          ...(reasoningSetting === undefined ? {} : {
            reasoningSetting: {
              ...reasoningSetting,
              provenance: "inherited" as const,
            },
          }),
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
      // Pi's output includes provider-reported reasoning tokens. Split them so
      // the shared pricing formula (output + reasoning) bills them once.
      output: Math.max(0, source.output - source.reasoning),
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
    const reasoningSetting = reasoningSettingAt(
      messageTimestamp,
      recordIndex + 1,
    );
    const call: ConversationCallImport = {
      id: record.id ?? `${turn.number}-${turn.calls.length + 1}`,
      callWithinTurn: turn.calls.length + 1,
      ...(content.find((item) => item.kind === "text")?.preview === undefined
        ? {}
        : {
          preview: content.find((item) => item.kind === "text")!.preview,
        }),
      provider,
      model,
      startedAt: messageTimestamp,
      completedAt: timestamp,
      reportedCost: cost,
      tokens: callTokens,
      ...(reasoningSetting === undefined ? {} : {
        reasoningSetting: {
          ...reasoningSetting,
          provenance: "inherited" as const,
        },
      }),
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
    if (project.isFile && project.name.endsWith(".jsonl")) {
      const path = `${directory}/${project.name}`;
      const stat = Deno.statSync(path);
      files.push({
        id: project.name.slice(0, -6),
        path,
        artifactPath: project.name,
        updatedAt: stat.mtime?.getTime() ?? 0,
        size: stat.size,
      });
      continue;
    }
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
  const sessionInfo = [...records].reverse().find((record) =>
    record.type === "session_info"
  );
  const customTitle = typeof sessionInfo?.name === "string"
    ? sessionInfo.name.trim() || undefined
    : undefined;
  const title = customTitle ?? promptTitle ??
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

function sessionWorkingDirectory(records: Record[]) {
  return records.find((record) => record.type === "session" && record.cwd)
    ?.cwd ?? records.find((record) => record.cwd)?.cwd;
}

export function normalizePiSession(
  candidate: PiSessionCandidate,
  text: string,
) {
  const records = readRecordsFromText(text, true);
  const normalized = piSession(records, candidate.id, candidate.updatedAt);
  const workingDirectory = sessionWorkingDirectory(records);
  return workingDirectory === undefined
    ? normalized
    : { ...normalized, workingDirectory };
}
