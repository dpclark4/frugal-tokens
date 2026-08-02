import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const WIRETAP_MARKER = Symbol.for("frugal-tokens.pi-codex-wiretap");
const wiretapFile = process.env.PI_CODEX_WIRETAP_FILE || (
  process.env.PI_CODEX_WIRETAP_DIR
    ? join(process.env.PI_CODEX_WIRETAP_DIR, `codex-websocket-${process.pid}.jsonl`)
    : undefined
);
const traceAllWebSockets = process.env.PI_CODEX_WIRETAP_ALL === "1";

if (
  wiretapFile &&
  typeof globalThis.WebSocket === "function" &&
  !globalThis[WIRETAP_MARKER]
) {
  // Pi's HTTP dispatcher calls undici.install(), which assigns a new
  // WebSocket constructor to globalThis after this preload runs. Keep the
  // delegate mutable so the wiretap survives that replacement.
  let NativeWebSocket = globalThis.WebSocket;
  let eventSequence = 0;
  let writeQueue = Promise.resolve();

  function ensureLogFile() {
    try {
      mkdirSync(dirname(wiretapFile), { recursive: true, mode: 0o700 });
      chmodSync(dirname(wiretapFile), 0o700);
      appendFileSync(wiretapFile, "", { encoding: "utf8", mode: 0o600 });
      chmodSync(wiretapFile, 0o600);
      return true;
    } catch (error) {
      console.error(
        `[pi-codex-wiretap] unable to prepare ${wiretapFile}: ${formatError(error)}`,
      );
      return false;
    }
  }

  const canWrite = ensureLogFile();

  function formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function isTraceTarget(url) {
    if (traceAllWebSockets) return true;
    const text = String(url);
    try {
      const parsed = new URL(text);
      return /codex|responses/i.test(parsed.pathname) ||
        /chatgpt\.com/i.test(parsed.hostname);
    } catch {
      return /codex|responses/i.test(text);
    }
  }

  function safeHeaders(options) {
    const headers = options?.headers;
    if (!headers) return {};
    let entries;
    try {
      entries = typeof headers.entries === "function"
        ? [...headers.entries()]
        : Object.entries(headers);
    } catch {
      return { "<unreadable>": "<omitted>" };
    }
    return Object.fromEntries(entries.map(([name, value]) => {
      const lower = String(name).toLowerCase();
      const sensitive = /authorization|cookie|token|api[-_]?key|secret|account[-_]?id/.test(lower);
      return [String(name), sensitive ? "<redacted>" : String(value)];
    }));
  }

  async function decodeData(data) {
    if (typeof data === "string") {
      return { text: data, bytes: Buffer.byteLength(data) };
    }
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      return {
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
      };
    }
    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return {
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
      };
    }
    if (data && typeof data.arrayBuffer === "function") {
      const bytes = new Uint8Array(await data.arrayBuffer());
      return {
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
      };
    }
    const text = String(data);
    return { text, bytes: Buffer.byteLength(text) };
  }

  function parsedFrame(text) {
    try {
      return { json: JSON.parse(text) };
    } catch {
      return { text };
    }
  }

  function enqueue(record, data) {
    if (!canWrite) return;
    const sequence = ++eventSequence;
    writeQueue = writeQueue.then(async () => {
      let frame;
      if (data !== undefined) {
        const decoded = await decodeData(data);
        frame = {
          bytes: decoded.bytes,
          ...parsedFrame(decoded.text),
          raw: decoded.text,
        };
      }
      const line = {
        schemaVersion: 1,
        sequence,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        ...record,
        ...(frame ? { frame } : {}),
      };
      try {
        appendFileSync(wiretapFile, `${JSON.stringify(line)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        console.error(`[pi-codex-wiretap] write failed: ${formatError(error)}`);
      }
    }).catch((error) => {
      console.error(`[pi-codex-wiretap] frame handling failed: ${formatError(error)}`);
    });
  }

  let connectionSequence = 0;

  class DebugWebSocket {
    #socket;
    #trace;
    #connectionId;
    #url;

    constructor(url, protocolsOrOptions) {
      this.#url = String(url);
      this.#trace = isTraceTarget(this.#url);
      this.#connectionId = ++connectionSequence;
      this.#socket = new NativeWebSocket(url, protocolsOrOptions);

      if (this.#trace) {
        enqueue({
          event: "construct",
          connectionId: this.#connectionId,
          url: this.#url,
          headers: safeHeaders(protocolsOrOptions),
        });

        this.#socket.addEventListener("open", () => {
          enqueue({
            event: "open",
            connectionId: this.#connectionId,
            url: this.#url,
          });
        });
        this.#socket.addEventListener("message", (message) => {
          enqueue({
            event: "message",
            direction: "incoming",
            connectionId: this.#connectionId,
            url: this.#url,
          }, message.data);
        });
        this.#socket.addEventListener("error", (error) => {
          enqueue({
            event: "error",
            connectionId: this.#connectionId,
            url: this.#url,
            error: {
              message: typeof error?.message === "string" ? error.message : undefined,
              type: error?.type,
            },
          });
        });
        this.#socket.addEventListener("close", (close) => {
          enqueue({
            event: "close",
            connectionId: this.#connectionId,
            url: this.#url,
            close: {
              code: close?.code,
              reason: close?.reason,
              wasClean: close?.wasClean,
            },
          });
        });
      }
    }

    addEventListener(...args) {
      return this.#socket.addEventListener(...args);
    }

    removeEventListener(...args) {
      return this.#socket.removeEventListener(...args);
    }

    dispatchEvent(...args) {
      return this.#socket.dispatchEvent(...args);
    }

    send(data) {
      if (this.#trace) {
        enqueue({
          event: "message",
          direction: "outgoing",
          connectionId: this.#connectionId,
          url: this.#url,
        }, data);
      }
      return this.#socket.send(data);
    }

    close(code, reason) {
      if (this.#trace) {
        enqueue({
          event: "close_requested",
          direction: "outgoing",
          connectionId: this.#connectionId,
          url: this.#url,
          close: { code, reason },
        });
      }
      return this.#socket.close(code, reason);
    }

    get binaryType() {
      return this.#socket.binaryType;
    }

    set binaryType(value) {
      this.#socket.binaryType = value;
    }

    get bufferedAmount() {
      return this.#socket.bufferedAmount;
    }

    get extensions() {
      return this.#socket.extensions;
    }

    get onclose() {
      return this.#socket.onclose;
    }

    set onclose(value) {
      this.#socket.onclose = value;
    }

    get onerror() {
      return this.#socket.onerror;
    }

    set onerror(value) {
      this.#socket.onerror = value;
    }

    get onmessage() {
      return this.#socket.onmessage;
    }

    set onmessage(value) {
      this.#socket.onmessage = value;
    }

    get onopen() {
      return this.#socket.onopen;
    }

    set onopen(value) {
      this.#socket.onopen = value;
    }

    get protocol() {
      return this.#socket.protocol;
    }

    get readyState() {
      return this.#socket.readyState;
    }

    get url() {
      return this.#socket.url;
    }
  }

  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(DebugWebSocket, name, {
      configurable: false,
      enumerable: true,
      value: NativeWebSocket[name],
      writable: false,
    });
  }

  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: webSocketDescriptor?.configurable ?? true,
    enumerable: webSocketDescriptor?.enumerable ?? true,
    get() {
      return DebugWebSocket;
    },
    set(value) {
      if (value !== DebugWebSocket) NativeWebSocket = value;
    },
  });
  globalThis[WIRETAP_MARKER] = true;

  enqueue({
    event: "wiretap_start",
    file: wiretapFile,
    nativeWebSocket: String(NativeWebSocket.name || "WebSocket"),
    cwd: process.cwd(),
  });
}
