export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  | { state: "value"; value: unknown };

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
