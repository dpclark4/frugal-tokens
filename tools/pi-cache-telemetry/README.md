# Pi cache telemetry investigation guide

Use this guide to investigate transient OpenAI Codex prompt-cache regressions,
primarily in Pi, with native Codex captures included when they provide
cross-harness evidence. It is written for the common handoff where the only
starting artifact is a raw WebSocket wiretap path.

## 1. What counts as a bust

**Scope rule:** cache miss, full miss, partial miss, and bust are turn-level
classifications throughout this guide. A user turn may contain multiple model
calls. Call-level cache reads provide the evidence, but the classification
belongs to the containing turn. Multiple affected calls in one turn do not
become multiple bust turns; when this guide counts call-level dips or
observations, it says so explicitly.

In this investigation, a **bust turn** has a strict operational definition: it
contains a comparable healthy cache read, one miss or lower read, and a healthy
recovery on comparable completed calls.

```text
comparable warm call
-> zero, initial-baseline, or materially lower cached_tokens on one call
-> warm recovery on the following call
```

A healthy continuation alone is not enough: without both the warm predecessor
and recovery, classify the turn as a baseline/cold sequence or a candidate,
not a bust.

- **Full miss / full bust:** an affected call retains none of the reusable
  cache accumulated by the session, so the containing turn is a full miss. A
  raw provider read of zero establishes this directly. A positive read also
  counts as a full miss when it returns exactly to the initial cache-read
  baseline observed for that provider and model: the stable harness/system
  prefix may still be cached while all session-grown context is lost. The
  dashboard also classifies a call retaining at most 10% of the preceding
  reusable cache as full; any of these call-level conditions makes the
  containing turn a full miss.
- **Partial miss / partial bust:** an affected call retains some session-grown
  cache above the initial baseline, but materially less than the neighboring
  comparable calls; the containing turn is a partial miss.
- **Candidate bust:** the affected turn lacks either a warm predecessor, a
  recovery call, or provider usage needed to classify it confidently.
- A first-call baseline, whether zero or positive, is not a bust. Initial
  `0 -> 0` calls establish no unexpected dip, and a later return to a positive
  first-call baseline can establish a full miss only after session-grown cache
  has first been observed.
- Consecutive cold calls are a different pattern from the cases documented
  here.
- “Bust” describes an observation, not a proven cause. Do not claim that the
  provider permanently invalidated or destroyed a cache entry.

Every established bust below contains a call-level regression that recovers on
a later comparable call. Most captured regressions affect one model call. That
is an empirical property of the captures so far, not the unit of
classification or a claim that all cache failures behave this way.

## 2. Current conclusions

The evidence supports at least two distinct patterns:

1. **Transport-associated bust:** a WebSocket continuation fails, Pi retries
   full context over SSE, the retry has a zero/low normalized read, and the
   next call recovers.
2. **Healthy-continuation bust:** the same WebSocket and
   `previous_response_id` path remain healthy, but raw provider
   `cached_tokens` dips for one call around tool-heavy context growth and then
   recovers.

Large or multi-item tool outputs are a common context shape, but not a
requirement: Case 005 includes classified partial busts after one 154–1,543-byte
function output, and Case 007 is a full bust after a small user delta. An image
is not required: a text-only phase reproduced `8704 -> 0 -> 26112`. The
sequence resembles delayed cache eligibility or publication, but that is a
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
| `cached_tokens` present and `0` | Provider explicitly reported zero cached tokens; after a warm predecessor this establishes a full-miss turn |
| `cached_tokens` present and positive | Provider reported a full or partial read |
| `cached_tokens` omitted | Pi may normalize the missing field to zero; raw miss is unproven |
| Positive -> zero/low -> positive | Candidate call-level regression; classify the containing turn after comparing its baseline, request, and transport state |
| Session-grown read -> initial positive baseline -> recovery | Full-miss turn: the harness/system prefix survived, but none of the session-grown cache did |
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
- immediately preceding function-call names/counts and the returned output batch's names, order, and byte sizes when the wiretap is available
- `websocketDelta.usedPreviousResponseId`
- connection creation/reuse and delta/full-context counts
- WebSocket failures and SSE fallbacks

The extension sees Pi’s full logical payload before Pi converts it to a
WebSocket delta. The wiretap sees the actual transport frames. Use both views.

For reproduction-oriented comparisons, project tool names and result sizes
without printing arguments or results. Match `callId` locally; do not include
raw command text or result bodies in reports.

```bash
jq -c '
  select(.event == "message" and .direction == "incoming"
    and .frame.json.type == "response.output_item.done")
  | select(.frame.json.item.type == "function_call")
  | {
      sequence,
      timestamp,
      callId: .frame.json.item.call_id,
      name: .frame.json.item.name,
      argumentsBytes: (.frame.json.item.arguments | length)
    }
' "$WIRETAP"

jq -c '
  select(.event == "message" and .direction == "outgoing"
    and .frame.json.type == "response.create")
  | {
      sequence,
      timestamp,
      functionOutputs: [(.frame.json.input // [])[]
        | select(.type == "function_call_output")
        | {callId: .call_id, outputBytes: (.output | tostring | length)}]
    }
' "$WIRETAP"
```

A repeated tool name or output shape is a reproduction variable, not an
established cause. Seek matching warm controls before attributing a dip to it.

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
7. The newly added input item types, counts, approximate sizes, and (when a
   wiretap is available) immediately preceding function-call names/order and
   returned output-batch names/order.

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
- immediately preceding function-call names/order and returned output-batch names/order
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

The classification column is turn-scoped. Cache sequences and telemetry call
numbers are call-level evidence within those turns; they are not separate bust
counts unless a row explicitly states the number of affected turns.

| Case | Cache sequence | Transport | Context near dip | Classification |
| --- | --- | --- | --- | --- |
| 001 | `111104 -> 0 -> 112128` | WebSocket failed; full-context SSE retry | Interrupted function-call stream | Transport-associated candidate; raw zero unavailable on SSE |
| 002 | `3584 -> 2560 -> 8704` | Healthy same-socket continuation | Large tool output followed by small user input | Partial-bust turn with one raw call-level dip |
| 003A | `1536 -> 0 -> 4608` | Healthy same-socket continuation | Image tool output, then text tool output | Full-bust turn with one raw zero-read call |
| 003B | `8704 -> 0 -> 26112` | Healthy continuation | Large text-only multi-output phase | Full-bust turn with one raw zero-read call; image not required |
| 004 | `2560 -> 0 -> 12800`; three partial dips | Healthy WebSocket continuations | Function-output growth | Turn-level classifications supported by one raw full and three raw partial call-level dips |
| 005 | Six partial dips; one zero after fallback | Healthy WebSocket continuations; one SSE fallback | Mixed-size function outputs | Three partial-bust turns containing six raw call-level dips; one transport-associated candidate turn |
| 006 | `4992 -> 1536 -> 11136` | Healthy same-socket continuation | Four text function outputs, about 11 KB | Partial-bust turn with one raw call-level dip |
| 007 | `39552 -> 0 -> 40576` | Healthy same-socket continuation | Small user delta after one text function output | Full-bust turn with one raw zero-read call |
| 008A | `2560 -> 0 -> 10752` | Healthy same-socket continuation | Three successful `bash` outputs, about 24.8 KB total | Full-bust turn with one raw zero-read call |
| 008B | `59904 -> normalized 0 -> normalized 61952` | WebSocket idle timeout; full-context SSE fallback | A pending `edit` tool call | Transport-associated candidate; raw SSE usage unavailable |
| 009 | `9728 -> 0 -> 10752`; `33280 -> 12800 -> 33280`; `47616 -> 34304 -> 53760` | First recovery followed idle timeout/reconnect; latter two healthy same-socket continuations | Two three-`bash` output batches; one small user delta | One raw full call-level observation with reset-confounded recovery; two partial-bust turns |
| 010 | `2560 -> 0 -> 4608`; `25088 -> 6656 -> 27136`; `34560 -> 30464 -> 35584` | Healthy same-socket continuation; logical-payload telemetry unavailable | Four `read` outputs; small user delta; one small `bash` output | Turn-level classifications supported by one raw full and two material raw partial call-level observations; exact-prefix/envelope state unavailable |
| 011 | `70144 -> 0 -> 85504` | Healthy same-socket continuation | Immediate 71-byte `edit` output after a 135-second, reasoning-heavy response | Full-bust turn with one raw zero-read call |
| 012 | `31488 -> 11008 -> 32512` | Native Codex; raw transport unavailable | Immediate 490-byte `exec` output after an ordinary tool-calling response | Full-bust turn: the affected call returned exactly to the initial 11,008-token baseline |
| 013 | `23296 -> 18176 -> 25344`; `35584 -> 23296 -> 36608`; `39936 -> 35584 -> 40960` | Native Codex; raw transport unavailable | Three single-`exec` results, 206–4,062 serialized bytes | Three partial-bust turns; recovery occurred both within a turn and on the next user turn |

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

### Case 004 — Multiple healthy-continuation busts

**Date:** 2026-08-09; **Model:** `gpt-5.6-sol`, medium reasoning
**Pi session:** `019fe7b4-3198-7cf3-a16c-8edf47574dbc`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-09T18-06-13-912Z_019fe7b4-3198-7cf3-a16c-8edf47574dbc.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-09T18-06-13-912Z_019fe7b4-3198-7cf3-a16c-8edf47574dbc.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-09T18-06-13Z-530.jsonl
Archive model-call rows: unavailable at investigation time
```

The raw provider usage field explicitly included `cached_tokens` on all
completed WebSocket calls. Four call-level dips had a warm predecessor and an
immediate recovery; each contributes evidence to its containing turn's
classification:

| Telemetry call | Raw cache sequence | Call-level result | Added function-output bytes |
| --- | --- | --- | --- |
| 4 | `2560 -> 0 -> 12800` | Full regression | 4 outputs, about 16 KB |
| 9 | `14848 -> 9728 -> 28160` | Partial dip | 6 outputs, about 48 KB |
| 25 | `32256 -> 16896 -> 37376` | Partial dip | 3 outputs, about 18 KB |
| 31 | `42496 -> 32256 -> 44544` | Partial dip | 1 output, about 3 KB |

For every affected request, telemetry recorded an exact prior logical-input
prefix and unchanged envelope, instructions, tools, settings, and
prompt-cache-key fingerprints. The requests used a WebSocket delta with
`previous_response_id` on a reused, healthy connection; no error, retry,
reconnection at the affected call, or SSE fallback was recorded. The first
three dips followed multi-output growth; the fourth shows that this shape is
not required in this capture.

This is evidence of transient provider-reported cache-read regressions on
otherwise healthy Pi continuations, not evidence of a Pi transport or
request-construction failure. It does not establish the provider's internal
cause or prove cache invalidation.

### Case 005 — Repeated partial busts with mixed-size deltas

**Date:** 2026-08-11; **Model:** `gpt-5.6-sol`, medium reasoning
**Pi session:** `019fee5c-ce79-7655-8285-c913ce9351d1`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-11T01-08-07-417Z_019fee5c-ce79-7655-8285-c913ce9351d1.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-11T01-08-07-417Z_019fee5c-ce79-7655-8285-c913ce9351d1.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-11T01-08-06Z-31520.jsonl
Archive model-call rows: unavailable; the configured database lacked the expected `model_calls` table
```

The dashboard showed four affected turns: partial-miss markers on turns 1, 6,
and 11, plus a full-miss marker on turn 14. These are turn-level markers, not
four model calls: turn 1 contains four classified partial dips. The raw
wiretap explicitly included `cached_tokens` on the completed WebSocket calls.
Six calls had a warm predecessor, a lower positive raw read, and immediate
warm recovery. They occurred across three partial-bust turns:

| Dashboard turn / telemetry call | Raw cache sequence | Immediate added `function_call_output` | Call-level result |
| --- | --- | --- | --- |
| 1 / 4 | `7040 -> 1536 -> 15232` | 7 outputs, 19,043 bytes | Partial dip |
| 1 / 6 | `15232 -> 10112 -> 20352` | 1 output, 1,543 bytes | Partial dip |
| 1 / 11 | `23424 -> 20352 -> 25472` | 1 output, 154 bytes | Partial dip |
| 1 / 14 | `27520 -> 24448 -> 29568` | 1 output, 154 bytes | Partial dip |
| 6 / 37 | `41088 -> 34816 -> 41088` | 1 output, 969 bytes | Partial dip |
| 11 / 55 | `54528 -> 42112 -> 54528` | 1 output, 154 bytes | Partial dip |

For all six call-level dips, telemetry recorded an exact prior logical-input
prefix, unchanged envelope, instructions, tools, settings, and prompt-cache
key. Each used a WebSocket delta with `previous_response_id` on reused
connection 1; no failure, retry, reconnect, or SSE fallback was recorded.
The sequence therefore extends Case 004: repeated healthy-continuation dips
are not limited to large or multi-output additions. The captures show no Pi
transport failure, retry, reconnection, or request-envelope change at these six
calls, but they do not isolate the cause to OpenAI: Pi remains part of the
continuation request path and provider cache state is not observable.

Turn 14's dashboard full-miss marker corresponds to telemetry call 63:
`55552 -> normalized 0 -> 59648`. It added three text function outputs
(1,067, 1,564, and 4,129 bytes), retained an exact 258-item logical prefix and
unchanged envelope, and initially sent a delta using `previous_response_id`.
The socket then closed cleanly with code `1000` before message streaming;
Pi retried full logical context over SSE and recorded a normalized zero. The
next completed call read 59,648 cached tokens. The wiretap ended with the
WebSocket, so it cannot establish raw provider `cached_tokens` for the SSE
retry. A clean `1000` close does not identify whether Pi, the provider, or an
intermediary initiated it. Classify this event as a transport-associated
candidate, not a raw full bust.

The dashboard's 90% retained-read threshold does not mark three smaller raw
dips (93.3%, 96.5%, and 97.1% retained) as misses. They are not included in
the table or the Case 005 count.

### Case 006 — Repeat early multi-output partial bust

**Date:** 2026-08-11; **Model:** `gpt-5.6-sol`, medium reasoning
**Pi session:** `019fee71-77ab-7062-b6a9-577ec0169129`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-11T01-30-41-451Z_019fee71-77ab-7062-b6a9-577ec0169129.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-11T01-30-41-451Z_019fee71-77ab-7062-b6a9-577ec0169129.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-11T01-30-40Z-33323.jsonl
Archive model-call rows: unavailable; the configured database lacked the expected `model_calls` table
```

The first two completed calls explicitly reported `cached_tokens=0`, which is a
cold baseline. Calls 3–5 then reported raw reads of `4992 -> 1536 -> 11136`.
The call-4 raw usage field explicitly included `cached_tokens=1536`, making
this a partial bust rather than a telemetry-only candidate.

Call 4 had 11,338 total input tokens and added four text
`function_call_output` items of 3,561, 3,075, 2,264, and 2,015 bytes (10,915
bytes total). Telemetry recorded an exact prior logical-input prefix and an
unchanged envelope, instructions, tools, settings, and prompt-cache-key
fingerprints. The call was a WebSocket delta with `previous_response_id` on
reused connection 1; no error, retry, reconnect, or SSE fallback occurred.
The following call had 15,903 total input tokens and recovered to 11,136
cached tokens.

This independently repeats the early shape in Case 005 (`7040 -> 1536 ->
15232`): following a `0 -> 0` baseline and one warm call, a multi-output delta
received a 1,536-token raw read and the next call recovered. It is evidence of
a repeated provider-reported cache-read regression on healthy Pi
continuations, not proof of a provider-internal cause or a Pi defect.

### Case 007 — Healthy-continuation full bust after a small user delta

**Date:** 2026-08-11; **Model:** `gpt-5.6-sol`, medium reasoning
**Pi session:** `019fee41-939c-7233-8149-81e81be9169c`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-11T00-38-22-876Z_019fee41-939c-7233-8149-81e81be9169c.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-11T00-38-22-876Z_019fee41-939c-7233-8149-81e81be9169c.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-11T00-38-21Z-29892.jsonl
Archive model-call rows: unavailable; the configured database lacked the expected `model_calls` table
```

Calls 23–25 reported raw cache reads of `39552 -> 0 -> 40576`. The middle
call's raw provider usage explicitly included `cached_tokens=0`, establishing
a full call-level regression with immediate recovery and classifying the
containing turn as a full bust.

The zero-read call had 41,646 total input tokens. Telemetry recorded an exact
prior logical-input prefix and unchanged envelope, instructions, tools,
settings, and prompt-cache-key fingerprints. It used a WebSocket delta with
`previous_response_id` on reused connection 1; no error, retry, reconnect, or
SSE fallback was recorded. The actual delta had one item: an 81-byte user
message. Its logical suffix also contained 4,238 bytes of reasoning and a
1,964-byte preceding assistant message. The preceding request had added one
1,470-byte text `function_call_output`.

The nearby transport sequence was: a 6,013-byte user delta, a 3,618-byte
function output, a 1,470-byte function output, a normal model text response,
the 81-byte user-delta bust, then a 109-byte user-delta recovery. The preceding
model response completed 15.8 seconds before the bust request. Connection 1
remained healthy through recovery and did not receive its unrelated
`debug_close` until more than six minutes later. This shows that a large or
multi-output immediate delta is not required for a raw full bust. It is
evidence of a transient provider-reported cache-read regression on a healthy
Pi continuation, not proof of the provider's internal cause or a Pi defect.

### Case 008 — Healthy full bust followed by a separate SSE fallback candidate

**Date:** 2026-08-11; **Model:** `gpt-5.6-sol`, high reasoning
**Pi session:** `019ff0e2-7aa5-7774-ae12-aadb8ab3fb8e`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-11T12-53-22-213Z_019ff0e2-7aa5-7774-ae12-aadb8ab3fb8e.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-11T12-53-22-213Z_019ff0e2-7aa5-7774-ae12-aadb8ab3fb8e.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-11T12-53-21Z-52445.jsonl
Archive model-call rows: not investigated
```

#### 008A — Early healthy-continuation full bust

Calls 2–4 explicitly reported raw provider reads of `2560 -> 0 -> 10752`.
The middle call therefore has both a warm predecessor and immediate recovery.
Its raw `cached_tokens=0` establishes a full call-level regression and
classifies the containing turn as a full bust.

| Call | Raw input / cached tokens | Adjacent tool activity |
| --- | --- | --- |
| 2, warm predecessor | `4964 / 2560` | Produced three successful `bash` calls; results were about 5.8 KB, 17.2 KB, and 1.6 KB. |
| 3, zero-read call | `11253 / 0` | Sent those three outputs as its actual WebSocket delta; produced six successful `read` calls. |
| 4, recovery | `24320 / 10752` | Sent the six reads' outputs; produced six further successful `read` calls. |

The candidate retained an exact six-item logical prefix. Its envelope,
instructions, four-tool configuration, settings, and prompt-cache-key
fingerprints were unchanged. Its logical suffix added reasoning, three
function calls, and the three `bash` outputs (about 24.8 KB total); the actual
WebSocket delta contained only the three function outputs. It used
`previous_response_id` on reused connection 1, which remained healthy through
recovery. No image appeared in the immediate adjacent logical payloads, and
no retry, reconnect, WebSocket error, or SSE fallback was recorded.

This is evidence of a transient provider-reported cache-read regression on an
otherwise healthy Pi continuation. The clean continuation and recovery make a
provider-side cache eligibility or accounting issue a leading hypothesis, but
the capture does not prove provider internals or exclude an unobserved Pi
continuation-construction factor.

#### 008B — Later WebSocket timeout and SSE retry

This later event in the same session is distinct from 008A. Call 11 had a
warm read of 59,904 tokens and produced a successful small `edit`. Call 12
retained an exact prefix and unchanged envelope, used a reused WebSocket delta
with `previous_response_id`, and began streaming an `edit` call. It did not
reach a terminal provider-usage frame or a tool result.

Pi recorded a WebSocket idle timeout after message-stream start and activated
fallback. The wiretap records Pi requesting close with code `1000` and reason
`idle_timeout`, followed later by an abnormal code `1006` close. Pi retried
full logical context over SSE: telemetry recorded normalized `cacheRead=0` on
that retry, which produced a successful `read`; the next SSE completion
recorded normalized `cacheRead=61952` and produced a successful `edit`.

The wiretap does not capture SSE, so neither the retry's zero nor the later
read can establish raw provider `cached_tokens`. The timeout/fallback path is
directly involved, while the server, network intermediary, and local runtime
remain possible causes of the underlying stall. Classify this as a
transport-associated candidate, not evidence of a provider cache regression.

### Case 009 — Two healthy partial busts and a reset-confounded full zero

**Date:** 2026-08-16; **Model:** `gpt-5.6-sol`, medium reasoning
**Pi session:** `01a00aef-3b1e-778a-b4d9-39ea4e08d244`
**Archive model-call rows:** not investigated

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-16T14-17-25-534Z_01a00aef-3b1e-778a-b4d9-39ea4e08d244.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-16T14-17-25-534Z_01a00aef-3b1e-778a-b4d9-39ea4e08d244.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-16T14-17-24Z-69346.jsonl
```

The wiretap explicitly included raw `cached_tokens` on every completed
WebSocket response. Three material dips had warm predecessors and positive
following reads:

| Telemetry call | Raw cache sequence | Immediate context | Classification |
| --- | --- | --- | --- |
| 6 | `9728 -> 0 -> 10752` | Three `bash` outputs, 2,207 + 4,844 + 126 bytes | Full raw zero; reset-confounded recovery |
| 15 | `33280 -> 12800 -> 33280` | 75-byte user delta after normal assistant text | Raw partial call-level dip in a partial-bust turn |
| 27 | `47616 -> 34304 -> 53760` | Three `bash` outputs, 158 + 8,464 + 433 bytes | Raw partial call-level dip in a partial-bust turn |

Call 6 retained an exact 31-item logical prefix and unchanged envelope,
instructions, tools, settings, and prompt-cache-key fingerprints. It was a
reused WebSocket delta with `previous_response_id` and completed normally. Its
zero-read request followed an assistant turn that issued three `bash` calls.
The socket was only closed cleanly for `idle_timeout` about five minutes after
the zero completed; the next request occurred about 7 minutes 46 seconds
later on a new WebSocket with full context and no `previous_response_id`, then
read 10,752 cached tokens. The raw zero is established, but the reset before
recovery means this is not a strong same-socket healthy-continuation report or
the SSE-retry transport pattern.

Calls 15 and 27 retained exact 67- and 122-item prefixes, respectively, with
unchanged envelope, instructions, tools, settings, and prompt-cache-key
fingerprints. Both used `previous_response_id` WebSocket deltas on reused
connection 2, which had no error, retry, reconnect, or SSE fallback near either
dip or recovery. Call 15 followed a roughly three-minute gap and no immediate
tool output: its logical suffix was a 910-byte assistant message and a 75-byte
user message. Call 27 followed an assistant turn that issued three `bash`
calls, and its immediate delta returned their approximately 9.1 KB results.

A fourth small raw dip, call 18's `34304 -> 33280 -> 36352`, retained 97.0% of
the predecessor's read after a `read`, `bash`, `bash` output batch of about
11.4 KB. Following the Case 005 90% dashboard convention, it is not included
in the material-bust count, but it is useful reproduction context.

The two `bash`-batch examples make tool name/order and output-batch shape worth
recording as controlled variables. They do not establish `bash` as a cause:
this session contains other successful `bash` batches and call 15 shows an
immediate tool result is not required. Future trials should vary the named
three-output `bash` shape against size- and order-matched `read` or text-output
controls, while holding transport, delay, and payload shape fixed.

### Case 010 — Wiretap-only full and partial observations

**Date:** 2026-08-21; **Model:** `gpt-5.6-terra`
**Pi session:** `01a025df-d2cb-70a4-888c-74edcd5cd2a5`

```text
Session:
~/.pi/agent/sessions/--Users-dclark-development-code--/2026-08-21T19-50-20-619Z_01a025df-d2cb-70a4-888c-74edcd5cd2a5.jsonl
Telemetry: unavailable
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-21T19-50-18Z-37779.jsonl
Archive model-call rows: unavailable; the configured database lacked the expected `turns` table
```

The raw provider usage explicitly included `cached_tokens` on every completed
WebSocket response. One connection was constructed and opened; every request
after the first used `previous_response_id` on that same connection. The
wiretap recorded no WebSocket error, close, retry, reconnection, or SSE
fallback near any observation.

Three material call-level dips had a lower raw read followed by a warm
recovery:

| Pi turn/call | Raw cache sequence | Immediate request delta | Classification |
| --- | --- | --- | --- |
| 1 / 3 | `2560 -> 0 -> 4608` | Four `read` outputs: 4,476 + 3,075 + 325 + 1,120 bytes | Raw full call-level observation |
| 6 / 1 | `25088 -> 6656 -> 27136` | One 95-byte user message; no preceding tool output | Raw partial call-level observation (26.5% retained) |
| 12 / 2 | `34560 -> 30464 -> 35584` | One `bash` output, 159 bytes | Raw partial call-level observation (88.2% retained) |

The full-zero request returned the four `read` calls in that order; their
function-call argument sizes were 47, 25, 29, and 30 bytes. The `bash` call
before turn 12, call 2 had 54-byte arguments. These are reproduction
variables, not evidence that a tool name, argument size, or output size caused
the dips: the largest partial observation followed no tool output at all.

Three additional shallow raw decreases are useful context but do not meet the
Case 005 90% retained-read convention for material partial misses: `29184 ->
27136 -> 30464` after an 11-byte `bash` output (93.0% retained), and `30464 ->
29184 -> 30464` after a 293-byte `bash` output (95.8% retained). The final
completed call read `34560` after `35584`, following a 257-byte `bash` output
(97.1% retained), but the capture ended before a following completed call, so
it lacks recovery and remains a candidate.

The wiretap establishes raw usage and a healthy transport continuation, but
privacy-safe telemetry was not retained. Exact logical-prefix, request-envelope,
instruction, tool-schema, prompt-cache-key, and settings comparisons therefore
remain unavailable. This is evidence of transient provider-reported cache-read
variation on one healthy continuation path, not proof of provider internals or
of a Pi request-construction defect.

### Case 011 — Full bust on an immediate child of a long response

**Date:** 2026-08-21; **Model:** `gpt-5.6-luna`, max reasoning
**Pi session:** `01a02486-383a-75eb-9182-73f1a9ada0d3`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-0sql--/2026-08-21T13-32-51-131Z_01a02486-383a-75eb-9182-73f1a9ada0d3.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-21T13-32-51-131Z_01a02486-383a-75eb-9182-73f1a9ada0d3.jsonl
Wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-21T13-32-50Z-85746.jsonl
Archive model-call rows: not investigated
```

Telemetry calls 16–18 explicitly reported raw provider reads of `70144 -> 0
-> 85504`. The middle call therefore has a warm predecessor and immediate
recovery. Its raw `cached_tokens=0` establishes a full call-level regression
and classifies the containing turn as a full bust. It was the only cache-read
decrease among 56 completed calls in the wiretap.

The warm predecessor ran for 134.6 seconds and reported 7,419 output tokens,
including 6,939 reasoning tokens represented in the following logical payload
as 14 reasoning items. It ended with one `edit` function call. Pi sent the
next request 46 milliseconds after the raw completion frame, using the exact
preceding response ID and an actual WebSocket delta containing only the
71-byte `edit` result. That request reported 85,901 total input tokens and
zero cached tokens, completed in 3.0 seconds, and produced one `read` call.
Pi returned the 1,563-byte `read` result 20 milliseconds later; the following
call reported 86,478 total input tokens and recovered to 85,504 cached tokens.

Telemetry recorded an exact 129-item prior logical-input prefix on the
zero-read request and an exact 145-item prefix on recovery. The envelope,
instructions, tools, settings, and prompt-cache-key fingerprints remained
unchanged. Both requests were WebSocket deltas with `previous_response_id` on
reused connection 1, and each ID matched the immediately preceding raw
response. The wiretap recorded no error, retry, reconnection, or SSE fallback;
the connection remained open until Pi requested a clean idle-timeout close
more than five minutes after recovery.

This is strong evidence of a transient provider-reported cache-read regression
on an otherwise healthy Pi continuation. The unusually long, reasoning-heavy
predecessor followed by a child request within 46 milliseconds makes delayed
cache publication, eligibility, or replication a useful hypothesis. The zero
rather than the predecessor's 70,144-token read may indicate that lookup of a
new continuation node failed without falling back to an already-cached
ancestor. Provider cache state is not observable, however, so the capture does
not establish that mechanism or exclude an unobserved continuation-processing
factor. Controlled trials should vary the delay after a long tool-calling
response while holding the tiny result, model, reasoning level, connection,
and payload fingerprints fixed.

### Case 012 — Native Codex full miss returning to the initial baseline

**Date:** 2026-08-22; **Model:** `gpt-5.6-sol`, medium reasoning
**Codex session:** `01a02a3b-93e7-7652-a514-6b758e0a4e0b`
**Archive conversation/model call:** `1589` / `72656`
**Codex turn/call:** turn 3, call 2

```text
Codex session:
~/.codex/sessions/2026/08/22/rollout-2026-08-22T12-09-02-01a02a3b-93e7-7652-a514-6b758e0a4e0b.jsonl
Pi telemetry: unavailable; native Codex session
Wiretap: unavailable
```

Calls 1–3 of turn 3 reported cache reads of `31488 -> 11008 ->
32512`. The session's first completed call had also read exactly 11,008 cached
tokens. The affected call therefore retained the stable initial harness/system
prefix but none of the additional cache accumulated during the session. Under
the turn-level baseline rule, turn 3 is a **full miss**, even though the
provider usage remained positive rather than falling to zero.

The affected call followed one `exec` function call and a 490-byte serialized
result. Its warm predecessor reported 33,084 total input tokens, 31,488 cached
tokens, 286 output tokens, and 41 reasoning tokens. The affected call reported
33,565 total input tokens, 11,008 cached tokens, 532 output tokens, and 58
reasoning tokens. Its next tool result was 43,965 serialized bytes; the
following call recovered to 32,512 cached tokens while total input grew to
49,787 tokens.

The Codex rollout recorded no compaction, retry, abort, model change, or
reasoning-setting change near the miss. Unlike the Pi cases, no matching raw
transport wiretap or logical-payload telemetry is available, so socket reuse,
`previous_response_id`, exact-prefix state, and request-envelope stability
cannot be established. The positive provider-reported cache read itself is
unambiguous.

This cross-harness case makes a Pi-specific request-construction defect less
likely and shows that a long or reasoning-heavy predecessor is not required.
Its shared shape with Case 011 is an immediate tool-result continuation whose
session-grown cache disappears for one call and recovers on the next. Delayed
continuation-cache publication, eligibility, or replica visibility remains a
hypothesis rather than a confirmed provider mechanism.

### Case 013 — Repeated native Codex partial busts after single exec results

**Date:** 2026-08-22; **Model:** `gpt-5.6-sol`, medium reasoning
**Codex session:** `01a02a4e-4ac9-70d2-8895-03f6828505cb`
**Archive conversation/model calls:** `1818` / `82243`, `82252`, `82258`

```text
Codex session:
~/.codex/sessions/2026/08/22/rollout-2026-08-22T12-29-29-01a02a4e-4ac9-70d2-8895-03f6828505cb.jsonl
Pi telemetry: unavailable; native Codex session
Wiretap: unavailable
```

Three user turns each contained one material call-level cache regression:

| Affected turn/call | Call-level cache sequence | Predecessor retained | Immediately preceding result | Recovery |
| --- | --- | ---: | --- | --- |
| Turn 1, call 6 | `23296 -> 18176 -> 25344` | 78.0% | One `exec` result, 4,062 serialized bytes | First call of the next user turn |
| Turn 2, call 9 | `35584 -> 23296 -> 36608` | 65.5% | One `exec` result, 206 serialized bytes | First call of the next user turn |
| Turn 3, call 6 | `39936 -> 35584 -> 40960` | 89.1% | One `exec` result, 1,780 serialized bytes | Within the same turn |

These are **three partial-bust turns**. Every affected call retained more than
the session's initial 11,008-token cache baseline, so none qualifies as a full
miss. The individual call-level regressions locate the evidence inside each
turn; they are not additional bust counts.

All three regressions immediately followed a single `exec` result, despite the
results varying from 206 to 4,062 serialized bytes. The rollout recorded no
compaction, retry, abort, model change, reasoning-setting change, or recorded
error near the dips. Recovery occurred under two shapes: on the first call of
the next user turn for the first two affected turns, and within the same user
turn for the third.

As with Case 012, no raw transport wiretap or logical-payload telemetry is
available. Socket reuse, `previous_response_id`, exact-prefix state, and
request-envelope stability therefore cannot be established. This case does
not identify a provider-side mechanism.

The repeated native Codex observations weaken large tool output, parallel tool
results, and Pi-specific request construction as necessary conditions. They
support testing the tool-result continuation boundary itself while varying
result count and delivery delay. The range of retained cache and recovery
timing also suggests the behavior is not limited to a single fixed truncation
point or to user-turn boundaries.

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

### Non-bust cold sequence after image-bearing output

**Date:** 2026-08-09
**Model:** `gpt-5.6-sol`
**Pi session:** `019fe6a5-b8d3-7545-a30f-513d0e3e5ea5`

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming--/2026-08-09T13-10-48-275Z_019fe6a5-b8d3-7545-a30f-513d0e3e5ea5.jsonl
Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-09T13-10-48-275Z_019fe6a5-b8d3-7545-a30f-513d0e3e5ea5.jsonl
Wiretap: unavailable
Archive model-call rows: unavailable at investigation time
```

The first three completed calls reported normalized reads of `0 -> 0 -> 0`.
Call 1 is the cold baseline. Call 2 retained its exact one-item prefix and
unchanged envelope while adding reasoning, two function calls, and two
function outputs: one image-bearing output of about 957 KB and one text output
of about 2 KB. Call 3 retained the exact six-item prefix and unchanged envelope
while adding reasoning, one function call, and a 29 KB function output.

Calls 2 and 3 used `previous_response_id` as WebSocket deltas on a reused
connection. No WebSocket failure, full-context retry, or SSE fallback was
recorded. The next attempt was aborted without usage; the subsequent completed
call used a new full-context WebSocket connection without `previous_response_id`
and read 14,336 cached tokens.

Classify this as a **non-bust consecutive cold sequence**, not two misses or a
candidate bust: it has no warm predecessor and no immediately comparable warm
recovery. No wiretap was retained, so raw provider `cached_tokens` field
presence and explicit zero values are unknown. The shape is consistent with,
but does not establish, delayed provider cache eligibility after a large
image-bearing output.

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
Affected turn and call within turn:
Candidate model call:
Previous/current/following raw cached_tokens:
Initial provider/model cache-read baseline:
Turn classification: baseline / candidate / partial bust / full bust:
Logical prefix and envelope state:
Current and preceding delta item types and sizes:
Immediately preceding function-call names/order and returned output-batch names/order, or unavailable:
Continuation and previous_response_id state:
Connection created/reused/closed:
Transport failures or SSE fallback:
Conclusion:
Limitations and procedural confounds:
```

State observations separately from hypotheses. In particular, do not turn an
isolated cache-read dip into a confirmed explanation of provider internals.
