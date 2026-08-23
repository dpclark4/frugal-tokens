import { postResponses } from "./client.ts";
import { DEFAULT_MODEL, normalizeInput, parseScenario } from "./scenario.ts";
import { createRunStore, defaultOutputDirectory, sha256 } from "./storage.ts";
import { extractUsageShape } from "./usage.ts";
import type {
  ErrorSummary,
  JsonValue,
  RawField,
  ReasoningConfig,
  ReasoningEffort,
  RunCallRecord,
  RunManifest,
  Scenario,
  ScenarioCall,
  ScenarioMode,
} from "./types.ts";
import { isJsonObject, type JsonObject } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_FORMAT = "human";

type OutputFormat = "human" | "json";

interface RequestBody {
  model: string;
  store: boolean;
  stream: boolean;
  input: JsonValue[];
  instructions?: string;
  reasoning?: ReasoningConfig;
  tools?: JsonValue[];
  prompt_cache_key?: string;
  previous_response_id?: string;
}

interface CliOptions {
  command: "run" | "help";
  scenarioPath?: string;
  model?: string;
  baseUrl?: string;
  outputDirectory?: string;
  format: OutputFormat;
  captureRequest: boolean;
  dryRun: boolean;
  timeoutMs?: number;
  mode?: ScenarioMode;
  stream?: boolean;
  reasoningEffort?: ReasoningEffort;
  reasoningMode?: "pro";
}

interface ParsedResponse {
  payload: JsonValue | undefined;
  responseId: string | null;
  responseStatus: string | null;
  incompleteReason: string | null;
  error?: ErrorSummary;
}

interface RequestResult {
  record: RunCallRecord;
  payload: JsonValue | undefined;
  responseId: string | null;
  successful: boolean;
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseMode(value: string): ScenarioMode {
  if (value === "full-replay" || value === "full_replay") return "full-replay";
  if (value === "previous-response-id" || value === "previous_response_id") {
    return "previous-response-id";
  }
  throw new Error("--mode must be full-replay or previous-response-id");
}

function parseReasoningEffort(value: string): ReasoningEffort {
  const values: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  if (!values.includes(value as ReasoningEffort)) {
    throw new Error(
      "--reasoning-effort must be none, minimal, low, medium, high, or xhigh",
    );
  }
  return value as ReasoningEffort;
}

function takeValue(
  args: string[],
  index: number,
  name: string,
): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return [value, index + 1];
}

function parseArgs(args: string[]): CliOptions {
  const command = args[0] === undefined || args[0].startsWith("-")
    ? "run"
    : args[0];
  if (command === "help" || command === "--help" || command === "-h") {
    return {
      command: "help",
      format: DEFAULT_FORMAT,
      captureRequest: false,
      dryRun: false,
    };
  }
  if (command !== "run") throw new Error(`unknown command: ${command}`);

  const options: CliOptions = {
    command: "run",
    format: DEFAULT_FORMAT,
    captureRequest: false,
    dryRun: false,
  };
  const start = args[0] === "run" ? 1 : 0;
  for (let index = start; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--capture-request") {
      options.captureRequest = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--stream") {
      options.stream = true;
      continue;
    }
    if (argument === "--no-stream") {
      options.stream = false;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    let value: string | undefined = equalsIndex >= 0
      ? argument.slice(equalsIndex + 1)
      : undefined;
    if (value === undefined) {
      const result = takeValue(args, index, name);
      value = result[0];
      index = result[1];
    }
    switch (name) {
      case "--scenario":
        options.scenarioPath = value;
        break;
      case "--model":
        options.model = value;
        break;
      case "--base-url":
        options.baseUrl = value;
        break;
      case "--output-dir":
        options.outputDirectory = value;
        break;
      case "--format":
        if (value !== "human" && value !== "json") {
          throw new Error("--format must be human or json");
        }
        options.format = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseNumber(value, "--timeout-ms");
        break;
      case "--mode":
        options.mode = parseMode(value);
        break;
      case "--reasoning-effort":
        options.reasoningEffort = parseReasoningEffort(value);
        break;
      case "--reasoning-mode":
        if (value !== "pro") throw new Error("--reasoning-mode must be pro");
        options.reasoningMode = "pro";
        break;
      default:
        throw new Error(`unknown option: ${name}`);
    }
  }
  return options;
}

function usageText(): string {
  return `Usage:
  deno run --env-file=.env --allow-env=OPENAI_API_KEY,OPENAI_BASE_URL,RESPONSES_CACHE_LAB_DIR,HOME --allow-read --allow-write --allow-net tools/responses-cache-lab/main.ts run --scenario scenarios/example.json

Options:
  --scenario PATH|-       Scenario JSON path, or read JSON from stdin with '-'.
  --model ID               Override the default/scenario model (default: ${DEFAULT_MODEL}).
  --mode MODE              full-replay or previous-response-id.
  --reasoning-effort X     Set none, minimal, low, medium, high, or xhigh.
  --reasoning-mode pro     Use the GPT-5.6 pro reasoning mode when available.
  --base-url URL           API base URL; defaults to OPENAI_BASE_URL or OpenAI.
  --output-dir PATH        Private run directory root.
  --format human|json      Safe human summary or machine-readable manifest.
  --capture-request        Opt in to storing raw request JSON.
  --stream                 Override the scenario's stream setting.
  --no-stream              Disable streaming for this run.
  --timeout-ms N           Abort an individual request after N milliseconds.
  --dry-run                Validate the scenario without making a network call.
`;
}

async function readScenario(
  path: string,
): Promise<{ text: string; source: string }> {
  if (path === "-") {
    return {
      text: await new Response(Deno.stdin.readable).text(),
      source: "stdin",
    };
  }
  return { text: await Deno.readTextFile(path), source: path };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeError(value: unknown): ErrorSummary | undefined {
  if (!isJsonObject(value)) return undefined;
  const error = isJsonObject(value.error) ? value.error : value;
  const code = asString(error.code);
  const type = asString(error.type);
  const message = asString(error.message);
  const summary: ErrorSummary = {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(message ? { message: message.slice(0, 500) } : {}),
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function parsedResponse(payload: JsonValue | undefined): ParsedResponse {
  if (!isJsonObject(payload)) {
    return {
      payload,
      responseId: null,
      responseStatus: null,
      incompleteReason: null,
    };
  }
  const incompleteDetails = isJsonObject(payload.incomplete_details)
    ? payload.incomplete_details
    : undefined;
  return {
    payload,
    responseId: asString(payload.id),
    responseStatus: asString(payload.status),
    incompleteReason: asString(incompleteDetails?.reason),
    ...(safeError(payload) ? { error: safeError(payload) } : {}),
  };
}

function errorStatus(
  httpStatus: number | null,
  transportError: string | undefined,
  parseError: string | undefined,
  parsed: ParsedResponse,
): string | null {
  if (transportError) return "transport_error";
  if (parsed.error) {
    return parsed.error.code || parsed.error.type || "response_error";
  }
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return `http_${httpStatus}`;
  }
  if (parseError) return "malformed_response";
  return null;
}

function stopStatus(
  responseStatus: string | null,
  httpStatus: number | null,
  transportError: string | undefined,
): string | null {
  if (transportError) return "transport_error";
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return "http_error";
  }
  return responseStatus;
}

function rawFieldText(value: RawField): string {
  if (value.state === "missing") return "missing";
  if (value.state === "undefined") return "undefined";
  if (value.state === "null") return "null";
  return JSON.stringify(value.value);
}

function responseOutput(payload: JsonValue | undefined): JsonValue[] {
  if (!isJsonObject(payload) || !Array.isArray(payload.output)) return [];
  return payload.output.filter((item): item is JsonValue => {
    try {
      JSON.stringify(item);
      return true;
    } catch {
      return false;
    }
  });
}

async function resolveCallInput(call: ScenarioCall): Promise<JsonValue[]> {
  if (call.inputFile !== undefined) {
    const text = await Deno.readTextFile(call.inputFile);
    return [{
      role: "user",
      content: [{ type: "input_text", text }],
    }];
  }
  if (call.input === undefined) throw new Error(`call ${call.id} has no input`);
  return normalizeInput(call.input);
}

function functionCalls(payload: JsonValue | undefined): JsonObject[] {
  const calls: JsonObject[] = [];
  for (const item of responseOutput(payload)) {
    if (isJsonObject(item) && item.type === "function_call") calls.push(item);
  }
  return calls;
}

function deterministicToolOutput(value: JsonValue): string {
  if (
    isJsonObject(value) && typeof value.text === "string" &&
    value.repeat !== undefined
  ) {
    if (
      typeof value.repeat !== "number" ||
      !Number.isInteger(value.repeat) ||
      value.repeat < 0 ||
      value.repeat > 10_000_000
    ) {
      throw new Error(
        "deterministic tool text repeat must be an integer from 0 through 10000000",
      );
    }
    return value.text.repeat(value.repeat);
  }
  if (
    isJsonObject(value) && Object.prototype.hasOwnProperty.call(value, "output")
  ) {
    return typeof value.output === "string"
      ? value.output
      : JSON.stringify(value.output) ?? "";
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function toolOutputItems(calls: JsonObject[], scenario: Scenario): JsonValue[] {
  return calls.map((call) => {
    const name = asString(call.name);
    const callId = asString(call.call_id);
    if (!name || !callId) {
      throw new Error("function_call response item lacks name or call_id");
    }
    const configured = scenario.toolOutputs[name];
    if (configured === undefined) {
      throw new Error(
        `no deterministic output configured for function tool '${name}'`,
      );
    }
    return {
      type: "function_call_output",
      call_id: callId,
      output: deterministicToolOutput(configured),
    };
  });
}

function buildRequestBody(
  scenario: Scenario,
  input: JsonValue[],
  previousResponseId: string | null,
  mode: ScenarioMode,
): RequestBody {
  const body: RequestBody = {
    model: scenario.model,
    store: scenario.store,
    stream: scenario.stream,
    input,
  };
  if (scenario.instructions !== undefined) {
    body.instructions = scenario.instructions;
  }
  if (scenario.reasoning !== undefined) body.reasoning = scenario.reasoning;
  if (scenario.tools !== undefined) body.tools = scenario.tools;
  if (scenario.promptCacheKey !== undefined) {
    body.prompt_cache_key = scenario.promptCacheKey;
  }
  if (mode === "previous-response-id" && previousResponseId) {
    body.previous_response_id = previousResponseId;
  }
  return body;
}

function responseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("base URL must not contain embedded credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function makeRunId(): string {
  return crypto.randomUUID();
}

function configuredScenario(options: CliOptions, scenario: Scenario): Scenario {
  const reasoning =
    options.reasoningEffort === undefined && options.reasoningMode === undefined
      ? scenario.reasoning
      : {
        ...(scenario.reasoning ?? {}),
        ...(options.reasoningEffort === undefined
          ? {}
          : { effort: options.reasoningEffort }),
        ...(options.reasoningMode === undefined
          ? {}
          : { mode: options.reasoningMode }),
      };
  return {
    ...scenario,
    ...(options.model ? { model: options.model } : {}),
    ...(options.mode
      ? {
        mode: options.mode,
        store: options.mode === "previous-response-id",
      }
      : {}),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

async function run(
  options: CliOptions,
): Promise<RunManifest & { runDirectory: string }> {
  if (!options.scenarioPath) throw new Error("--scenario is required");
  const scenarioSource = await readScenario(options.scenarioPath);
  const scenario = configuredScenario(
    options,
    parseScenario(scenarioSource.text, scenarioSource.source),
  );
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || Deno.env.get("OPENAI_BASE_URL") || DEFAULT_BASE_URL,
  );
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: makeRunId(),
    scenarioId: scenario.id,
    model: scenario.model,
    mode: scenario.mode,
    baseUrl,
    startedAt: new Date().toISOString(),
    completedAt: null,
    dryRun: options.dryRun,
    calls: [],
    warnings: [],
  };
  const store = await createRunStore(
    options.outputDirectory || defaultOutputDirectory(),
    manifest,
  );
  const apiKey = options.dryRun ? undefined : Deno.env.get("OPENAI_API_KEY");
  if (!apiKey && !options.dryRun) {
    manifest.warnings.push(
      "OPENAI_API_KEY is not set; use --dry-run for offline validation",
    );
    await store.writeManifest();
    throw new Error(
      "OPENAI_API_KEY is required and must be supplied through the environment or .env",
    );
  }
  if (options.dryRun) {
    manifest.warnings.push("dry run: no HTTP requests were sent");
    manifest.completedAt = new Date().toISOString();
    await store.writeManifest();
    return { ...manifest, runDirectory: store.runDirectory };
  }

  const logicalInput: JsonValue[] = [];
  let previousResponseId: string | null = null;
  let ordinal = 0;
  let stop = false;

  const execute = async (
    callId: string,
    kind: RunCallRecord["kind"],
    input: JsonValue[],
  ): Promise<RequestResult> => {
    ordinal++;
    const body = buildRequestBody(
      scenario,
      input,
      previousResponseId,
      scenario.mode,
    );
    const requestBody = JSON.stringify(body);
    const requestBytes = new TextEncoder().encode(requestBody);
    const requestBodyPath = options.captureRequest
      ? await store.writeRequest(ordinal, requestBody)
      : undefined;
    const startTime = new Date().toISOString();
    const started = performance.now();
    const response = await postResponses(
      responseUrl(baseUrl),
      apiKey!,
      requestBody,
      scenario.stream,
      options.timeoutMs,
    );
    const elapsedMs = Math.round(performance.now() - started);
    const parsed = parsedResponse(response.payload);
    const rawResponsePath = response.responsePresent
      ? await store.writeRawResponse(ordinal, response.bytes, scenario.stream)
      : null;
    const status = stopStatus(
      parsed.responseStatus,
      response.httpStatus,
      response.transportError,
    );
    const record: RunCallRecord = {
      scenarioId: scenario.id,
      callOrdinal: ordinal,
      callId,
      kind,
      mode: scenario.mode,
      inputMode: scenario.mode === "full-replay" ? "full-replay" : "delta",
      previousResponseIdUsed: scenario.mode === "previous-response-id" &&
        Boolean(previousResponseId),
      reasoning: scenario.reasoning ?? null,
      startTime,
      elapsedMs,
      httpStatus: response.httpStatus,
      responseId: parsed.responseId,
      responseStatus: parsed.responseStatus,
      stopStatus: status,
      incompleteReason: parsed.incompleteReason,
      responseHeaders: response.headers,
      errorStatus: errorStatus(
        response.httpStatus,
        response.transportError,
        response.parseError,
        parsed,
      ),
      ...(parsed.error ? { error: parsed.error } : {}),
      responseParse: response.responseParse,
      rawResponsePath,
      requestBodyHash: sha256(requestBytes),
      requestByteSize: requestBytes.byteLength,
      ...(requestBodyPath ? { requestBodyPath } : {}),
      responseByteSize: response.bytes.byteLength,
      usage: extractUsageShape(response.payload),
    };
    manifest.calls.push(record);
    await store.writeManifest();
    const successful = response.httpStatus !== null &&
      response.httpStatus >= 200 &&
      response.httpStatus < 300 &&
      response.transportError === undefined &&
      response.parseError === undefined &&
      parsed.responseStatus === "completed";
    return {
      record,
      payload: response.payload,
      responseId: parsed.responseId,
      successful,
    };
  };

  const runToolRounds = async (
    parentCall: ScenarioCall,
    first: RequestResult,
  ): Promise<RequestResult> => {
    let current = first;
    for (let round = 0; round < scenario.maxToolRounds; round++) {
      const calls = functionCalls(current.payload);
      if (calls.length === 0) return current;
      const outputs = toolOutputItems(calls, scenario);
      logicalInput.push(...outputs);
      previousResponseId = current.responseId;
      current = await execute(
        `${parentCall.id}:tool-${round + 1}`,
        "deterministic-tool",
        scenario.mode === "full-replay" ? logicalInput : outputs,
      );
      logicalInput.push(...responseOutput(current.payload));
      if (!current.successful) return current;
    }
    throw new Error(
      `tool loop exceeded max_tool_rounds (${scenario.maxToolRounds})`,
    );
  };

  try {
    for (const [index, call] of scenario.calls.entries()) {
      if (index > 0) {
        const delayMs = call.delayMs ?? scenario.delayMs;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      const newInput = await resolveCallInput(call);
      logicalInput.push(...newInput);
      const result = await execute(
        call.id,
        "scenario",
        scenario.mode === "full-replay" ? logicalInput : newInput,
      );
      logicalInput.push(...responseOutput(result.payload));
      if (!result.successful) {
        manifest.warnings.push(
          `stopped after unsuccessful response at call ${result.record.callOrdinal}`,
        );
        stop = true;
        break;
      }
      const final = await runToolRounds(call, result);
      previousResponseId = final.responseId;
      if (!final.successful) {
        manifest.warnings.push(
          `stopped after unsuccessful tool response at call ${final.record.callOrdinal}`,
        );
        stop = true;
        break;
      }
    }
  } catch (error) {
    manifest.warnings.push(
      error instanceof Error ? error.message : String(error),
    );
    stop = true;
  }
  if (stop && manifest.calls.length < scenario.calls.length) {
    manifest.warnings.push(
      `scenario ended early after ${manifest.calls.length} HTTP call(s)`,
    );
  }
  manifest.completedAt = new Date().toISOString();
  await store.writeManifest();
  return { ...manifest, runDirectory: store.runDirectory };
}

function printHuman(manifest: RunManifest & { runDirectory: string }): void {
  console.log(`run: ${manifest.runId}`);
  console.log(`scenario: ${manifest.scenarioId}`);
  console.log(`model: ${manifest.model}`);
  console.log(`mode: ${manifest.mode}`);
  for (const call of manifest.calls) {
    const usage = call.usage;
    console.log(
      `call ${call.callOrdinal} ${call.callId}: http=${
        call.httpStatus ?? "-"
      } ` +
        `response=${call.responseStatus ?? "-"} stop=${
          call.stopStatus ?? "-"
        } ` +
        `cache=${usage.classification} cached_tokens=${
          rawFieldText(usage.cachedTokens)
        } ` +
        `input_tokens=${rawFieldText(usage.inputTokens)} output_tokens=${
          rawFieldText(usage.outputTokens)
        } ` +
        `elapsed_ms=${call.elapsedMs}`,
    );
  }
  for (const warning of manifest.warnings) console.log(`warning: ${warning}`);
  console.log(`run directory: ${manifest.runDirectory}`);
}

async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  if (options.command === "help") {
    console.log(usageText());
    return;
  }
  const result = await run(options);
  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      `responses-cache-lab: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}
