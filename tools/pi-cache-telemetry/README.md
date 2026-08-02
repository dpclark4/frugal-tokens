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
~/.pi/agent/diagnostics/cache-telemetry/<pi-session-basename>.jsonl
```

Persisted sessions use the same basename as their Pi session JSONL, making the two files directly match across directories. Ephemeral sessions fall back to `<session-id>-<pid>.jsonl`. Set `PI_CACHE_TELEMETRY_DIR` to use another directory. Files rotate at 50 MB and are created with mode `0600` where supported.

## Investigation primer

For a future-agent runbook that starts with an archive SQLite `model_calls.id`
and resolves the Pi session, telemetry, and optional raw wiretap artifacts, see
[`triage.md`](./triage.md).

The target is a **transient per-request bust**, not a permanently cold session:

```text
warm cache -> low/zero-read call -> cache rebuild -> warm cache
```

Analyze individual model calls. A turn or session percentage can hide the
cost-bearing call.

### Locate the matching artifacts

A persisted Pi session and its telemetry file have the same basename:

```bash
SESSION="$HOME/.pi/agent/sessions/<project>/<session>.jsonl"
STEM="$(basename "$SESSION" .jsonl)"
TELEMETRY="$HOME/.pi/agent/diagnostics/cache-telemetry/$STEM.jsonl"
DB="$HOME/.local/share/frugal-tokens/archive.sqlite"

bash tools/pi-session-debug.sh "$SESSION"
```

The archive maps the session artifact to a `source_session_id`, then maps each
completed model call to the raw Pi assistant message through `source_call_id`:

```bash
sqlite3 -header -column "$DB" \
  "SELECT ss.id AS source_session_id, ss.artifact_path, s.title
   FROM source_sessions ss
   LEFT JOIN sessions s ON s.source_session_id = ss.id
   WHERE ss.artifact_path LIKE '%' || '$STEM.jsonl';"

SOURCE_SESSION_ID=1100  # replace with the result above
sqlite3 -header -column "$DB" \
  "SELECT t.ordinal AS turn, mc.ordinal AS call, mc.id,
          mc.source_call_id, mc.started_at, mc.completed_at,
          mc.uncached_input_tokens, mc.cache_read_tokens,
          mc.images, mc.finish_reason
   FROM model_calls mc
   JOIN turns t ON t.id = mc.turn_id
   WHERE t.session_id = $SOURCE_SESSION_ID
   ORDER BY mc.started_at;"
```

`source_call_id` is the top-level `id` of the corresponding raw JSONL message.
Find its line and byte offset without printing a potentially huge tool/image
record:

```bash
CALL_ID=9624d1ef  # replace with source_call_id
python3 - "$SESSION" "$CALL_ID" <<'PY'
import json, sys
path, wanted = sys.argv[1:]
offset = 0
with open(path, "rb") as stream:
    for line_no, line in enumerate(stream, 1):
        try:
            record = json.loads(line)
        except Exception:
            record = {}
        if record.get("id") == wanted:
            print(f"line={line_no} byte_offset={offset} bytes={len(line)}")
        offset += len(line)
PY
```

JSONL records are one line each, but a single record can be hundreds of KB.
Use the line/offset to target inspection rather than loading the whole record
into the terminal. The archive can lag a live session; raw JSONL and telemetry
may contain later pending or aborted requests.

### Read the telemetry sequence

```bash
jq -r '
  select(.event == "provider_request" or .event == "assistant_completion") |
  [.event, .sequence, .timestamp,
   (.payload.bytes // ""), (.usage.input // ""), (.usage.cacheRead // ""),
   (.stopReason // ""),
   (.websocketDelta.usedPreviousResponseId // ""),
   (.websocketDelta.counters.websocketFailures // "")] | @tsv
' "$TELEMETRY"
```

For a candidate request, inspect these fields:

- `priorInputIsExactPrefix`, `commonPrefixItems`, and `envelopeMatchesPrevious`:
  whether Pi appended to the same logical history without truncation or a
  settings/instructions/tools change.
- `usedPreviousResponseId`, `deltaRequests`, `fullContextRequests`, and
  `connectionsCreated`/`connectionsReused`: the actual continuation path.
- `diagnostics`, `stopReason`, `durationMs`, and missing completions: transport
  failures, hangs, and user aborts are separate evidence from cache usage.
- `input_image`, suffix item sizes, and payload bytes: image or large tool
  output makes a useful event a confounded rather than clean reproduction.
- The preceding/current/following `cacheRead` values: look for
  `warm -> bust -> warm`; recovery confirms a costly transient bust but does
  not make the bust call cheap.

A zero in Pi's normalized `cacheRead` is still ambiguous: the provider may have
reported `cached_tokens: 0`, omitted cache details, or Pi may have normalized
missing metadata to zero. The telemetry extension records fingerprints and
sizes, not raw prompts or raw provider usage fields.

## Try it for one Pi process

From this repository:

```bash
pi -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts
```

An explicitly supplied extension loads for that process only.

## Capture raw Codex WebSocket frames locally

For a local, intentionally verbose investigation, use the WebSocket wiretap:

```bash
tools/pi-cache-telemetry/run-with-codex-wiretap.sh \
  -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts
```

The wrapper uses `NODE_OPTIONS=--import=...` to replace Node's global
`WebSocket` before Pi loads. It logs the actual outgoing `response.create`
frames and incoming terminal response frames, including the raw `usage` object,
so it can distinguish an explicit `cached_tokens: 0` from omitted cache details.
It also logs open, close, error, and full request/response frame data. The
payloads contain prompts, tool arguments/results, model output, and possibly
images; this is a local sensitive capture. Authorization, cookies, API keys,
and account IDs in the handshake headers are redacted, and the log is created
with mode `0600`.

The default log path is printed by the wrapper and is under
`~/.pi/agent/diagnostics/cache-telemetry/wiretap/`. Set
`PI_CODEX_WIRETAP_FILE` for an explicit path. The wiretap is process-local and
does not modify the installed Pi packages.

To inspect terminal usage events afterward:

```bash
jq -c '\
  select(.event == "message" and .direction == "incoming") |
  select(.frame.json.type == "response.done" or
         .frame.json.type == "response.completed" or
         .frame.json.type == "response.incomplete") |
  {sequence, timestamp, type: .frame.json.type,
   status: .frame.json.response.status,
   usage: .frame.json.response.usage}' \
  /path/to/codex-websocket.jsonl
```

This captures the raw provider frame that the normal extension lifecycle does
not expose for successful WebSocket responses.

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

## Instrumentation overhead and causality

The extension is observational: its `before_provider_request` handler returns no
replacement payload, and the Pi extension runner catches handler errors. It
does, however, synchronously serialize/hash the logical payload and append small
NDJSON records. Large images or tool results can therefore add measurable CPU
or filesystem latency, so an enabled/disabled A/B comparison is still useful.
The extension should be treated as a possible source of short local overhead,
not assumed to explain a provider request that has already been logged and then
waits for minutes without a response.

## Interpretation limits

- `before_provider_request` observes Pi's full logical payload. For cached WebSocket continuation, Pi converts that payload into `previous_response_id` plus an input delta afterward.
- Successful WebSocket responses do not pass through Pi's HTTP response hook.
- Pi's normalized `cacheRead: 0` still cannot distinguish an explicit provider `cached_tokens: 0` from omitted `input_tokens_details`.
- Hash equality establishes equality of the logical serialized structures seen by the extension, not provider-internal cache state.
