export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

function isNonArrayObject<Value>(value: Value): value is Value & object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isNonArrayObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export type ObservedValue =
  | JsonPrimitive
  | undefined
  | ObservedValue[]
  | ObservedObject;

export type ObservedObject = { [key: string]: ObservedValue };

export function isObservedValue(value: unknown): value is ObservedValue {
  if (value === undefined) return true;
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isObservedValue);
  return isObservedObject(value);
}

export function isObservedObject(value: unknown): value is ObservedObject {
  if (!isNonArrayObject(value)) return false;
  return Object.values(value).every(isObservedValue);
}

export type ScenarioInput = string | JsonValue[];

export type ScenarioMode = "full-replay" | "previous-response-id";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ReasoningConfig {
  effort?: ReasoningEffort;
  mode?: "pro";
  summary?: "auto" | "concise" | "detailed";
}

export type CacheClassification =
  | "explicit-zero"
  | "omitted-cache-details"
  | "omitted-cached-tokens"
  | "nonzero"
  | "malformed/unexpected"
  | "usage-missing";

export type RawField =
  | { state: "missing" }
  | { state: "undefined" }
  | { state: "null"; value: null }
  | { state: "value"; value: Exclude<ObservedValue, undefined> };

export interface UsageShape {
  classification: CacheClassification;
  usagePresent: boolean;
  usageKeys: string[];
  inputTokensDetailsPresent: boolean;
  inputTokensDetailsKeys: string[];
  cachedTokens: RawField;
  cacheWriteTokens: RawField;
  inputTokens: RawField;
  outputTokens: RawField;
  totalTokens: RawField;
  reasoningTokens: RawField;
  malformedFields: string[];
}

export interface ScenarioCall {
  id: string;
  input?: ScenarioInput;
  inputFile?: string;
  delayMs?: number;
}

export interface Scenario {
  id: string;
  model: string;
  mode: ScenarioMode;
  reasoning?: ReasoningConfig;
  instructions?: string;
  tools?: JsonValue[];
  toolOutputs: Record<string, JsonValue>;
  promptCacheKey?: string;
  store: boolean;
  stream: boolean;
  delayMs: number;
  maxToolRounds: number;
  calls: ScenarioCall[];
}

export interface ErrorSummary {
  code?: string;
  type?: string;
  message?: string;
}

export interface RunCallRecord {
  scenarioId: string;
  callOrdinal: number;
  callId: string;
  kind: "scenario" | "deterministic-tool";
  mode: ScenarioMode;
  inputMode: "full-replay" | "delta";
  previousResponseIdUsed: boolean;
  reasoning: ReasoningConfig | null;
  startTime: string;
  elapsedMs: number;
  httpStatus: number | null;
  responseId: string | null;
  responseStatus: string | null;
  stopStatus: string | null;
  incompleteReason: string | null;
  errorStatus: string | null;
  responseHeaders: Record<string, string>;
  error?: ErrorSummary;
  responseParse: "json" | "sse" | "invalid" | "not-present";
  rawResponsePath: string | null;
  requestBodyHash: string;
  requestByteSize: number;
  requestBodyPath?: string;
  responseByteSize: number;
  usage: UsageShape;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  model: string;
  mode: ScenarioMode;
  baseUrl: string;
  startedAt: string;
  completedAt: string | null;
  dryRun: boolean;
  calls: RunCallRecord[];
  warnings: string[];
}
