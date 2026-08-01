# Pi cache telemetry

A privacy-conscious Pi extension for investigating OpenAI prompt-cache misses during ordinary usage.

The extension observes OpenAI and OpenAI Codex model calls. It writes request fingerprints, normalized usage, response diagnostics, and Pi's exported OpenAI Codex WebSocket counters as NDJSON. It does not mutate requests.

## What it records

- Session, provider, model, thinking level, timing, and stop reason
- Normalized input, output, cache-read, cache-write, reasoning, and cost values
- Hashes and sizes for the logical provider payload, full current input, instructions, tools, and prompt-cache key
- Input-item counts, exact common-prefix comparisons, removed counts, and summaries only for newly added or changed suffix items
- Periodic or discontinuity-triggered checkpoints containing full input-item hashes for recovery after missing log events
- Response ID hashes and a small allowlist of non-sensitive HTTP response headers
- A sanitized WebSocket baseline plus per-call connection, full-context/delta, continuation, failure, and SSE-fallback deltas
- Structured provider diagnostics with an allowlist of safe transport details and omitted-key reporting

It does **not** record raw prompts, system instructions, tool definitions, tool arguments/results, images, response text, credentials, authorization headers, prompt-cache keys, response IDs, or full filesystem paths.

Logs default to:

```text
~/.pi/agent/diagnostics/cache-telemetry/<session-id>-<pid>.jsonl
```

Set `PI_CACHE_TELEMETRY_DIR` to use another directory. Files rotate at 50 MB and are created with mode `0600` where supported.

## Try it for one Pi process

From this repository:

```bash
pi -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts
```

An explicitly supplied extension loads for that process only.

## Enable it globally from this checkout

Pi can install a local package by path. This records the path in global Pi settings; it does not copy this directory:

```bash
pi install /Users/danclark/programming/frugal-tokens/tools/pi-cache-telemetry
```

Restart Pi after installation. While developing the extension, use `/reload` in an interactive Pi session to load changes from the same checkout.

Remove it with:

```bash
pi remove /Users/danclark/programming/frugal-tokens/tools/pi-cache-telemetry
```

## Project-only alternative

To load it only when Pi runs in this trusted repository:

```bash
pi install -l ./tools/pi-cache-telemetry
```

This adds the local package to `.pi/settings.json`. Project-local resources require project trust. Global installation is preferable for collecting organic usage across projects.

## Why this is an extension, not a skill

A Pi skill gives the model instructions and helper scripts when the model chooses to load it. It cannot observe every provider request. An extension runs lifecycle hooks automatically, so telemetry belongs in an extension. The directory is structured as a Pi package so it can later bundle a companion analysis skill if useful.

## Interpretation limits

- `before_provider_request` observes Pi's full logical payload. For cached WebSocket continuation, Pi converts that payload into `previous_response_id` plus an input delta afterward.
- Successful WebSocket responses do not pass through Pi's HTTP response hook.
- Pi's normalized `cacheRead: 0` still cannot distinguish an explicit provider `cached_tokens: 0` from omitted `input_tokens_details`.
- Hash equality establishes equality of the logical serialized structures seen by the extension, not provider-internal cache state.
