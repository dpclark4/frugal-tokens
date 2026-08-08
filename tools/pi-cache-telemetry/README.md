# Pi cache telemetry investigation guide

Use this guide to investigate transient OpenAI Codex prompt-cache regressions in
Pi. It is written for the common handoff where the only starting artifact is a
raw WebSocket wiretap path.

## 1. What counts as a bust

In this investigation, **bust** means an unexpected cache-read dip affecting
one completed model call:

```text
comparable warm call
-> zero or lower cached_tokens on one call
-> warm recovery on the following call
```

- **Full bust:** raw provider `cached_tokens` is present and equals `0`.
- **Partial bust:** raw `cached_tokens` remains positive but is unexpectedly
  lower than the neighboring comparable calls.
- **Candidate bust:** the dip lacks either a warm predecessor, a recovery call,
  or raw provider usage needed to classify it confidently.
- A baseline zero is not a bust. Two initial calls reporting `0 -> 0` establish
  no unexpected dip.
- Consecutive cold calls are a different pattern from the cases documented
  here.
- “Bust” describes an observation, not a proven cause. Do not claim that the
  provider permanently invalidated or destroyed a cache entry.

Every established bust below affects one model call and then recovers. That is
an empirical property of the captures so far, not a claim that all cache
failures behave this way.

## 2. Current conclusions

The evidence supports at least two distinct patterns:

1. **Transport-associated bust:** a WebSocket continuation fails, Pi retries
   full context over SSE, the retry has a zero/low normalized read, and the
   next call recovers.
2. **Healthy-continuation bust:** the same WebSocket and
   `previous_response_id` path remain healthy, but raw provider
   `cached_tokens` dips for one call around tool-heavy context growth and then
   recovers.

Large or multi-item tool outputs are the strongest shared context shape so far.
An image is not required: a text-only phase reproduced `8704 -> 0 -> 26112`.
The sequence resembles delayed cache eligibility or publication, but that is a
hypothesis, not proof.

Stable client-visible inputs do not guarantee stable reads. Captures have shown
busts despite exact logical prefixes, unchanged tools/instructions/settings,
unchanged prompt-cache-key fingerprints, and healthy continuations.

## 3. Start with a wiretap path

A wiretap contains raw prompts, tool arguments and results, model output, and
possibly images. Keep it local. The commands below project metadata without
printing raw frame bodies.

### 3.1 Set the artifact and find the Pi session

```bash
WIRETAP="/path/to/codex-websocket.jsonl"

PI_SESSION_ID=$(jq -r '
  select(.event == "construct")
  | .headers["session-id"] // .headers["x-client-request-id"] // empty
' "$WIRETAP" | head -n 1)

printf 'Pi session ID: %s\n' "$PI_SESSION_ID"

find "$HOME/.pi/agent/sessions" \
  -type f -name "*${PI_SESSION_ID}*.jsonl" -print

find "$HOME/.pi/agent/diagnostics/cache-telemetry" \
  -maxdepth 1 -type f -name "*${PI_SESSION_ID}*.jsonl" -print
```

If no session ID is present, use the wiretap timestamps and PID. A wiretap may
contain repeated `wiretap_start` records; the target `construct` event is the
one for `/backend-api/codex/responses`.

Typical artifacts are:

```text
Pi session:
~/.pi/agent/sessions/<project>/<timestamp>_<pi-session-id>.jsonl

Privacy-safe telemetry:
~/.pi/agent/diagnostics/cache-telemetry/<same-session-basename>.jsonl

Raw wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-*.jsonl

Archive database:
~/.local/share/frugal-tokens/archive.sqlite
```

### 3.2 Print the raw cache-read sequence

```bash
jq -r '
  select(.event == "message" and .direction == "incoming")
  | select(
      .frame.json.type == "response.done"
      or .frame.json.type == "response.completed"
      or .frame.json.type == "response.incomplete"
    )
  | (.frame.json.response.usage // .frame.json.usage // {}) as $usage
  | ($usage.input_tokens_details // {}) as $details
  | [
      .timestamp,
      .connectionId,
      .frame.json.type,
      ($usage.input_tokens // ""),
      (if $details | has("cached_tokens")
       then $details.cached_tokens
       else "omitted"
       end),
      (.frame.json.response.id // .frame.json.response_id // "")
    ]
  | @tsv
' "$WIRETAP"
```

Interpret field presence before interpreting the number:

| Raw state | Meaning |
| --- | --- |
| `cached_tokens` present and `0` | Provider explicitly reported zero cached tokens |
| `cached_tokens` present and positive | Provider reported a full or partial read |
| `cached_tokens` omitted | Pi may normalize the missing field to zero; raw miss is unproven |
| Positive -> zero/low -> positive | Candidate one-call bust; compare request and transport state |
| Initial `0` or `0 -> 0` | Baseline/cold sequence, not a bust by itself |

### 3.3 Inspect outgoing continuation shape

```bash
jq -c '
  select(.event == "message"
    and .direction == "outgoing"
    and .frame.json.type == "response.create")
  | {
      sequence,
      timestamp,
      connectionId,
      model: .frame.json.model,
      previousResponseIdPresent:
        (.frame.json.previous_response_id != null),
      inputItems: ((.frame.json.input // []) | length),
      inputItemTypes:
        [(.frame.json.input // [])[] | .type // .role // "unknown"]
    }
' "$WIRETAP"
```

A `previous_response_id` with a small input delta confirms the continuation
path. It does not prove the provider found a cache entry.

### 3.4 Inspect connection health

```bash
jq -c '
  select(.event == "construct"
    or .event == "open"
    or .event == "error"
    or .event == "close"
    or .event == "close_requested")
  | {
      sequence,
      timestamp,
      event,
      connectionId,
      url,
      error,
      close
    }
' "$WIRETAP"
```

Record abnormal close code `1006`, `wasClean`, reconnections, and whether the
candidate and neighboring calls used the same connection. Absence of a
terminal frame can indicate a failed or aborted attempt that never became an
archived model call.

### 3.5 Compare privacy-safe Pi telemetry

```bash
TELEMETRY="/path/from-the-session-id-search.jsonl"

jq -c '
  select(.event == "provider_request" or .event == "assistant_completion")
  | {
      event,
      sequence,
      timestamp,
      model,
      payload,
      usage,
      stopReason,
      durationMs,
      diagnostics,
      websocketDelta
    }
' "$TELEMETRY"
```

For the preceding, candidate, and following calls, compare:

- `payload.priorInputIsExactPrefix`
- `payload.commonPrefixItems` and `inputSuffixItems`
- `payload.envelopeMatchesPrevious`
- instruction, tool, and prompt-cache-key hashes
- image and function-output types and byte sizes
- `websocketDelta.usedPreviousResponseId`
- connection creation/reuse and delta/full-context counts
- WebSocket failures and SSE fallbacks

The extension sees Pi’s full logical payload before Pi converts it to a
WebSocket delta. The wiretap sees the actual transport frames. Use both views.

### 3.6 Correlate a raw response with the Pi session

The telemetry hashes provider response IDs; the Pi session and wiretap retain
the raw ID. Given a raw response ID from the usage sequence:

```bash
RESPONSE_ID="resp_..."
SESSION="/path/to/pi-session.jsonl"

SOURCE_CALL_ID=$(jq -r --arg response "$RESPONSE_ID" '
  select(.message.responseId == $response) | .id
' "$SESSION" | head -n 1)

RESPONSE_ID_HASH=$(node -e '
  const { createHash } = require("node:crypto");
  process.stdout.write(createHash("sha256")
    .update(JSON.stringify(process.argv[1]))
    .digest("hex"));
' "$RESPONSE_ID")

printf 'Pi source call ID: %s\n' "$SOURCE_CALL_ID"

jq -c --arg hash "$RESPONSE_ID_HASH" '
  select(.event == "assistant_completion"
    and .responseIdHash == $hash)
' "$TELEMETRY"
```

Run the privacy-safe session summary rather than printing large session lines:

```bash
bash tools/pi-session-debug.sh "$SESSION"
```

## 4. Evidence layers

| Layer | Unique value | Important limit |
| --- | --- | --- |
| Cache telemetry extension | Full logical payload fingerprints, exact-prefix comparisons, session correlation, normalized usage, internal continuation/fallback counters, SSE visibility | Normalized zero cannot prove raw provider zero |
| WebSocket wiretap | Actual deltas, raw usage field presence, response IDs, and socket lifecycle | WebSocket-only, sensitive, and potentially very large |
| Pi session | Durable message/tool ordering and raw response IDs | Failed attempts may be absent; content can be sensitive |
| Frugal Tokens archive | Turn/call mapping, normalized tokens, and costs | Can lag live activity and omits some failed attempts |
| mitmproxy | Controlled interruption and independent network-flow inspection | Changes the network path; cannot attribute a natural failure to OpenAI |

For a strong healthy-continuation report, establish all of the following:

1. A comparable warm predecessor.
2. Raw `cached_tokens` present and lower on exactly one call.
3. Recovery on the following comparable call.
4. Exact logical prefix and unchanged envelope, or a precise account of the
   change.
5. `previous_response_id` and delta continuation state.
6. Connection and fallback state.
7. The newly added input item types, counts, and approximate sizes.

## 5. Controlled reproductions

### 5.1 Launch

Run each independent trial in a fresh Pi process with `gpt-5.6-sol`, medium
reasoning, and no repository edits:

```bash
tools/pi-cache-telemetry/run-with-codex-wiretap.sh \
  -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts
```

The wrapper preloads `codex-wiretap.mjs` through `NODE_OPTIONS`, prints the raw
wiretap path, and then starts Pi. The monkeypatch is process-local and does not
modify installed Pi packages.

### 5.2 Hold these variables fixed

- model and reasoning level
- initial instructions and phase-boundary wording
- tool schema and tool ordering
- sequential versus parallel calls
- fixture item count, token count, media type, and approximate encoded size
- delay between tool completion and the next model call
- WebSocket versus fallback transport

Use fresh content and paths between independent trials while preserving those
properties. Record procedural deviations separately from cache behavior.

### 5.3 Minimal healthy-continuation matrix

The Case 003A miss occurred on the request after an image-bearing tool output
followed by one text tool output. The second listed text read had not yet caused
the miss.

| Variant | Sequential tool-output shape | Question |
| --- | --- | --- |
| A | image -> medium text | Minimal candidate |
| B | image -> medium text -> medium text | Original shape |
| C | size-matched text -> medium text | Is media type necessary? |
| D | image only | Is the transition necessary? |
| E | medium text -> image | Does order matter? |
| F | medium text -> medium text | Text-only control |
| G | image -> tiny/medium/large text | Is there a text-size threshold? |

Start with A, C, E, and F. Repeat each variant in fresh processes, ideally at
least five times. Compare immediate continuation with fixed 5-second and
30-second delays. A timing effect would be consistent with delayed provider
cache eligibility, but would not prove it.

Gated user turns improve compliance but add user-message boundaries. Keep gated
and single-turn scripted trials as separate experiment classes.

### 5.4 Original three-phase recipe

Use three gated user turns. The initial instruction defines all phases but says
to execute only Phase 1 and reply `DONE`. Send exactly `PHASE 2 ONLY`, then
`PHASE 3 ONLY`.

- **Phase 1:** read one fresh image, then two medium text fixtures. The observed
  image tool result was about 390 KB; text results were about 9–13 KB each.
- **Phase 2:** read three text fixtures producing roughly 50 KB, 16 KB, and
  11 KB results. This text-only phase produced a classified full bust.
- **Phase 3:** read four text fixtures producing roughly 11 KB, 9 KB, 20 KB,
  and 13 KB results. This tests recovery after another multi-output batch.

Record raw usage after every model call. A zero after a baseline is explicit
provider zero when the field is present, but it is not a comparable bust.

## 6. Established cases

| Case | Cache sequence | Transport | Context near dip | Classification |
| --- | --- | --- | --- | --- |
| 001 | `111104 -> 0 -> 112128` | WebSocket failed; full-context SSE retry | Interrupted function-call stream | Transport-associated candidate; raw zero unavailable on SSE |
| 002 | `3584 -> 2560 -> 8704` | Healthy same-socket continuation | Large tool output followed by small user input | Raw partial one-call bust |
| 003A | `1536 -> 0 -> 4608` | Healthy same-socket continuation | Image tool output, then text tool output | Raw full one-call bust |
| 003B | `8704 -> 0 -> 26112` | Healthy continuation | Large text-only multi-output phase | Raw full one-call bust; image not required |

### Case 001 — WebSocket failure and SSE retry

**Date:** 2026-08-03  
**Model:** `gpt-5.6-sol`  
**Pi session:** `019fc515-9dc2-78ed-ae36-95342bb646ae`  
**Archive session/call:** `1110` / `83288`  
**Archive source call:** `b69dc57f`  
**Pi turn/call:** turn 4, archive call 11

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-03T00-45-56-035Z_019fc515-9dc2-78ed-ae36-95342bb646ae.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-03T00-45-56-035Z_019fc515-9dc2-78ed-ae36-95342bb646ae.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-03T00-45-55Z-90637.jsonl
```

A warm continuation streamed 1,848 function-call argument delta frames but no
terminal event. The socket errored and closed with code `1006`, empty reason,
and `wasClean=false`. Pi recorded failure after message-stream start and
activated fallback. The completed SSE retry sent full logical input (163 items,
940,250 bytes), retained exact prefix/envelope fingerprints, reported
normalized `cacheRead=0`, and cost `$0.684705`. The next call read 112,128 cached
tokens.

The wiretap cannot prove raw zero for the SSE retry. Close code `1006` also does
not identify whether the provider edge, an intermediary, or the local runtime
caused the disconnect.

### Case 002 — Healthy partial bust

**Date:** 2026-08-03  
**Model:** `gpt-5.6-sol`  
**Pi session:** `019fc7d7-2beb-7a17-8d89-c8f06c32e663`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-03T13-36-35-307Z_019fc7d7-2beb-7a17-8d89-c8f06c32e663.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-03T13-36-35-307Z_019fc7d7-2beb-7a17-8d89-c8f06c32e663.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-03T13-36-34Z-99472.jsonl
```

Raw cache reads on calls 3–5 were `1536`, `3584`, and `2560` despite call 5
having slightly more total input than call 4 (`8947` versus `8771`). The next
call recovered to `8704`. The dip request carried one 304-byte user text delta
after tool outputs of about 3.4 KB and 20.4 KB. Prefix and envelope were stable;
all requests used `previous_response_id` on one healthy socket with no fallback.

### Case 003 — Healthy full busts

**Date:** 2026-08-05  
**Model:** `gpt-5.6-sol`

**Run A:**

- Pi session: `019fd1f1-a3c0-7645-bce4-95811c5a5fb2`
- Archive session/call: `1153` / `127670`
- Archive source call: `decf7003`
- Pi turn/call: turn 1, call 3
- Sequence: `0 -> 1536 -> 0 -> 4608 -> 7680 -> 8704`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-05T12-41-42-080Z_019fd1f1-a3c0-7645-bce4-95811c5a5fb2.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-05T12-41-42-080Z_019fd1f1-a3c0-7645-bce4-95811c5a5fb2.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-05T12-41-41Z-44273.jsonl
```

Call 2 contained a 389,654-byte image-bearing `function_call_output`. Call 3
added one 7,004-byte text `function_call_output` and raw usage explicitly
reported zero. It used `previous_response_id`, an exact logical prefix,
unchanged envelope/cache-key fingerprints, and the same healthy socket. The
model later went off-protocol, but the bust and recovery were already captured.

**Run B:**

- Pi session: `019fd1f8-6fb5-7782-a323-8f784c0b0ac6`
- Archive call/source call: `127710` / `f3b82c48`
- Phase 1: `0 -> 0`, an explicit zero after baseline but not a bust
- Phase 2: `8704 -> 0 -> 26112`, classified full text-only bust and recovery
- Phase 3: `26112 -> 26112`, remained warm

Run B proves an image is not necessary. Phase-boundary compliance differed:
Run A continued beyond the requested work, while Run B stopped at `DONE`.
Preserve that procedural confound.

### Unclassified candidates — missing wiretap

**Date:** 2026-08-07  
**Model:** `gpt-5.6-luna`  
**Pi session:** `019fde71-8527-7347-bdfd-8e7d6fc19fb6`

```text
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-07T22-56-49-447Z_019fde71-8527-7347-bdfd-8e7d6fc19fb6.jsonl
```

Calls 2–5 reported normalized reads of `1536 -> 3584 -> 0 -> 19328`.
The zero call retained an exact nine-item prefix and unchanged envelope,
instructions, tools, and prompt-cache-key fingerprints. It remained on a
reused WebSocket delta continuation with `previous_response_id`; no failure,
full-context retry, or SSE fallback was recorded. The call added six function
calls and six function outputs (about 51 KB). Its prefix included an image,
a roughly 145 KB output, and a roughly 12 KB output.

After a 36-minute idle gap, calls 50–52 reported `65408 -> 0 -> 66432`.
Unlike the earlier candidate, the zero call created a new WebSocket and sent
full context without `previous_response_id`; this is a connection/reset-
associated candidate, not evidence of a healthy-continuation bust. No
transport error was recorded, so the telemetry cannot identify why Pi started
a new connection or omitted the continuation ID. A controlled post-warm
WebSocket close/reconnect could reproduce this client transport shape, but
would not guarantee a raw provider cache miss.

**Date:** 2026-08-08  
**Model:** `gpt-5.6-luna`  
**Pi session:** `019fdebc-fae3-758b-a1d5-76badf93dc9e`

```text
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-08T00-19-14-787Z_019fdebc-fae3-758b-a1d5-76badf93dc9e.jsonl
```

Normalized reads on calls 3–5 were `2560 -> 0 -> 12928`. Call 4 retained
an exact 13-item logical prefix and unchanged instructions, tools, envelope,
and prompt-cache-key fingerprints. It used `previous_response_id` on a reused
WebSocket connection as a delta request, with no recorded WebSocket failure,
full-context retry, or SSE fallback. The call added six function calls and six
function outputs (about 16 KB); its prefix already contained an image and
large tool outputs.

No matching wiretap artifact was retained, so the raw provider
`cached_tokens` field presence is unknown. The normalized zero cannot
establish an explicit provider zero; classify this as a candidate rather than
a full bust. The archive had no imported model-call rows for this session.

## 7. Extension and wiretap operation

### What the extension records

The extension observes OpenAI and OpenAI Codex lifecycle events without
mutating requests. It records:

- session, provider, model, timing, stop reason, normalized usage, and cost
- logical payload, input, instruction, tool, and prompt-cache-key hashes/sizes
- exact common-prefix comparisons and summaries of changed suffix items
- response-ID hashes and allowlisted response headers
- continuation, connection, failure, full-context, and SSE-fallback counters
- sanitized diagnostics and periodic/discontinuity checkpoints

It does not record raw prompts, instructions, tool bodies, images, response
text, credentials, raw cache keys, raw response IDs, or full filesystem paths.
Logs default to:

```text
~/.pi/agent/diagnostics/cache-telemetry/<pi-session-basename>.jsonl
```

Set `PI_CACHE_TELEMETRY_DIR` to override the directory. Logs rotate at 50 MB.

### What the wiretap adds

`codex-wiretap.mjs` wraps the process-global WebSocket and records actual
outgoing and incoming frames, raw provider usage, and socket lifecycle events.
Handshake authorization, cookies, API keys, tokens, secrets, and account IDs
are redacted. Frame content is not redacted.

It captures WebSocket traffic only. When Pi falls back to SSE, use extension
telemetry for transport state; raw SSE usage is unavailable from this wiretap.

### Loading modes

| Scope | Command |
| --- | --- |
| One Pi process, extension only | `pi -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts` |
| One Pi process, extension plus wiretap | `tools/pi-cache-telemetry/run-with-codex-wiretap.sh -e ./tools/pi-cache-telemetry/extensions/cache-telemetry.ts` |
| Global extension from this checkout | `pi install /Users/danclark/programming/frugal-tokens/tools/pi-cache-telemetry` |
| Project-local extension | `pi install -l ./tools/pi-cache-telemetry` |
| Remove global extension | `pi remove /Users/danclark/programming/frugal-tokens/tools/pi-cache-telemetry` |

Restart Pi after installation. During development, `/reload` reloads extension
changes from the same checkout.

The extension synchronously serializes/hashes logical payloads and appends
NDJSON. Large images or tool results can add local CPU/filesystem latency, so
extension-enabled/disabled A/B trials remain useful. The wiretap is more
invasive and can produce very large files.

## 8. Archive-first fallback

Use this when the starting identifier is archive `model_calls.id`, not a
wiretap. Do not confuse it with a Pi session ID.

```bash
DB="${FRUGAL_TOKENS_ARCHIVE_DB:-$HOME/.local/share/frugal-tokens/archive.sqlite}"
MODEL_CALL_ID=12345

case "$MODEL_CALL_ID" in
  (''|*[!0-9]*) echo "MODEL_CALL_ID must be an integer" >&2; exit 1 ;;
esac

sqlite3 -header -column "$DB" "
  SELECT
    mc.id AS model_call_id,
    mc.source_call_id,
    mc.ordinal AS call_ordinal,
    t.ordinal AS turn_ordinal,
    ss.id AS source_session_id,
    ss.external_id AS external_session_id,
    ss.artifact_path,
    ss.availability,
    src.harness,
    src.location AS source_location,
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
  WHERE mc.id = $MODEL_CALL_ID;
"
```

Require `harness == pi`. `source_call_id` maps to the top-level `id` of the raw
Pi JSONL assistant record. Construct the artifact path from `source_location`
and `artifact_path`; the first session record contains the Pi session ID. The
telemetry file normally shares the session basename.

Inspect the matching raw record without printing content:

```bash
SOURCE_CALL_ID="source-call-id"
SESSION="/resolved/session.jsonl"

jq -c --arg id "$SOURCE_CALL_ID" '
  select(.id == $id)
  | {
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

If the archive row or artifact is unavailable, report that instead of inferring
identity from timestamps. The archive may not contain failed, aborted, or very
recent attempts.

## 9. Optional mitmproxy fault injection

Use mitmproxy only to reproduce transport failure and fallback behavior. It is
not needed for healthy-continuation busts.

Expected local endpoints:

```text
Proxy:     http://127.0.0.1:8080
Dashboard: http://127.0.0.1:8082
CA:        ~/.mitmproxy/mitmproxy-ca-cert.pem
```

Node processes need:

```bash
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY="$HTTP_PROXY"
export ALL_PROXY="$HTTP_PROXY"
export NO_PROXY=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
export SSL_CERT_FILE="$NODE_EXTRA_CA_CERTS"
export CURL_CA_BUNDLE="$NODE_EXTRA_CA_CERTS"
export REQUESTS_CA_BUNDLE="$NODE_EXTRA_CA_CERTS"
```

Native Codex may also require the CA in the macOS login keychain:

```bash
security add-trusted-cert \
  -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

Useful dashboard filters:

```text
~websocket & ~u /backend-api/codex/responses
~websocket & ~u chatgpt.com
```

Manually kill the newest live response:

```bash
MITM_KILL_URL_SUBSTRING=/responses \
  tools/pi-cache-telemetry/mitm-kill-current.sh
```

For one-shot automatic interruption, restart `mitmweb` with
`mitm-kill-websocket.py` armed:

```bash
MITM_KILL_ENABLED=1 \
MITM_KILL_MATCH_TYPE=response.function_call_arguments.delta \
MITM_KILL_AFTER=500 \
mitmweb \
  --mode regular \
  --listen-host 127.0.0.1 --listen-port 8080 \
  --web-host 127.0.0.1 --web-port 8082 \
  --no-web-open-browser \
  -s "$PWD/tools/pi-cache-telemetry/mitm-kill-websocket.py"
```

The target signature is:

```text
warm continuation
-> injected WebSocket failure
-> full-context retry or SSE fallback
-> one-call zero/low read
-> warm recovery
```

This proves client fallback behavior, not that a naturally occurring failure
originated at OpenAI. Proxy flows are sensitive and must not be shared without
review.

## 10. Investigation handoff

Return a compact report containing:

```text
Wiretap artifact:
Telemetry artifact, or unavailable:
Pi session ID and artifact:
Archive model_call ID and source_call_id, or unavailable:
Model and settings:
Candidate model call:
Previous/current/following raw cached_tokens:
Classification: baseline / candidate / partial bust / full bust:
Logical prefix and envelope state:
Current and preceding delta item types and sizes:
Continuation and previous_response_id state:
Connection created/reused/closed:
Transport failures or SSE fallback:
Conclusion:
Limitations and procedural confounds:
```

State observations separately from hypotheses. In particular, do not turn an
isolated cache-read dip into a confirmed explanation of provider internals.
