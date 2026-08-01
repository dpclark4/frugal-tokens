import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface OpenAICodexWebSocketDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  storeTrueRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
  lastPreviousResponseId?: string;
  websocketFailures: number;
  sseFallbacks: number;
  websocketFallbackActive?: boolean;
  lastWebSocketError?: string;
}

type CodexDebugModule = {
  getOpenAICodexWebSocketDebugStats(
    sessionId: string,
  ): OpenAICodexWebSocketDebugStats | undefined;
};

const SCHEMA_VERSION = 2;
const CHECKPOINT_INTERVAL = 50;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_DIAGNOSTIC_TEXT = 2_000;
const SAFE_RESPONSE_HEADERS = new Set([
  "cf-ray",
  "openai-processing-ms",
  "openai-request-id",
  "server-timing",
  "x-request-id",
]);
const SAFE_DIAGNOSTIC_DETAIL_KEYS = new Set([
  "configuredTransport",
  "fallbackTransport",
  "eventsEmitted",
  "phase",
  "requestBytes",
]);
const WEBSOCKET_COUNTER_KEYS = [
  "requests",
  "connectionsCreated",
  "connectionsReused",
  "cachedContextRequests",
  "storeTrueRequests",
  "fullContextRequests",
  "deltaRequests",
  "websocketFailures",
  "sseFallbacks",
] as const;

type JsonRecord = Record<string, unknown>;

type RequestObservation = {
  sequence: number;
  startedAt: string;
  startedMonotonicMs: number;
  provider: string;
  model: string;
  thinkingLevel: string;
  payload: ReturnType<typeof summarizePayload>["summary"];
  websocketBefore?: OpenAICodexWebSocketDebugStats;
  httpResponses: Array<{ status: number; headers: Record<string, string> }>;
};

type PreviousRequest = {
  sequence: number;
  envelopeHash: string;
  inputHash: string;
  inputItemHashes: string[];
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return JSON.stringify({ unserializable: true, type: typeof value });
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(serialized(value)).digest("hex");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(serialized(value));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function summarizeInputItem(value: unknown) {
  const item = asRecord(value);
  const content = Array.isArray(item.content) ? item.content : [];
  return {
    hash: hash(value),
    bytes: byteLength(value),
    type: typeof item.type === "string" ? item.type : undefined,
    role: typeof item.role === "string" ? item.role : undefined,
    contentTypes: content.map((entry) => {
      const record = asRecord(entry);
      return typeof record.type === "string" ? record.type : "unknown";
    }),
  };
}

function countTaggedTypes(value: unknown, counts = new Map<string, number>()): Map<string, number> {
  if (Array.isArray(value)) {
    for (const child of value) countTaggedTypes(child, counts);
    return counts;
  }
  if (!value || typeof value !== "object") return counts;
  const record = value as JsonRecord;
  if (typeof record.type === "string") {
    counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
  }
  for (const child of Object.values(record)) countTaggedTypes(child, counts);
  return counts;
}

function summarizePayload(value: unknown, previous?: PreviousRequest) {
  const payload = asRecord(value);
  const input = Array.isArray(payload.input) ? payload.input : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const inputItems = input.map(summarizeInputItem);
  const inputItemHashes = inputItems.map((item) => item.hash);
  const inputHash = hash(input);
  const envelope = { ...payload };
  delete envelope.input;
  const envelopeHash = hash(envelope);
  let commonPrefixItems = 0;
  if (previous) {
    const limit = Math.min(previous.inputItemHashes.length, inputItemHashes.length);
    while (
      commonPrefixItems < limit &&
      previous.inputItemHashes[commonPrefixItems] === inputItemHashes[commonPrefixItems]
    ) commonPrefixItems++;
  }
  const previousInputItemCount = previous?.inputItemHashes.length ?? 0;
  const inputSuffixItems = inputItems.slice(commonPrefixItems);
  const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
  const promptCacheKey = typeof payload.prompt_cache_key === "string"
    ? payload.prompt_cache_key
    : undefined;
  const taggedTypes = Object.fromEntries(
    [...countTaggedTypes(input).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    summary: {
      hash: hash(payload),
      inputHash,
      bytes: byteLength(payload),
      topLevelKeys: Object.keys(payload).sort(),
      envelopeHash,
      envelopeMatchesPrevious: previous ? envelopeHash === previous.envelopeHash : undefined,
      previousSequence: previous?.sequence,
      previousInputHash: previous?.inputHash,
      previousInputItemCount: previous ? previousInputItemCount : undefined,
      commonPrefixItems: previous ? commonPrefixItems : undefined,
      removedInputItemCount: previous
        ? previousInputItemCount - commonPrefixItems
        : undefined,
      priorInputIsExactPrefix: previous
        ? commonPrefixItems === previousInputItemCount
        : undefined,
      inputItemCount: input.length,
      inputSuffixItemCount: inputSuffixItems.length,
      inputSuffixItems,
      taggedInputTypes: taggedTypes,
      instructions: instructions
        ? { hash: hash(instructions), chars: instructions.length, bytes: Buffer.byteLength(instructions) }
        : { present: false },
      tools: { count: tools.length, hash: hash(tools), bytes: byteLength(tools) },
      promptCacheKey: promptCacheKey
        ? { present: true, hash: hash(promptCacheKey), chars: promptCacheKey.length }
        : { present: false },
      settings: {
        model: payload.model,
        store: payload.store,
        stream: payload.stream,
        toolChoice: payload.tool_choice,
        parallelToolCalls: payload.parallel_tool_calls,
        reasoning: payload.reasoning,
        text: payload.text,
        serviceTier: payload.service_tier,
        include: payload.include,
      },
    },
    inputItemHashes,
  };
}

function websocketCounterSnapshot(
  stats: OpenAICodexWebSocketDebugStats | undefined,
): Record<string, number> {
  return Object.fromEntries(
    WEBSOCKET_COUNTER_KEYS.map((key) => [key, stats?.[key] ?? 0]),
  );
}

function websocketDelta(
  before: OpenAICodexWebSocketDebugStats | undefined,
  after: OpenAICodexWebSocketDebugStats | undefined,
) {
  if (!before && !after) return undefined;
  const final = after ?? before;
  const initialCounters = websocketCounterSnapshot(before);
  const finalCounters = websocketCounterSnapshot(final);
  const counters = Object.fromEntries(
    WEBSOCKET_COUNTER_KEYS.map((key) => [key, finalCounters[key] - initialCounters[key]]),
  );
  const usedPreviousResponseId = counters.deltaRequests > 0;

  return {
    counters,
    lastDeltaInputItems: usedPreviousResponseId ? final?.lastDeltaInputItems : undefined,
    usedPreviousResponseId,
    previousResponseIdHash: usedPreviousResponseId && final?.lastPreviousResponseId
      ? hash(final.lastPreviousResponseId)
      : undefined,
    fallbackActive: final?.websocketFallbackActive,
    lastWebSocketErrorHash: counters.websocketFailures > 0 && final?.lastWebSocketError
      ? hash(final.lastWebSocketError)
      : undefined,
  };
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => SAFE_RESPONSE_HEADERS.has(name.toLowerCase())),
  );
}

function safeDiagnosticDetailValue(key: string, value: unknown): unknown {
  switch (key) {
    case "configuredTransport":
    case "fallbackTransport":
    case "phase":
      return typeof value === "string" ? value.slice(0, MAX_DIAGNOSTIC_TEXT) : undefined;
    case "eventsEmitted":
      return typeof value === "boolean" ? value : undefined;
    case "requestBytes":
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    default:
      return undefined;
  }
}

function safeDiagnosticDetails(value: unknown): JsonRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { omittedDetailKeys: ["<non-object>"] };
  }

  const details = value as JsonRecord;
  const safe: JsonRecord = {};
  const omittedDetailKeys: string[] = [];
  for (const key of Object.keys(details).sort()) {
    if (!SAFE_DIAGNOSTIC_DETAIL_KEYS.has(key)) {
      omittedDetailKeys.push(key.slice(0, 100));
      continue;
    }
    const sanitized = safeDiagnosticDetailValue(key, details[key]);
    if (sanitized === undefined) omittedDetailKeys.push(key.slice(0, 100));
    else safe[key] = sanitized;
  }
  if (omittedDetailKeys.length) safe.omittedDetailKeys = omittedDetailKeys;
  return Object.keys(safe).length ? safe : undefined;
}

function safeDiagnostics(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const diagnostic = asRecord(entry);
    const error = asRecord(diagnostic.error);
    return {
      type: typeof diagnostic.type === "string"
        ? diagnostic.type.slice(0, MAX_DIAGNOSTIC_TEXT)
        : undefined,
      timestamp: diagnostic.timestamp,
      error: Object.keys(error).length
        ? {
          name: typeof error.name === "string" ? error.name.slice(0, MAX_DIAGNOSTIC_TEXT) : undefined,
          code: typeof error.code === "string" || typeof error.code === "number"
            ? error.code
            : undefined,
          message: typeof error.message === "string"
            ? error.message.slice(0, MAX_DIAGNOSTIC_TEXT)
            : undefined,
        }
        : undefined,
      details: safeDiagnosticDetails(diagnostic.details),
    };
  });
}

function usageSummary(value: unknown) {
  const usage = asRecord(value);
  const cost = asRecord(usage.cost);
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
      total: cost.total,
    },
  };
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export default async function cacheTelemetry(pi: ExtensionAPI) {
  // Pi's extension loader aliases @earendil-works/pi-ai to its compatibility
  // entrypoint, so resolve that file and import the sibling API module directly.
  const packageDir = getPackageDir();
  const apiCandidates = [
    join(packageDir, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js"),
    join(packageDir, "..", "pi-ai", "dist", "api", "openai-codex-responses.js"),
  ];
  const apiPath = apiCandidates.find(existsSync);
  if (!apiPath) {
    throw new Error("Could not locate Pi's openai-codex-responses debug module");
  }
  const codexDebug = await import(pathToFileURL(apiPath).href) as CodexDebugModule;
  const getOpenAICodexWebSocketDebugStats =
    codexDebug.getOpenAICodexWebSocketDebugStats;

  const baseDir = process.env.PI_CACHE_TELEMETRY_DIR ||
    join(homedir(), ".pi", "agent", "diagnostics", "cache-telemetry");
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });

  let sessionId = "unknown";
  let logPath = join(baseDir, `startup-${process.pid}.jsonl`);
  let sequence = 0;
  let fileIndex = 0;
  let pending: RequestObservation[] = [];
  let previousRequest: PreviousRequest | undefined;
  let websocketBaselineWritten = false;
  let pendingCheckpointReasons = new Set<string>();
  let firstCheckpointReason = "session_start";

  const writeEvent = (event: JsonRecord) => {
    try {
      if (statSync(logPath, { throwIfNoEntry: false })?.size >= MAX_LOG_BYTES) {
        fileIndex++;
        logPath = join(baseDir, `${sanitizeFilePart(sessionId)}-${process.pid}-${fileIndex}.jsonl`);
      }
      appendFileSync(logPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...event })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      console.error("[cache-telemetry] failed to write diagnostic event", error);
    }
  };

  const writeWebsocketBaseline = (
    timestamp: string,
    sequence: number,
    stats: OpenAICodexWebSocketDebugStats | undefined,
  ) => {
    if (websocketBaselineWritten) return;
    writeEvent({
      event: "websocket_baseline",
      timestamp,
      sessionId,
      sequence,
      available: Boolean(stats),
      counters: websocketCounterSnapshot(stats),
    });
    websocketBaselineWritten = true;
  };

  pi.on("session_start", (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    logPath = join(baseDir, `${sanitizeFilePart(sessionId)}-${process.pid}-${fileIndex}.jsonl`);
    sequence = 0;
    pending = [];
    previousRequest = undefined;
    websocketBaselineWritten = false;
    pendingCheckpointReasons = new Set<string>();
    firstCheckpointReason = event.reason === "reload"
      ? "extension_reload"
      : `session_${event.reason}`;
    writeEvent({
      event: "session_start",
      timestamp: new Date().toISOString(),
      reason: event.reason,
      sessionId,
      sessionFileHash: ctx.sessionManager.getSessionFile()
        ? hash(ctx.sessionManager.getSessionFile())
        : undefined,
      cwd: { basename: basename(ctx.cwd), hash: hash(ctx.cwd) },
      runtime: { node: process.version, pid: process.pid, platform: process.platform, arch: process.arch },
      privacy: "No raw prompts, tool bodies, images, credentials, authorization headers, or response IDs are logged."
    });
  });

  pi.on("session_compact", (event) => {
    pendingCheckpointReasons.add(`compaction:${event.reason}`);
  });

  pi.on("session_tree", () => {
    pendingCheckpointReasons.add("tree_navigation");
  });

  pi.on("before_provider_request", (event, ctx) => {
    const provider = ctx.model?.provider ?? "unknown";
    if (provider !== "openai" && provider !== "openai-codex") return;

    const currentSequence = ++sequence;
    const { summary: payload, inputItemHashes } = summarizePayload(event.payload, previousRequest);
    const websocketBefore = provider === "openai-codex"
      ? getOpenAICodexWebSocketDebugStats(sessionId)
      : undefined;
    const observation: RequestObservation = {
      sequence: currentSequence,
      startedAt: new Date().toISOString(),
      startedMonotonicMs: performance.now(),
      provider,
      model: ctx.model?.id ?? "unknown",
      thinkingLevel: ctx.thinkingLevel,
      payload,
      websocketBefore,
      httpResponses: [],
    };

    const checkpointReasons = new Set<string>();
    if (!previousRequest) checkpointReasons.add(firstCheckpointReason);
    else {
      if (payload.priorInputIsExactPrefix === false) checkpointReasons.add("prefix_mismatch");
      if (payload.inputItemCount < (payload.previousInputItemCount ?? 0)) {
        checkpointReasons.add("input_truncation");
      }
      if (payload.envelopeMatchesPrevious === false) checkpointReasons.add("envelope_change");
    }
    if (currentSequence % CHECKPOINT_INTERVAL === 0) checkpointReasons.add("periodic");
    for (const reason of pendingCheckpointReasons) checkpointReasons.add(reason);
    pendingCheckpointReasons.clear();

    if (provider === "openai-codex") {
      writeWebsocketBaseline(observation.startedAt, observation.sequence, websocketBefore);
    }
    if (checkpointReasons.size) {
      writeEvent({
        event: "input_checkpoint",
        timestamp: observation.startedAt,
        sessionId,
        sequence: currentSequence,
        reasons: [...checkpointReasons],
        inputHash: payload.inputHash,
        inputItemCount: payload.inputItemCount,
        itemHashes: inputItemHashes,
      });
    }

    pending.push(observation);
    previousRequest = {
      sequence: currentSequence,
      envelopeHash: payload.envelopeHash,
      inputHash: payload.inputHash,
      inputItemHashes,
    };
    writeEvent({
      event: "provider_request",
      timestamp: observation.startedAt,
      sessionId,
      sequence: currentSequence,
      provider,
      model: observation.model,
      thinkingLevel: observation.thinkingLevel,
      payload,
    });
  });

  pi.on("after_provider_response", (event) => {
    const observation = pending.at(-1);
    if (!observation) return;
    observation.httpResponses.push({ status: event.status, headers: safeHeaders(event.headers) });
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== "openai" && message.provider !== "openai-codex") return;

    const observationIndex = pending.findIndex((candidate) => candidate.provider === message.provider);
    const observation = observationIndex >= 0 ? pending.splice(observationIndex, 1)[0] : undefined;
    const websocketAfter = message.provider === "openai-codex"
      ? getOpenAICodexWebSocketDebugStats(sessionId)
      : undefined;
    writeEvent({
      event: "assistant_completion",
      timestamp: new Date().toISOString(),
      sessionId,
      sequence: observation?.sequence,
      orphaned: !observation,
      durationMs: observation ? Math.round(performance.now() - observation.startedMonotonicMs) : undefined,
      provider: message.provider,
      api: message.api,
      model: message.model,
      responseModel: message.responseModel,
      thinkingLevel: observation?.thinkingLevel,
      responseIdHash: message.responseId ? hash(message.responseId) : undefined,
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      errorMessage: message.errorMessage?.slice(0, MAX_DIAGNOSTIC_TEXT),
      usage: usageSummary(message.usage),
      diagnostics: safeDiagnostics(message.diagnostics),
      httpResponses: observation?.httpResponses,
      websocketDelta: websocketDelta(observation?.websocketBefore, websocketAfter),
    });
  });

  pi.on("session_shutdown", (event) => {
    writeEvent({
      event: "session_shutdown",
      timestamp: new Date().toISOString(),
      sessionId,
      reason: event.reason,
      pendingRequestSequences: pending.map((request) => request.sequence),
    });
  });
}
