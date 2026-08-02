import type {
  JsonValue,
  ReasoningConfig,
  ReasoningEffort,
  Scenario,
  ScenarioCall,
  ScenarioInput,
  ScenarioMode,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

export const DEFAULT_MODEL = "gpt-5.6-luna";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined
    ? undefined
    : typeof value === "string"
    ? value
    : undefined;
}

function requiredString(
  record: JsonRecord,
  key: string,
  source: string,
): string {
  const value = stringField(record, key);
  if (!value || value.trim().length === 0) {
    throw new Error(`${source}: ${key} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  fieldName: string,
  source: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`${source}: ${fieldName} must be a non-negative integer`);
  }
  return value;
}

function parseMode(value: unknown, source: string): ScenarioMode {
  if (
    value === undefined || value === "full-replay" || value === "full_replay"
  ) {
    return "full-replay";
  }
  if (value === "previous-response-id" || value === "previous_response_id") {
    return "previous-response-id";
  }
  throw new Error(
    `${source}: mode must be full-replay or previous-response-id`,
  );
}

function parseReasoning(
  value: unknown,
  source: string,
): ReasoningConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${source}: reasoning must be an object`);
  }

  const effortValues: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  const effort = value.effort;
  if (
    effort !== undefined && !effortValues.includes(effort as ReasoningEffort)
  ) {
    throw new Error(`${source}: reasoning.effort is not supported`);
  }
  if (value.mode !== undefined && value.mode !== "pro") {
    throw new Error(`${source}: reasoning.mode must be pro when provided`);
  }
  const summaries = ["auto", "concise", "detailed"];
  if (
    value.summary !== undefined && !summaries.includes(String(value.summary))
  ) {
    throw new Error(
      `${source}: reasoning.summary must be auto, concise, or detailed`,
    );
  }
  return {
    ...(effort === undefined ? {} : { effort: effort as ReasoningEffort }),
    ...(value.mode === undefined ? {} : { mode: "pro" as const }),
    ...(value.summary === undefined
      ? {}
      : { summary: value.summary as ReasoningConfig["summary"] }),
  };
}

function parseInput(
  value: unknown,
  fieldName: string,
  source: string,
): ScenarioInput {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(isJsonValue)) return value;
  throw new Error(`${source}: ${fieldName} must be a string or JSON array`);
}

function parseCall(
  value: unknown,
  index: number,
  source: string,
): ScenarioCall {
  if (!isRecord(value)) {
    throw new Error(`${source}: calls[${index}] must be an object`);
  }
  const inputFile = stringField(value, "input_file");
  if (value.input_file !== undefined && inputFile === undefined) {
    throw new Error(`${source}: calls[${index}].input_file must be a string`);
  }
  const hasInput = value.input !== undefined;
  if (hasInput === Boolean(inputFile)) {
    throw new Error(
      `${source}: calls[${index}] must provide exactly one of input or input_file`,
    );
  }
  return {
    id: stringField(value, "id") || `call-${index + 1}`,
    ...(hasInput
      ? { input: parseInput(value.input, `calls[${index}].input`, source) }
      : { inputFile }),
    ...(value.delay_ms === undefined ? {} : {
      delayMs: nonNegativeInteger(
        value.delay_ms,
        `calls[${index}].delay_ms`,
        source,
      ),
    }),
  };
}

function parseTools(value: unknown, source: string): JsonValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isJsonValue)) {
    throw new Error(`${source}: tools must be an array of JSON values`);
  }
  for (const [index, tool] of value.entries()) {
    if (!isRecord(tool) || tool.type !== "function") {
      throw new Error(
        `${source}: tools[${index}] must be a function tool; built-in or filesystem tools are not supported`,
      );
    }
  }
  return value;
}

function parseToolOutputs(
  value: unknown,
  source: string,
): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every(isJsonValue)) {
    throw new Error(`${source}: tool_outputs must map names to JSON values`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, output]) => [name, output as JsonValue]),
  );
}

function parseCalls(record: JsonRecord, source: string): ScenarioCall[] {
  if (record.calls !== undefined) {
    if (!Array.isArray(record.calls)) {
      throw new Error(`${source}: calls must be an array`);
    }
    return record.calls.map((call, index) => parseCall(call, index, source));
  }

  const initial = record.initial_input;
  const followUp = record.follow_up_input;
  if (initial === undefined || followUp === undefined) {
    throw new Error(
      `${source}: provide calls or both initial_input and follow_up_input`,
    );
  }
  return [
    { id: "initial", input: parseInput(initial, "initial_input", source) },
    { id: "follow-up", input: parseInput(followUp, "follow_up_input", source) },
  ];
}

export function parseScenario(text: string, source = "scenario"): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source}: invalid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${source}: top-level value must be an object`);
  }

  const mode = parseMode(parsed.mode, source);
  const calls = parseCalls(parsed, source);
  if (calls.length < 2) {
    throw new Error(`${source}: at least two calls are required`);
  }
  const delayMs = parsed.delay_ms === undefined
    ? 0
    : nonNegativeInteger(parsed.delay_ms, "delay_ms", source);
  const maxToolRounds = parsed.max_tool_rounds === undefined
    ? 4
    : nonNegativeInteger(parsed.max_tool_rounds, "max_tool_rounds", source);
  if (maxToolRounds > 16) {
    throw new Error(`${source}: max_tool_rounds must be at most 16`);
  }

  const instructions = stringField(parsed, "instructions");
  if (parsed.instructions !== undefined && instructions === undefined) {
    throw new Error(`${source}: instructions must be a string`);
  }
  const promptCacheKey = stringField(parsed, "prompt_cache_key");
  if (parsed.prompt_cache_key !== undefined && promptCacheKey === undefined) {
    throw new Error(`${source}: prompt_cache_key must be a string`);
  }
  const model = parsed.model === undefined
    ? DEFAULT_MODEL
    : requiredString(parsed, "model", source);
  const id = stringField(parsed, "id") || stringField(parsed, "scenario_id") ||
    model;
  const store = parsed.store === undefined
    ? mode === "previous-response-id"
    : parsed.store;
  if (typeof store !== "boolean") {
    throw new Error(`${source}: store must be boolean`);
  }
  const stream = parsed.stream === undefined ? false : parsed.stream;
  if (typeof stream !== "boolean") {
    throw new Error(`${source}: stream must be boolean`);
  }

  return {
    id,
    model,
    mode,
    reasoning: parseReasoning(parsed.reasoning, source),
    ...(instructions === undefined ? {} : { instructions }),
    tools: parseTools(parsed.tools, source),
    toolOutputs: parseToolOutputs(parsed.tool_outputs, source),
    ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
    store,
    stream,
    delayMs,
    maxToolRounds,
    calls,
  };
}

export function normalizeInput(input: ScenarioInput): JsonValue[] {
  if (Array.isArray(input)) return input;
  return [{ role: "user", content: input }];
}
