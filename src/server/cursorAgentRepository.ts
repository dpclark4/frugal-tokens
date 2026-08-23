import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import {
  type JsonObject,
  jsonObjectSchema,
  type JsonValue,
} from "../shared/json.ts";
import type { TokenUsage } from "../shared/sessionSchemas.ts";
import type {
  ConversationCallImport,
  ConversationContentImport,
  ConversationToolImport,
  LinearConversationImport,
} from "./conversationImportTypes.ts";
import {
  artifactImportFailure,
  type ProjectionCheckpoint,
  SourceArtifactRepository,
} from "./sourceArtifactRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

const contentPreviewLimit = 2_048;
const projectionName = "conversation";

export const cursorParserVersion = "cursor-conversation-1";

type CursorFileMeta = {
  schemaVersion?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  hasConversation?: boolean;
  cwd?: string;
};

type CursorSubagentInfo = {
  parentAgentId?: string;
  rootParentAgentId?: string;
  toolCallId?: string;
  typeName?: string;
};

type CursorStoreMeta = {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
  subagentInfo?: CursorSubagentInfo;
};

type CursorMessage = JsonObject;

type CursorSnapshot = {
  storeMeta: CursorStoreMeta;
  fileMeta: CursorFileMeta;
  rootBlobId: string;
  messages: CursorMessage[];
};

const cursorStoreValueSchema = z.union([
  z.string(),
  z.number(),
  z.bigint(),
  z.instanceof(Uint8Array),
  z.null(),
]);
type CursorStoreValue = z.infer<typeof cursorStoreValueSchema>;

const cursorMetaRowSchema = z.object({
  key: cursorStoreValueSchema,
  value: cursorStoreValueSchema,
});

const cursorBlobRowSchema = z.object({
  id: z.union([z.string(), z.instanceof(Uint8Array)]),
  data: z.instanceof(Uint8Array),
});

type CursorUsageRecord = {
  requestId: string;
  flowId?: string;
  usageSequence?: number;
  reportedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCost?: number;
  model?: string;
  capturedAt?: number;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};

export type CursorCaptureIndex = {
  path?: string;
  revision: string;
  records: Map<string, CursorUsageRecord>;
  malformedLines: number;
};

export type CursorAgentCandidate = {
  id: string;
  storePath: string;
  artifactPath: string;
  metaPath: string;
  updatedAt: number;
  sourceModifiedAt: number;
  size: number;
  changeHint: string;
  parentExternalID?: string;
  fileMeta: CursorFileMeta;
  storeMeta: CursorStoreMeta;
};

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function digestJson(serialized: string) {
  return createHash("sha256").update(serialized).digest("hex");
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function asBytes(value: CursorStoreValue | undefined): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function asBlobID(value: CursorStoreValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  const bytes = asBytes(value);
  return bytes === undefined ? undefined : bytesToHex(bytes);
}

function epochMilliseconds(
  value: JsonValue | undefined,
): number | undefined {
  const number = numberValue(value);
  if (number === undefined) return undefined;
  return number < 100_000_000_000
    ? Math.round(number * 1_000)
    : Math.round(number);
}

function readJSONFile(path: string): JsonObject | undefined {
  try {
    const parsed = jsonObjectSchema.safeParse(
      JSON.parse(Deno.readTextFileSync(path)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function fileMeta(path: string): CursorFileMeta {
  const value = readJSONFile(path);
  return {
    schemaVersion: integerValue(value?.schemaVersion),
    createdAtMs: integerValue(value?.createdAtMs),
    updatedAtMs: integerValue(value?.updatedAtMs),
    hasConversation: typeof value?.hasConversation === "boolean"
      ? value.hasConversation
      : undefined,
    cwd: stringValue(value?.cwd),
  };
}

function decodeHexJSON(
  value: CursorStoreValue | undefined,
): JsonObject | undefined {
  let text: string | undefined;
  if (typeof value === "string") {
    const raw = value.trim();
    if (/^(?:[0-9a-f]{2})+$/i.test(raw)) {
      try {
        text = new TextDecoder().decode(
          Uint8Array.from(raw.match(/../g)!, (pair) => parseInt(pair, 16)),
        );
      } catch {
        return undefined;
      }
    } else {
      text = raw;
    }
  } else {
    const bytes = asBytes(value);
    if (bytes !== undefined) text = new TextDecoder().decode(bytes);
  }
  if (text === undefined) return undefined;
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readStoreMeta(db: DatabaseSync): CursorStoreMeta {
  const rows = z.array(cursorMetaRowSchema).parse(
    db.prepare("SELECT key, value FROM meta").all(),
  );
  const row = rows.find((item) => String(item.key) === "0");
  const value = decodeHexJSON(row?.value);
  if (value === undefined) {
    throw new Error("Cursor store metadata is unavailable");
  }

  const subagent = objectValue(value.subagentInfo);
  return {
    agentId: stringValue(value.agentId),
    latestRootBlobId: stringValue(value.latestRootBlobId),
    name: stringValue(value.name),
    mode: stringValue(value.mode),
    createdAt: epochMilliseconds(value.createdAt),
    lastUsedModel: stringValue(value.lastUsedModel),
    subagentInfo: subagent === undefined ? undefined : {
      parentAgentId: stringValue(subagent.parentAgentId),
      rootParentAgentId: stringValue(subagent.rootParentAgentId),
      toolCallId: stringValue(subagent.toolCallId),
      typeName: stringValue(subagent.typeName),
    },
  };
}

function readStoreMetaFromPath(path: string): CursorStoreMeta | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return readStoreMeta(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function stat(path: string) {
  try {
    const value = Deno.statSync(path);
    return {
      size: value.size,
      modifiedAt: value.mtime?.getTime() ?? 0,
    };
  } catch {
    return { size: 0, modifiedAt: 0 };
  }
}

function candidateStats(storePath: string, metaPath: string) {
  const paths = [storePath, `${storePath}-wal`, `${storePath}-shm`, metaPath];
  const values = paths.map(stat);
  return {
    size: values.reduce((total, value) => total + value.size, 0),
    modifiedAt: values.reduce(
      (latest, value) => Math.max(latest, value.modifiedAt),
      0,
    ),
    files: values,
  };
}

export function readCursorCapture(path?: string): CursorCaptureIndex {
  if (path === undefined) {
    return { revision: "missing", records: new Map(), malformedLines: 0 };
  }

  let text: string;
  let revision: string;
  try {
    const bytes = Deno.readFileSync(path);
    text = new TextDecoder().decode(bytes);
    revision = createHash("sha256").update(bytes).digest("hex");
  } catch {
    return { path, revision: "missing", records: new Map(), malformedLines: 0 };
  }

  const records = new Map<string, CursorUsageRecord>();
  const timings = new Map<string, {
    startedAt?: number;
    endedAt?: number;
    elapsedMs?: number;
  }>();
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let object: JsonObject;
    try {
      object = jsonObjectSchema.parse(JSON.parse(line));
    } catch {
      // A partial final JSONL line is expected while mitmproxy is writing.
      malformedLines++;
      continue;
    }
    const flowID = stringValue(object.flowId);
    if (flowID !== undefined && object.kind === "response-start") {
      const timing = timings.get(flowID) ?? {};
      timing.startedAt = epochMilliseconds(object.startedAt) ??
        timing.startedAt;
      timings.set(flowID, timing);
      continue;
    }
    if (flowID !== undefined && object.kind === "response-end") {
      const timing = timings.get(flowID) ?? {};
      timing.endedAt = epochMilliseconds(object.endedAt) ??
        timing.endedAt;
      timing.elapsedMs = numberValue(object.elapsedMs) ?? timing.elapsedMs;
      timings.set(flowID, timing);
      continue;
    }
    if (object.kind !== "usage") continue;
    const requestID = stringValue(object.requestId);
    if (requestID === undefined) continue;

    const nestedTokens = objectValue(object.tokens);
    const readInteger = (...keys: string[]) => {
      for (const key of keys) {
        const direct = integerValue(object[key]);
        if (direct !== undefined) return direct;
        const nested = integerValue(nestedTokens?.[key]);
        if (nested !== undefined) return nested;
      }
      return 0;
    };
    const request = objectValue(object.request);
    const modelDetails = objectValue(request?.modelDetails);
    const requestedModel = objectValue(request?.requestedModel);
    const record: CursorUsageRecord = {
      requestId: requestID,
      flowId: stringValue(object.flowId),
      usageSequence: integerValue(object.usageSequence),
      reportedInputTokens: readInteger("reportedInputTokens", "inputTokens"),
      inputTokens: readInteger("inputTokens", "uncachedInput"),
      outputTokens: readInteger("outputTokens", "output"),
      cacheReadTokens: readInteger("cacheReadTokens", "cacheRead"),
      cacheWriteTokens: readInteger("cacheWriteTokens", "cacheWrite"),
      reasoningTokens: readInteger("reasoningTokens", "reasoning"),
      reportedCost: numberValue(object.reportedCost) ??
        numberValue(object.reportedCostUsd),
      model: stringValue(object.model) ??
        stringValue(object.modelName) ??
        stringValue(modelDetails?.modelId) ??
        stringValue(modelDetails?.displayModelId) ??
        stringValue(requestedModel?.modelId) ??
        stringValue(requestedModel?.displayModelId) ??
        stringValue(request?.devRawModelSlug),
      capturedAt: epochMilliseconds(object.capturedAt),
      startedAt: epochMilliseconds(object.startedAt),
      endedAt: epochMilliseconds(object.endedAt),
      elapsedMs: numberValue(object.elapsedMs),
    };
    const previous = records.get(requestID);
    const previousOrder = [
      previous?.usageSequence ?? -1,
      previous?.capturedAt ?? 0,
    ];
    const currentOrder = [record.usageSequence ?? -1, record.capturedAt ?? 0];
    if (
      previous === undefined || currentOrder[0] > previousOrder[0] ||
      (currentOrder[0] === previousOrder[0] &&
        currentOrder[1] >= previousOrder[1])
    ) records.set(requestID, record);
  }

  for (const record of records.values()) {
    const timing = record.flowId === undefined
      ? undefined
      : timings.get(record.flowId);
    if (timing === undefined) continue;
    record.startedAt ??= timing.startedAt;
    record.endedAt ??= timing.endedAt;
    record.elapsedMs ??= timing.elapsedMs;
  }

  return { path, revision, records, malformedLines };
}

function readVarint(data: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
    if (shift > 49) throw new Error("Cursor protobuf varint is too long");
  }
  throw new Error("Truncated Cursor protobuf varint");
}

function blobReferences(data: Uint8Array) {
  const references: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [key, afterKey] = readVarint(data, offset);
    offset = afterKey;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field <= 0) throw new Error("Invalid Cursor protobuf field");
    if (wire === 0) {
      [, offset] = readVarint(data, offset);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(data, offset);
      offset = afterLength;
      if (offset + length > data.length) {
        throw new Error("Truncated Cursor protobuf bytes field");
      }
      if (field === 1 && length === 32) {
        references.push(bytesToHex(data.slice(offset, offset + length)));
      }
      offset += length;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new Error(`Unsupported Cursor protobuf wire type ${wire}`);
    }
    if (offset > data.length) {
      throw new Error("Truncated Cursor protobuf field");
    }
  }
  return references;
}

function blobJSON(data: Uint8Array): CursorMessage | undefined {
  try {
    const parsed = jsonObjectSchema.safeParse(
      JSON.parse(new TextDecoder().decode(data)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readBlobRows(db: DatabaseSync, IDs: string[]) {
  if (IDs.length === 0) return new Map<string, Uint8Array>();
  const rows = z.array(cursorBlobRowSchema).parse(
    db.prepare(`
    SELECT id, data FROM blobs WHERE id IN (${IDs.map(() => "?").join(",")})
  `).all(...IDs),
  );
  const result = new Map<string, Uint8Array>();
  for (const row of rows) {
    const id = asBlobID(row.id);
    const data = asBytes(row.data);
    if (id !== undefined && data !== undefined) result.set(id, data);
  }
  return result;
}

function readAllBlobRows(db: DatabaseSync) {
  const rows = z.array(cursorBlobRowSchema).parse(
    db.prepare("SELECT id, data FROM blobs").all(),
  );
  return new Map(
    rows.flatMap((row) => {
      const id = asBlobID(row.id);
      const data = asBytes(row.data);
      return id !== undefined && data !== undefined ? [[id, data]] : [];
    }),
  );
}

function readCursorSnapshot(
  candidate: CursorAgentCandidate,
): CursorSnapshot {
  const db = new DatabaseSync(candidate.storePath, { readOnly: true });
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN");
    transaction = true;
    const storeMeta = readStoreMeta(db);
    const rootBlobId = storeMeta.latestRootBlobId;
    if (rootBlobId === undefined) {
      throw new Error("Cursor store has no latest root blob");
    }
    let rootRows = readBlobRows(db, [rootBlobId]);
    let root = rootRows.get(rootBlobId);
    if (root === undefined) {
      rootRows = readAllBlobRows(db);
      root = rootRows.get(rootBlobId);
    }
    if (root === undefined) throw new Error("Cursor root blob is unavailable");
    const references = blobReferences(root);
    let blobs = readBlobRows(db, references);
    if (blobs.size !== new Set(references).size) {
      // Older stores may use BLOB IDs rather than text IDs. This fallback is
      // intentionally limited to stores whose reference lookup was incomplete.
      blobs = readAllBlobRows(db);
    }
    const messages = references.flatMap((reference) => {
      const message = blobJSON(blobs.get(reference) ?? new Uint8Array());
      return message === undefined ? [] : [message];
    });
    db.exec("COMMIT");
    transaction = false;
    return {
      storeMeta,
      fileMeta: candidate.fileMeta,
      rootBlobId,
      messages,
    };
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}

export function discoverCursorSessions(
  directory: string,
  captureRevision = "missing",
): CursorAgentCandidate[] {
  const candidates: CursorAgentCandidate[] = [];
  let workspaces: Deno.DirEntry[];
  try {
    workspaces = [...Deno.readDirSync(directory)];
  } catch {
    return [];
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory) continue;
    const workspacePath = join(directory, workspace.name);
    let agents: Deno.DirEntry[];
    try {
      agents = [...Deno.readDirSync(workspacePath)];
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory) continue;
      const agentPath = join(workspacePath, agent.name);
      const storePath = join(agentPath, "store.db");
      const metaPath = join(agentPath, "meta.json");
      const storeStats = stat(storePath);
      if (storeStats.size === 0) continue;
      const metadata = fileMeta(metaPath);
      if (metadata.hasConversation === false) continue;
      const storeMeta = readStoreMetaFromPath(storePath) ?? {};
      const id = storeMeta.agentId ?? agent.name;
      const stats = candidateStats(storePath, metaPath);
      const updatedAt = metadata.updatedAtMs ?? storeMeta.createdAt ??
        stats.modifiedAt;
      candidates.push({
        id,
        storePath,
        artifactPath: storePath,
        metaPath,
        updatedAt,
        sourceModifiedAt: stats.modifiedAt,
        size: stats.size,
        changeHint: digestJson(JSON.stringify({
          id,
          rootBlobId: storeMeta.latestRootBlobId,
          fileMeta: metadata,
          storeStats: stats.files,
          captureRevision,
        })),
        parentExternalID: storeMeta.subagentInfo?.parentAgentId,
        fileMeta: metadata,
        storeMeta,
      });
    }
  }
  return candidates.toSorted((a, b) =>
    b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  );
}

function preview(text: string): ConversationContentImport {
  return {
    kind: "text",
    preview: text.slice(0, contentPreviewLimit),
    originalLength: text.length,
    truncated: text.length > contentPreviewLimit,
  };
}

function serializedPreview(value: JsonValue | undefined) {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? undefined : preview(text);
}

function contentBlocks(message: CursorMessage) {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = objectValue(value);
    return block === undefined ? [] : [block];
  });
}

function textBlocks(message: CursorMessage) {
  return contentBlocks(message).flatMap((block) => {
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
}

function messageText(message: CursorMessage) {
  const text = textBlocks(message).join("");
  return text.length === 0 ? undefined : text;
}

function messageInputs(message: CursorMessage): ConversationContentImport[] {
  return contentBlocks(message).flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return [preview(block.text)];
    }
    if (
      typeof block.type === "string" &&
      block.type.toLowerCase().includes("image")
    ) {
      return [{
        kind: "image",
        mimeType: stringValue(block.mimeType),
      }];
    }
    return [];
  });
}

function blockProviderModel(block: JsonObject) {
  const providerOptions = objectValue(block.providerOptions);
  const cursor = objectValue(providerOptions?.cursor);
  return stringValue(cursor?.modelName);
}

function messageModels(message: CursorMessage) {
  return contentBlocks(message).flatMap((block) => {
    const model = blockProviderModel(block);
    return model === undefined ? [] : [model];
  });
}

function isReasoningBlock(block: JsonObject) {
  const type = stringValue(block.type)?.toLowerCase();
  return type === "reasoning" || type === "thinking" ||
    type === "redacted-reasoning";
}

function conciseTitle(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= 96
    ? normalized
    : `${normalized.slice(0, 95).trimEnd()}…`;
}

function tokenUsage(record: CursorUsageRecord): TokenUsage {
  const cacheRead = record.cacheReadTokens;
  const uncachedInput = Math.max(
    0,
    record.inputTokens || record.reportedInputTokens - cacheRead,
  );
  const cacheWrite = record.cacheWriteTokens > 0
    ? record.cacheWriteTokens
    : undefined;
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    freshPrompt: uncachedInput + (cacheWrite ?? 0),
    output: record.outputTokens,
    reasoning: record.reasoningTokens,
    processed: uncachedInput + cacheRead + (cacheWrite ?? 0) +
      record.outputTokens + record.reasoningTokens,
  };
}

function addTokens(total: TokenUsage, value: TokenUsage) {
  total.uncachedInput += value.uncachedInput;
  total.cacheRead += value.cacheRead;
  total.freshPrompt += value.freshPrompt;
  total.output += value.output;
  total.reasoning += value.reasoning;
  total.processed += value.processed;
  if (value.cacheWrite !== undefined) {
    total.cacheWrite = (total.cacheWrite ?? 0) + value.cacheWrite;
  }
}

function emptyTokens(): TokenUsage {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: undefined,
    freshPrompt: 0,
    output: 0,
    reasoning: 0,
    processed: 0,
  };
}

function requestID(message: CursorMessage) {
  const providerOptions = objectValue(message.providerOptions);
  const cursor = objectValue(providerOptions?.cursor);
  return stringValue(cursor?.requestId);
}

function toolEvents(
  messages: CursorMessage[],
  childByToolCallID: Map<string, string>,
) {
  const tools = new Map<string, ConversationToolImport>();
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      const type = stringValue(block.type);
      if (type === "tool-call" || type === "tool-use") {
        const id = stringValue(block.toolCallId) ??
          `${type}:${tools.size + 1}`;
        tools.set(id, {
          sourceID: id,
          name: stringValue(block.toolName) ?? "tool",
          status: "started",
          childExternalID: childByToolCallID.get(id),
          input: serializedPreview(block.args),
        });
      } else if (type === "tool-result") {
        const id = stringValue(block.toolCallId);
        if (id === undefined) continue;
        const existing = tools.get(id) ?? {
          sourceID: id,
          name: stringValue(block.toolName) ?? "tool",
          status: "started",
          childExternalID: childByToolCallID.get(id),
        };
        const providerOptions = objectValue(message.providerOptions);
        const cursor = objectValue(providerOptions?.cursor);
        const highLevelResult = objectValue(cursor?.highLevelToolCallResult);
        const isError = highLevelResult?.isError === true;
        tools.set(id, {
          ...existing,
          name: existing.name === "tool"
            ? stringValue(block.toolName) ?? existing.name
            : existing.name,
          status: isError ? "error" : "completed",
          output: serializedPreview(block.result),
        });
      }
    }
  }
  return [...tools.values()];
}

function callForRequest(options: {
  request: CursorMessage;
  requestId: string;
  segment: CursorMessage[];
  usage?: CursorUsageRecord;
  fallbackAt: number;
  childByToolCallID: Map<string, string>;
}): ConversationCallImport {
  const assistantMessages = options.segment.filter((message) =>
    message.role === "assistant"
  );
  const models = assistantMessages.flatMap(messageModels);
  // `lastUsedModel` is session-level state, not a per-turn value. Falling
  // back to it would relabel earlier calls after the user switches models.
  const model = models.at(-1) ?? options.usage?.model ?? "unknown";
  const responseText = assistantMessages.flatMap(textBlocks).join("");
  const hasReasoning = assistantMessages.some((message) =>
    contentBlocks(message).some(isReasoningBlock)
  );
  const tools = toolEvents(options.segment, options.childByToolCallID);
  const images =
    messageInputs(options.request).filter((item) => item.kind === "image")
      .length;
  const usageEnd = options.usage?.endedAt ?? options.usage?.capturedAt ??
    options.fallbackAt;
  const startedAt = options.usage?.startedAt ??
    (options.usage?.elapsedMs === undefined
      ? options.fallbackAt
      : usageEnd - options.usage.elapsedMs);
  const completedAt = options.usage === undefined
    ? undefined
    : options.usage.endedAt ?? options.usage.capturedAt ??
      (options.usage.elapsedMs === undefined
        ? options.fallbackAt
        : startedAt + options.usage.elapsedMs);
  const response = responseText.length === 0
    ? undefined
    : preview(responseText);
  const userText = messageText(options.request);
  return {
    id: options.usage?.requestId ?? `unmeasured:${options.requestId}`,
    callWithinTurn: 1,
    preview: userText === undefined ? undefined : conciseTitle(userText),
    ...(response === undefined ? {} : {
      responsePreview: response.preview,
      responseOriginalLength: response.originalLength,
      responseTruncated: response.truncated,
    }),
    provider: "cursor",
    model,
    startedAt,
    completedAt,
    reportedCost: options.usage?.reportedCost,
    tokens: options.usage === undefined
      ? emptyTokens()
      : tokenUsage(options.usage),
    activity: {
      hasText: responseText.length > 0,
      hasReasoning,
      images: images > 0 ? images : undefined,
      tools,
    },
    content: response === undefined ? [] : [response],
  };
}

function candidateTime(candidate: CursorAgentCandidate) {
  return candidate.updatedAt || Date.now();
}

function sessionTitle(
  storeMeta: CursorStoreMeta,
  requests: CursorMessage[],
  id: string,
) {
  const named = conciseTitle(storeMeta.name);
  if (named !== undefined && named.toLowerCase() !== "new agent") return named;
  const prompt = requests.map(messageText).find((value) => value?.trim());
  return conciseTitle(prompt) ?? `Cursor agent ${id.slice(0, 8)}`;
}

function snapshotChecksum(
  snapshot: CursorSnapshot,
  captures: Map<string, CursorUsageRecord>,
) {
  const requestIDs = snapshot.messages.flatMap((message) => {
    const id = requestID(message);
    return id === undefined ? [] : [id];
  });
  return digestJson(JSON.stringify({
    rootBlobId: snapshot.rootBlobId,
    messages: snapshot.messages,
    captures: requestIDs.map((id) => captures.get(id) ?? null),
  }));
}

export function normalizeCursorSession(options: {
  candidate: CursorAgentCandidate;
  snapshot: CursorSnapshot;
  capture: CursorCaptureIndex;
  sourceID: number;
  observedAt: number;
  checkpoint: LinearConversationImport["checkpoint"];
  childByToolCallID?: Map<string, string>;
}): LinearConversationImport {
  const { candidate, snapshot, capture } = options;
  const requests = snapshot.messages.flatMap((message, index) => {
    const requestId = message.role === "user" ? requestID(message) : undefined;
    return requestId === undefined ? [] : [{ message, index, requestId }];
  });
  const calls: Array<{
    request: (typeof requests)[number];
    call: ConversationCallImport;
  }> = [];
  const turns: LinearConversationImport["session"]["turns"] = [];
  const tokens = emptyTokens();
  let reportedCost = 0;
  let hasReportedCost = false;
  const childByToolCallID = options.childByToolCallID ?? new Map();

  requests.forEach((request, requestIndex) => {
    const usage = capture.records.get(request.requestId);
    const nextRequest = requests[requestIndex + 1];
    const segment = snapshot.messages.slice(
      request.index + 1,
      nextRequest?.index ?? snapshot.messages.length,
    );
    const hasAssistantActivity = segment.some((message) =>
      message.role === "assistant" || message.role === "tool"
    );
    if (usage === undefined && !hasAssistantActivity) return;
    const call = callForRequest({
      request: request.message,
      requestId: request.requestId,
      segment,
      usage,
      fallbackAt: candidateTime(candidate),
      childByToolCallID,
    });
    calls.push({ request, call });
    addTokens(tokens, call.tokens);
    if (call.reportedCost !== undefined) {
      reportedCost += call.reportedCost;
      hasReportedCost = true;
    }
    turns.push({
      number: turns.length + 1,
      startedAt: call.startedAt,
      inputs: messageInputs(request.message),
      calls: [call],
    });
  });

  // Session model summaries must follow observed call order. Snapshot message
  // order can include streaming/replay blobs, and storeMeta.lastUsedModel is
  // only a session-level setting rather than evidence for an earlier turn.
  const uniqueModels = [
    ...new Set(
      calls.map(({ call }) => call.model).filter((model) =>
        model !== "unknown"
      ),
    ),
  ];
  const startedAt = snapshot.fileMeta.createdAtMs ??
    snapshot.storeMeta.createdAt;
  const updatedAt = candidate.updatedAt || options.observedAt;
  const sourceSession: LinearConversationImport = {
    sourceID: options.sourceID,
    externalID: candidate.id,
    artifactPath: candidate.artifactPath,
    parentExternalID: candidate.parentExternalID,
    workingDirectory: snapshot.fileMeta.cwd,
    observedAt: options.observedAt,
    checkpoint: options.checkpoint,
    session: {
      title: sessionTitle(
        snapshot.storeMeta,
        requests.map(({ message }) => message),
        candidate.id,
      ),
      agent: snapshot.storeMeta.subagentInfo?.typeName,
      updatedAt,
      startedAt,
      endedAt: snapshot.fileMeta.updatedAtMs,
      providers: calls.length === 0 ? [] : ["cursor"],
      models: uniqueModels,
      userTurns: requests.length,
      modelCalls: calls.length,
      reportedCost: hasReportedCost ? reportedCost : undefined,
      tokens,
      turns,
    },
  };
  return sourceSession;
}

function readSnapshotWithRetry(candidate: CursorAgentCandidate) {
  try {
    return readCursorSnapshot(candidate);
  } catch (firstError) {
    // Cursor can advance the root/WAL while the first read is in progress.
    // A single retry avoids making a transient write look like a permanent
    // corrupt session without hiding genuine decode errors.
    try {
      return readCursorSnapshot(candidate);
    } catch {
      throw firstError;
    }
  }
}

function candidateGroups(candidates: CursorAgentCandidate[]) {
  const byID = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const rootFor = (candidate: CursorAgentCandidate) => {
    const visited = new Set<string>();
    let current = candidate;
    while (
      current.parentExternalID !== undefined &&
      byID.has(current.parentExternalID) && !visited.has(current.id)
    ) {
      visited.add(current.id);
      current = byID.get(current.parentExternalID)!;
    }
    return current.id;
  };
  return Map.groupBy(candidates, rootFor);
}

function currentProjection(
  checkpoint: ProjectionCheckpoint | undefined,
  parserVersion: string,
  checksum: string,
) {
  return checkpoint?.parserVersion === parserVersion &&
    checkpoint.checksum === checksum && checkpoint.lastError === undefined;
}

function recordUnchangedTree(
  repository: SourceArtifactRepository,
  sourceID: number,
  candidates: CursorAgentCandidate[],
  observedAt: number,
  parserVersion: string,
  projectionName = "conversation",
  checksums?: ReadonlyMap<string, string>,
) {
  for (const candidate of candidates) {
    const previous = repository.projectionCheckpoint(
      sourceID,
      candidate.id,
      projectionName,
    );
    repository.recordUnchangedArtifact(
      sourceID,
      candidate.id,
      candidate.artifactPath,
      observedAt,
      {
        changeHint: candidate.changeHint,
        sourceSize: candidate.size,
        sourceModifiedAt: candidate.sourceModifiedAt,
        checksum: checksums?.get(candidate.id) ?? previous?.checksum,
        parserVersion,
      },
      projectionName,
    );
  }
}

export function syncCursorAgentSessions(
  directory: string,
  capturePath: string | undefined,
  repository: SourceArtifactRepository,
  conversations: ConversationWriteRepository,
) {
  const observedAt = Date.now();
  const capture = readCursorCapture(capturePath);
  const sourceID = repository.ensureSource(
    "cursor",
    "directory",
    "Cursor",
    directory,
  );
  const candidates = discoverCursorSessions(directory, capture.revision);
  const groups = candidateGroups(candidates);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failureCategories: Record<string, number> = {};

  for (const group of groups.values()) {
    const currentByHint = group.every((candidate) => {
      const previous = repository.projectionCheckpoint(
        sourceID,
        candidate.id,
        projectionName,
      );
      return previous?.parserVersion === cursorParserVersion &&
        previous.changeHint === candidate.changeHint &&
        previous.lastError === undefined;
    });
    if (currentByHint) {
      recordUnchangedTree(
        repository,
        sourceID,
        group,
        observedAt,
        cursorParserVersion,
        projectionName,
      );
      skipped += group.length;
      continue;
    }

    let normalized: LinearConversationImport[];
    let checksums: Map<string, string>;
    try {
      const groupIDs = new Set(group.map((candidate) => candidate.id));
      const snapshots = group.map((candidate) => ({
        candidate: candidate.parentExternalID !== undefined &&
            !groupIDs.has(candidate.parentExternalID)
          ? { ...candidate, parentExternalID: undefined }
          : candidate,
        snapshot: readSnapshotWithRetry(candidate),
      }));
      checksums = new Map(snapshots.map(({ candidate, snapshot }) => [
        candidate.id,
        snapshotChecksum(snapshot, capture.records),
      ]));
      const childByToolCallID = new Map(
        group.flatMap((child) => {
          const toolCallID = child.storeMeta.subagentInfo?.toolCallId;
          return toolCallID === undefined ? [] : [[toolCallID, child.id]];
        }),
      );
      normalized = snapshots.map(({ candidate, snapshot }) =>
        normalizeCursorSession({
          candidate,
          snapshot,
          capture,
          sourceID,
          observedAt,
          checkpoint: {
            changeHint: candidate.changeHint,
            sourceSize: candidate.size,
            sourceModifiedAt: candidate.sourceModifiedAt,
            checksum: checksums.get(candidate.id),
            parserVersion: cursorParserVersion,
          },
          childByToolCallID,
        })
      );
      for (const candidate of group) {
        repository.recordUnchangedArtifact(
          sourceID,
          candidate.id,
          candidate.artifactPath,
          observedAt,
        );
      }
    } catch (error) {
      const failure = artifactImportFailure(error);
      const category = failure.name === "SyntaxError"
        ? "invalid-json"
        : failure.message.toLowerCase().includes("protobuf")
        ? "invalid-store"
        : "import-error";
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      console.warn(
        `[sync] harness=cursor session=${
          group[0].id
        } failed category=${category}`,
        error,
      );
      for (const candidate of group) {
        repository.recordArtifactError(
          sourceID,
          candidate.id,
          candidate.artifactPath,
          observedAt,
          failure,
          projectionName,
        );
      }
      failed += group.length;
      continue;
    }

    const current = normalized.every((value) =>
      currentProjection(
        repository.projectionCheckpoint(
          sourceID,
          value.externalID,
          projectionName,
        ),
        cursorParserVersion,
        checksums.get(value.externalID)!,
      )
    );
    if (current) {
      recordUnchangedTree(
        repository,
        sourceID,
        group,
        observedAt,
        cursorParserVersion,
        projectionName,
        checksums,
      );
      skipped += group.length;
      continue;
    }

    try {
      conversations.replaceLinearConversationTree(normalized);
      recordUnchangedTree(
        repository,
        sourceID,
        group,
        observedAt,
        cursorParserVersion,
        projectionName,
        checksums,
      );
      for (const candidate of group) {
        repository.recordProjectionCheckpoint(
          sourceID,
          candidate.id,
          projectionName,
          {
            changeHint: candidate.changeHint,
            sourceSize: candidate.size,
            sourceModifiedAt: candidate.sourceModifiedAt,
            checksum: checksums.get(candidate.id),
            parserVersion: cursorParserVersion,
          },
        );
      }
      imported += normalized.length;
    } catch (error) {
      const failure = artifactImportFailure(error);
      console.warn(
        `[sync] harness=cursor session=${
          group[0].id
        } projection=${projectionName} failed`,
        error,
      );
      for (const candidate of group) {
        repository.recordProjectionError(
          sourceID,
          candidate.id,
          projectionName,
          failure,
        );
      }
      failed += group.length;
    }
  }

  repository.markArtifactsSeen(
    sourceID,
    candidates.map((candidate) => candidate.id),
    observedAt,
  );
  repository.markMissingArtifacts(sourceID, observedAt);
  if (capture.malformedLines > 0) {
    console.warn(
      `[sync] harness=cursor capture=${
        capture.path ?? "none"
      } malformedLines=${capture.malformedLines}`,
    );
  }
  return {
    discovered: candidates.length,
    imported,
    skipped,
    failed,
    failureCategories,
    captureRecords: capture.records.size,
  };
}
