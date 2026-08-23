import { isJsonObject, isJsonValue, type JsonValue } from "./types.ts";

type ParsedResponse = {
  payload: JsonValue | undefined;
  parseError?: string;
};

const SAFE_RESPONSE_HEADERS = new Set([
  "cf-ray",
  "openai-processing-ms",
  "openai-request-id",
  "server-timing",
  "x-request-id",
]);

const TERMINAL_STREAM_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export interface RawHttpResult {
  httpStatus: number | null;
  statusText: string | null;
  responsePresent: boolean;
  headers: Record<string, string>;
  bytes: Uint8Array;
  text: string;
  payload: JsonValue | undefined;
  responseParse: "json" | "sse" | "invalid" | "not-present";
  parseError?: string;
  transportError?: string;
}

function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => SAFE_RESPONSE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function parseJson(text: string): ParsedResponse {
  if (text.length === 0) {
    return { payload: undefined, parseError: "empty response body" };
  }
  try {
    const payload: unknown = JSON.parse(text);
    return isJsonValue(payload)
      ? { payload }
      : { payload: undefined, parseError: "response body is not JSON data" };
  } catch (error) {
    return { payload: undefined, parseError: errorText(error) };
  }
}

function parseSse(text: string): ParsedResponse {
  const events: JsonValue[] = [];
  const parseErrors: string[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      const event: unknown = JSON.parse(data);
      if (!isJsonValue(event)) throw new Error("event is not JSON data");
      events.push(event);
    } catch (error) {
      parseErrors.push(errorText(error));
    }
  };

  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  let payload: JsonValue | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!isJsonObject(event) || typeof event.type !== "string") continue;
    if (TERMINAL_STREAM_EVENTS.has(event.type)) {
      payload = isJsonObject(event.response) ? event.response : event;
      break;
    }
  }
  return {
    payload,
    ...(parseErrors.length > 0
      ? { parseError: `invalid SSE event JSON: ${parseErrors[0]}` }
      : payload === undefined
      ? { parseError: "stream ended without a terminal response event" }
      : {}),
  };
}

export async function postResponses(
  url: string,
  apiKey: string,
  body: string,
  stream: boolean,
  timeoutMs?: number,
): Promise<RawHttpResult> {
  const controller = new AbortController();
  const timeout = timeoutMs !== undefined && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const parsed = stream ? parseSse(text) : parseJson(text);
    return {
      httpStatus: response.status,
      statusText: response.statusText || null,
      responsePresent: true,
      headers: safeHeaders(response.headers),
      bytes,
      text,
      payload: parsed.payload,
      responseParse: stream
        ? "sse"
        : parsed.payload === undefined
        ? "invalid"
        : "json",
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  } catch (error) {
    return {
      httpStatus: response?.status ?? null,
      statusText: response?.statusText || null,
      responsePresent: false,
      headers: response ? safeHeaders(response.headers) : {},
      bytes: new Uint8Array(),
      text: "",
      payload: undefined,
      responseParse: "not-present",
      transportError: errorText(error),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
