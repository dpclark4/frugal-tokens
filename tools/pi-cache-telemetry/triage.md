# Cache anomaly triage from an archive model-call ID

Use this runbook when the starting identifier comes from the local archive
SQLite database rather than from a Pi session filename. The expected input is
`model_calls.id`. Do not assume that this integer is a Pi session ID.

This runbook is for investigating a suspicious normalized `cacheRead == 0`
or a nonzero partial cache-read regression, especially a transient pattern such
as:

```text
warm cache -> zero/low read -> warm cache
```

Treat a lower but nonzero read as a regression rather than a proven cache miss.
It can still provide reproducibility and bug-reporting evidence when the raw
provider usage confirms the drop.

## Artifact locations

```bash
DB="${FRUGAL_TOKENS_ARCHIVE_DB:-$HOME/.local/share/frugal-tokens/archive.sqlite}"
SESSION_DIR="${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}"
TELEMETRY_DIR="${PI_CACHE_TELEMETRY_DIR:-$HOME/.pi/agent/diagnostics/cache-telemetry}"
WIRETAP_DIR="${PI_CODEX_WIRETAP_DIR:-$HOME/.pi/agent/diagnostics/cache-telemetry/wiretap}"
```

The normal telemetry file is named after the Pi session artifact:

```text
$TELEMETRY_DIR/<pi-session-basename>.jsonl
```

The raw WebSocket wiretap is optional and is only present if Pi was launched
with `run-with-codex-wiretap.sh`, the `pi-monkey` alias, or an equivalent
`NODE_OPTIONS=--import=...` preload. It is sensitive and can be very large.

## 1. Resolve the archive model-call ID

Set the integer from the archive database:

```bash
MODEL_CALL_ID=12345
```

Validate it before interpolating it into a SQLite query:

```bash
case "$MODEL_CALL_ID" in
  (''|*[!0-9]*) echo "MODEL_CALL_ID must be an integer" >&2; exit 1 ;;
 esac
```

Resolve the database row to the source artifact and local call identifier:

```bash
sqlite3 -header -column "$DB" "
  SELECT
    mc.id AS model_call_id,
    mc.source_call_id,
    mc.ordinal AS call_ordinal,
    t.id AS turn_row_id,
    t.ordinal AS turn_ordinal,
    ss.id AS source_session_id,
    ss.external_id AS external_session_id,
    ss.artifact_path,
    ss.availability,
    src.harness AS source_harness,
    src.kind AS source_kind,
    src.location AS source_location,
    s.title,
    mc.started_at,
    mc.completed_at,
    mc.cache_read_tokens,
    mc.uncached_input_tokens,
    mc.output_tokens,
    mc.reasoning_tokens,
    mc.finish_reason
  FROM model_calls mc
  JOIN turns t ON t.id = mc.turn_id
  JOIN source_sessions ss ON ss.id = t.session_id
  JOIN sources src ON src.id = ss.source_id
  JOIN sessions s ON s.source_session_id = ss.id
  WHERE mc.id = $MODEL_CALL_ID;
"
```

Important distinctions:

- `model_calls.id` is the archive model-call ID supplied to the agent.
- `source_session_id` is an archive database key, not necessarily the Pi UUID.
- `source_call_id` is the top-level `id` of the corresponding raw Pi JSONL
  message.
- `source_harness` must be `pi` for this runbook; the archive can also contain
  OpenCode, Claude Code, or Codex rows.
- For a directory source, `source_location` is the root and `artifact_path` is
  usually relative to it. A value such as `session:<id>` is not a filesystem
  path and belongs to a database-backed source.
- The first JSONL record with `type == "session"` contains the actual Pi
  session ID.

If the supplied ID is a `source_call_id` instead of `model_calls.id`, use the
same query with:

```sql
WHERE mc.source_call_id = '<source-call-id>'
```

If the row is missing or the artifact is unavailable, report that before
trying to infer a session from timestamps.

## 2. Derive the Pi session and telemetry paths

For a Pi directory source, copy the resolved `source_location`,
`artifact_path`, and `source_call_id` into shell variables. Because the archive
stores Pi artifact paths relative to the source directory, construct the path
explicitly:

```bash
SOURCE_HARNESS="pi"
SOURCE_ROOT="/Users/you/.pi/agent/sessions"
ARTIFACT_PATH="project/2026-01-01T00-00-00.000Z_<session-id>.jsonl"
SOURCE_CALL_ID="source-call-message-id"

if [[ "$SOURCE_HARNESS" != "pi" ]]; then
  echo "This is not a Pi archive row; stop or use the harness-specific runbook." >&2
  exit 1
fi

if [[ "$ARTIFACT_PATH" = /* ]]; then
  SESSION="$ARTIFACT_PATH"
else
  SESSION="$SOURCE_ROOT/$ARTIFACT_PATH"
fi

PI_SESSION_ID=$(jq -r '
  select(.type == "session") | .id
' "$SESSION" | head -n 1)

STEM=$(basename "$SESSION" .jsonl)
TELEMETRY="$TELEMETRY_DIR/$STEM.jsonl"

printf 'Pi session: %s\n' "$PI_SESSION_ID"
printf 'Session file: %s\n' "$SESSION"
printf 'Telemetry: %s\n' "$TELEMETRY"
```

If `SESSION` does not exist, verify the archive's `source_location`,
`artifact_path`, and `availability` before searching by timestamp. If the
source is database-backed or the artifact is unavailable, this Pi-specific
workflow cannot inspect the raw session.

If the session is persisted but the telemetry file has rotated, check:

```bash
ls -1 "$TELEMETRY_DIR"/"$STEM"*.jsonl 2>/dev/null
```

Run the privacy-safe session summary first:

```bash
bash tools/pi-session-debug.sh "$SESSION"
```

Inspect the exact archived source message without printing its potentially
large content:

```bash
jq -c --arg id "$SOURCE_CALL_ID" '
  select(.id == $id) |
  {
    id,
    parentId,
    timestamp,
    role: .message.role,
    provider: .message.provider,
    model: .message.model,
    responseId: .message.responseId,
    usage: .message.usage,
    stopReason: .message.stopReason,
    rawStopReason: .message.rawStopReason
  }
' "$SESSION"
```

## 3. Inspect the safe telemetry sequence

List provider requests and completions around the candidate:

```bash
jq -c '
  select(.event == "provider_request" or .event == "assistant_completion") |
  {
    event,
    sequence,
    timestamp,
    model,
    provider,
    usage,
    stopReason,
    responseIdHash,
    websocketDelta
  }
' "$TELEMETRY"
```

For a quick search for reported zero reads:

```bash
jq -c '
  select(.event == "assistant_completion"
    and (.usage.cacheRead // 0) == 0) |
  {
    sequence,
    timestamp,
    model,
    usage,
    stopReason,
    durationMs,
    diagnostics,
    websocketDelta
  }
' "$TELEMETRY"
```

Use the `sequence` on an `assistant_completion` to find the matching
`provider_request`. Examine:

- `payload.priorInputIsExactPrefix`
- `payload.commonPrefixItems`
- `payload.envelopeMatchesPrevious`
- `payload.inputItemCount` and `payload.inputSuffixItemCount`
- image/tool-output sizes and tagged input types
- the immediately preceding one or two request deltas: whether they were user
  input, `function_call_output`, or another item type, and their sizes; a large
  tool result followed by a small user message is a useful reproduction shape
- `websocketDelta.usedPreviousResponseId`
- `websocketDelta.counters.connectionsCreated`
- `websocketDelta.counters.connectionsReused`
- `websocketDelta.counters.deltaRequests`
- `websocketDelta.counters.websocketFailures`
- `websocketDelta.counters.sseFallbacks`

Compare the candidate with the immediately preceding and following calls. A
single zero surrounded by warm reads is evidence of a transient event, not
proof that the whole session was uncached.

## 4. Correlate the telemetry completion to the session message

The telemetry intentionally stores a hash of the provider response ID rather
than the raw ID. The session JSONL stores the raw `message.responseId`.

Extract and hash the response ID using the same JSON-string serialization used
by the extension:

```bash
RESPONSE_ID=$(jq -r --arg id "$SOURCE_CALL_ID" '
  select(.id == $id) | .message.responseId // empty
' "$SESSION")

RESPONSE_ID_HASH=$(node -e '
  const { createHash } = require("node:crypto");
  process.stdout.write(createHash("sha256")
    .update(JSON.stringify(process.argv[1]))
    .digest("hex"));
' "$RESPONSE_ID")

jq -c --arg hash "$RESPONSE_ID_HASH" '
  select(.event == "assistant_completion"
    and .responseIdHash == $hash)
' "$TELEMETRY"
```

The completion's `sequence` is the Pi-local request number. If there is no
response ID because the request failed or was aborted, correlate using
`timestamp`, `durationMs`, `source_call_id`, and the archive's start/end times.

## 5. Locate and inspect the optional raw wiretap

If the raw wiretap path was supplied with the report, use it directly. For a
globally enabled `pi-monkey` setup, search the default directory by the
session header:

```bash
for file in "$WIRETAP_DIR"/*.jsonl; do
  [[ -f "$file" ]] || continue
  if jq -e --arg sid "$PI_SESSION_ID" '
    select(.event == "construct"
      and (.headers["session-id"] == $sid
        or .headers["x-client-request-id"] == $sid))
  ' "$file" >/dev/null 2>&1; then
    printf '%s\n' "$file"
  fi
done
```

If no file matches, check files by timestamp. A wiretap may use a UUID request
ID rather than the Pi session ID when no session ID was available. If no
wiretap was active during the session, raw provider metadata cannot be
recovered retroactively.

List raw outgoing model calls:

```bash
jq -c '
  select(.event == "message"
    and .direction == "outgoing"
    and .frame.json.type == "response.create") |
  {
    sequence,
    timestamp,
    connectionId,
    model: .frame.json.model,
    previousResponseId: .frame.json.previous_response_id,
    inputItems: ((.frame.json.input // []) | length)
  }
' "$WIRETAP"
```

Find raw incoming frames associated with a known provider response ID:

```bash
jq -c --arg id "$RESPONSE_ID" '
  select(.event == "message" and .direction == "incoming") |
  select((.frame.json.response.id // .frame.json.response_id) == $id) |
  {
    sequence,
    timestamp,
    connectionId,
    eventType: .frame.json.type,
    responseId: (.frame.json.response.id // .frame.json.response_id),
    usage: (.frame.json.response.usage // .frame.json.usage),
    raw: .frame.raw
  }
' "$WIRETAP"
```

For a cache classification, inspect field presence rather than only the
normalized value:

```bash
jq -c --arg id "$RESPONSE_ID" '
  select(.event == "message" and .direction == "incoming") |
  select((.frame.json.response.id // .frame.json.response_id) == $id) |
  (.frame.json.response.usage // .frame.json.usage // {}) as $usage |
  ($usage.input_tokens_details // {}) as $details |
  {
    sequence,
    eventType: .frame.json.type,
    inputDetailsPresent: ($usage | has("input_tokens_details")),
    cachedTokensPresent: ($details | has("cached_tokens")),
    cachedTokens: $details.cached_tokens,
    usage: $usage
  }
' "$WIRETAP"
```

The raw `frame.raw` is sensitive. Do not paste it into an issue or agent
conversation unless necessary; summarize the relevant fields instead.

## 6. Classify the result

Use this evidence table:

| Evidence | Interpretation |
| --- | --- |
| Raw `cached_tokens` is present and `0` | Provider explicitly reported zero cached tokens. |
| `input_tokens_details` or `cached_tokens` is absent | Provider omitted cache metadata; Pi's normalized zero is ambiguous. |
| Raw `cached_tokens` is positive but telemetry says `cacheRead: 0` | Suspect Pi parsing, terminal-event selection, or correlation bug. |
| Raw `cached_tokens` is lower than the preceding and following calls, but remains positive | Record a partial cache-read regression; compare input/delta item types and sizes, tool outputs, and continuation state. |
| Request has `previous_response_id` and a small input delta | Continuation path was used; inspect the preceding response and connection. |
| No `previous_response_id` or full input was sent | This call was not using the cached WebSocket continuation path. |
| WebSocket failure/fallback is present | Treat transport failure separately from cache behavior. |
| Warm -> zero -> warm with normal transport | Strong evidence of a transient provider/cache event, not a permanent cold session. |

A report should state what is proven, what is only inferred, and whether a raw
wiretap was available. Never call a normalized `cacheRead: 0` a proven provider
cache miss without raw usage evidence.

## Expected handoff

A future agent should return a compact report containing:

```text
Archive model_call ID:
Archive source_call_id:
Pi session ID and artifact:
Telemetry artifact:
Wiretap artifact, or unavailable:
Pi turn/call:
Model:
Candidate timestamp:
Previous/current/following cache reads:
Raw cached_tokens state: explicit zero / omitted / positive / lower-than-neighbors / unavailable:
Previous/current request delta shapes and sizes (including tool outputs):
Continuation: previous_response_id and delta/full context:
Connection: created/reused:
Transport failures/fallbacks:
Conclusion:
Limitations:
```
