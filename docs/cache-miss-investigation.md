# Unexpected cache misses with OpenAI models

**Status:** investigative, read-only analysis  
**Analysis snapshot:** 2026-08-01 artifacts  
**Scope:** recent OpenAI `gpt-*` sessions from OpenCode, Pi, and selected Codex
JSONL fixtures

## Executive summary

For this investigation, a **cache bust** means a model call that has a large
reusable prefix available from the preceding call but receives little or no
cache read for its own input. The most useful sequence is a **recoverable
bust**:

```text
hot cache -> heavy miss/write -> hot cache again
```

Recovery is expected if the bust call rebuilt a usable prefix; it does not
make the bust cheap. The cost-bearing event is the miss/write call itself, so
the analysis should operate on individual model calls rather than only on
turn-level aggregates.

Current conclusions:

1. Recent text-only data contains real one-request cache losses. The clean
   OpenCode/Pi cohort contains 31 full misses and 51 partial misses.
2. The 31 full misses are not explained by the current classifier's known
   causes, and all 31 added context rather than shrinking it. This makes
   compaction or a simple context truncation explanation unlikely for this
   cohort.
3. A full miss often recovers immediately. Twelve of 19 OpenCode full misses
   and seven of 12 Pi full misses were followed by a cache read later in the
   same user turn. This makes a permanent cache eviction unlikely, but it does
   not reduce the cost of the missed request.
4. A conservative Codex archive lookback contains 5 full misses and 33 partial
   misses across 10 raw-image-free sessions. Using `missed_tokens >= 10,000`
   as a heavy threshold gives 22 heavy misses; all five full misses recovered
   on the next comparable call. The three detailed Codex JSONL sessions below
   independently show the same low-cache-then-recovery behavior.
5. Pi has a real reporting ambiguity: the installed SDK maps both an omitted
   `input_tokens_details` object and an explicit `cached_tokens: 0` to
   `cacheRead: 0`.
6. The previously correlated Pi WebSocket failures are not clean evidence for
   the text-only cohort. Five of the six structured transport-diagnostic
   sessions are image-flagged, and the sixth is the active/excluded session
   1094. None of the 12 clean Pi full-miss target records has a nearby
   `provider_transport_failure` diagnostic.
7. OpenCode cannot currently resolve the question. Its database stores
   high-level usage and `MessageAbortedError`, but no raw response usage,
   WebSocket/SSE state, request body, fallback, or provider error details.

The strongest current model is therefore **per-request cache continuity loss**.
A WebSocket/continuation failure may be one trigger for Pi, but the Codex and
clean Pi/OpenCode records do not justify assuming that every full miss is caused
by WebSocket failure.

The archive result is evidence for a costly, often recoverable bust—not proof
of the provider's internal cache decision. A turn-level cached percentage can
also combine a hot model call with a busted model call, so turn summaries are
not sufficient for this classification.

## Data sources

- Frugal Tokens archive: `~/.local/share/frugal-tokens/archive.sqlite`
- OpenCode database: `~/.local/share/opencode/opencode.db`
- Pi sessions: `~/.pi/agent/sessions/**/*.jsonl`
- Codex rollouts: `~/.codex/sessions/**/*.jsonl`
- Installed Pi version: `@earendil-works/pi-coding-agent` `0.83.0`
- Current Pi settings omit `transport`, so the documented default is `auto`.

Relevant implementation files:

- `src/server/cacheAnalysis.ts`
- `db/migrations/20260717120000_add_cache_misses.sql`
- `src/server/piRepository.ts`
- `src/server/codexRepository.ts`
- `src/server/openCodeImporter.ts`
- `src/server/opencodeRepository.ts`
- `tools/pi-session-debug.sh`
- `tools/codex-session-debug.sh`

## Cohort definition

The recent comparison cohort uses:

- `source_sessions` harness `opencode` with model provider `openai`, or
  harness `pi` with model provider `openai-codex`;
- model name matching `gpt-*`;
- model-call start at or after `2026-06-30`;
- `cache_misses.cause IS NULL` and `cache_misses.reason IS NULL`;
- source session 1094 excluded because it is active;
- any session containing a model call with `images IS NOT NULL` excluded.

The `2026-06-30` cutoff is deliberate. Older history crosses importer,
normalization, and image-handling changes, so it is not treated as directly
comparable to the recent records.

The image exclusion is session-level. Pi's imported image information is more
reliable on `model_calls.images` than on `turn_inputs`, so filtering only the
current turn is not sufficient.

The OpenCode/Pi cohort above is the recent comparison cohort. The separate
Codex lookback covers `2026-01-01` through `2026-07-25`, the latest persisted
Codex miss in the archive. DB image flags are treated as trustworthy for the
recent 3–6 month window. Older importer history has known image undercounts,
so older sessions containing a raw `input_image` block were excluded as a
conservative control; the historical Codex counts are therefore lower bounds.

`cache_misses` classifies a request relative to its prior reusable cache. A
`full-miss` is not necessarily a literal zero from the provider: five of the
31 clean full misses retained a small residual read.

The classifier's `cause` values are only `compaction`, `ttl`, and
`thinking-change`. A null cause means “not explained by the available local
signals,” not “proven unrelated to TTL, transport, or server behavior.”

## Clean cohort results

| Cohort | Requests | Sessions | Zero cache reads | Context under 50k | 50k–120k | 120k+ |
|---|---:|---:|---:|---:|---:|---:|
| Full miss | 31 | 27 | 26 | 24 | 1 | 6 |
| Partial hit | 51 | 40 | 0 | 45 | 5 | 1 |

The session count for partials is not used as a primary metric because one
session can contribute several misses; the request counts and context buckets
are the stable comparison here.

Other observations:

- Every clean full miss had `current_context_tokens > previous_context_tokens`.
  There were no context-shrink full misses.
- Only two partial misses had a context shrink.
- A separate scan of the raw Pi `thinking_level_change` records found no
  recent thinking-level change immediately before any of the 12 clean Pi full
  misses. Their effective levels were stable at the target: `minimal`, `high`,
  `max`, `xhigh`, or `medium`, depending on the session. This agrees with
  excluding the archive's known `thinking-change` causes.
- Current-turn stored text was at most 4,484 characters for a full miss. A
  large user message is therefore not required.
- The previous call had at least one tool in 19/31 full misses and 42/51 partial
  misses. Tool presence is not a sufficient discriminator.
- Previous tool-output character totals reached 51,914 for full misses and
  128,081 for partial misses. Large tool output can occur on either side.
- Full misses had small residual reads of 4,096 or 6,656 in three OpenCode
  calls and 1,536 in two Pi calls. The other 26 full misses recorded zero.

### Clean Pi full-miss records

These are the 12 clean Pi full-miss calls after the filters above:

| Source session | Call | Model | Previous context | Current context | Cache read | Gap |
|---:|---:|---|---:|---:|---:|---:|
| 891 | 30720 | `gpt-5.6-luna` | 7,474 | 7,753 | 0 | 47.5s |
| 891 | 30722 | `gpt-5.6-luna` | 12,032 | 12,331 | 0 | 40.0s |
| 876 | 30090 | `gpt-5.6-terra` | 11,766 | 12,965 | 0 | 22.1s |
| 856 | 29110 | `gpt-5.6-luna` | 5,461 | 17,745 | 0 | 4.8s |
| 858 | 29161 | `gpt-5.6-luna` | 7,618 | 7,724 | 0 | 1.9s |
| 860 | 29241 | `gpt-5.6-luna` | 7,423 | 10,119 | 0 | 5.3s |
| 858 | 29223 | `gpt-5.6-luna` | 141,732 | 142,141 | 0 | 557.7s |
| 843 | 28351 | `gpt-5.6-luna` | 137,998 | 140,192 | 1,536 | 403.4s |
| 837 | 28088 | `gpt-5.6-luna` | 128,648 | 130,257 | 1,536 | 461.5s |
| 835 | 27903 | `gpt-5.6-luna` | 2,635 | 16,658 | 0 | 2.6s |
| 812 | 27075 | `gpt-5.6-luna` | 2,683 | 3,469 | 0 | 144.5s |
| 812 | 27078 | `gpt-5.6-luna` | 4,322 | 4,425 | 0 | 602.3s |

All 12 corresponding raw assistant records have ordinary `stop` or
`toolUse` stop reasons and no `provider_transport_failure` diagnostic.
Seven recovered later in the same user turn. Examples include:

- Session 891, call 30720: `7,753 / 0`, then the tool-loop call was
  `5,376 / 6,656`.
- Session 858, call 29223: `142,141 / 0`, then the next call in the same turn
  was `1,762 / 141,824`.
- Session 837, call 28088: `130,257 / 1,536`, then the following turn read
  `129,536`.
- Session 843, call 28351: `140,192 / 1,536`, then the following turn read
  `139,776`.

The small-context examples are especially useful because they are ordinary
text/tool turns, not large images or context-window pressure. The high-context
examples show that a one-request loss can cost a very large prefix.

### Clean OpenCode full misses

There are 19 clean OpenCode full misses. The high-context examples are:

| Call | Session | Previous context | Current context | Cache read | Gap |
|---:|---:|---:|---:|---:|---:|
| 3144 | 129 | 123,347 | 123,763 | 4,096 | 8.0s |
| 1717 | 56 | 276,468 | 276,649 | 6,656 | 103.5s |
| 1062 | 35 | 158,104 | 158,340 | 6,656 | 109.5s |

Calls 1717 and 3144 recovered to roughly the prior cache on their next
model calls in the same turn. OpenCode has no transport diagnostic for either.

## Three Codex JSONL sessions

These sessions were inspected separately because the archive's `codex`
harness records the underlying Codex CLI JSONL rather than Pi's provider path.

### Session 924: PI support

File:

`~/.codex/sessions/2026/07/11/rollout-2026-07-11T16-42-13-019f52ea-94ab-7283-86e0-93b7bcd145ba.jsonl`

The user turn `kk` had:

```text
70,054 input / 14,720 cached
70,141 input / 0 cached       <- full miss
70,301 input / 3,456 cached  <- following image turn
70,344 input / 70,016 cached <- later recovery
```

The `kk` turn itself had no image and no tool call. The raw rollout has no
provider or transport error around it. A no-op `code .` turn occurred between
some of the surrounding turns, so this is not a perfectly controlled sequence.

### Session 932: Claude skill/database work

File:

`~/.codex/sessions/2026/03/09/rollout-2026-03-09T21-25-39-019cd559-859a-7fe2-8a4e-e43492dd4226.jsonl`

The target turn was text-only:

```text
75,723 input / 57,344 cached
76,201 input / 3,456 cached <- full miss
76,862 input / 76,160 cached <- next turn recovery
```

This is the cleanest independent example. The earlier turn contained a very
large tool result whose raw output said it had an original token count around
175k and was truncated, so the history before the target was not simple. The
target turn itself had no image or provider error.

### Session 933: Data Station

File:

`~/.codex/sessions/2026/02/16/rollout-2026-02-16T16-12-04-019c684b-cf11-75e3-8e1a-e802c8eee8ab.jsonl`

The session begins with an image, so it is not a clean image-free fixture:

```text
94,565 input / 90,368 cached
84,779 input / 3,456 cached <- full miss on “ok commit this”
85,677 input / 84,608 cached <- same-turn recovery
```

The context shrinking by about 9.8k at the target is a separate clue for
client-side history reconstruction or compaction-like behavior. There is no
explicit compaction event in the rollout. The two identical archive rows for
the miss are text/reasoning records for one logical response.

### Common Codex clues

- The model, effort/reasoning level, developer instructions, and collaboration
  settings fingerprints were unchanged across turns in all three rollouts.
  The misses are therefore not explained by an obvious turn-context setting
  change.
- These records span Codex versions and models, so the phenomenon is not
  obviously one Pi parser version issue.
- Codex's `cached_input_tokens` is a client-persisted usage counter, not a raw
  capture of the `response.completed` JSON. It is stronger independent evidence
  than the archive alone, but still does not prove whether the provider sent an
  explicit zero or whether Codex normalized an omitted field.

## Partial misses

A partial miss is economically cheaper than a full miss but still loses part of
the reusable prefix. It demonstrates that at least some prefix was recognized;
it does not automatically establish a Codex bug. It can nevertheless be a
heavy effective bust when `missed_tokens` is large. A repeated cache-read value
can indicate a **cache plateau**, but it is not by itself proof of a bust: a
normal prompt extension can also preserve the old cached prefix while adding
an uncached suffix.

The best high-context control found so far is Pi call `27399` in source session
`820`:

```text
previous reusable: 135,680
current cache read: 104,448
retained:           about 77%
previous context:   137,050
current context:    142,416
gap:                about 13.9 minutes
```

The following calls returned to roughly 142k reads. This looks compatible with
partial prefix retention after a long gap, eviction, or a prefix difference;
it is not evidence of a complete reporting failure.

The clean partial cohort has more tool activity than the full cohort and often
retains a substantial fraction of context. Future comparisons should match on
model, context size, gap, tool-output size, turn-call ordinal, and thinking
setting rather than comparing only “full” versus “partial.”

## Recent Codex archive cohort

The Codex-specific query used model provider `openai`, `cause IS NULL`,
`reason IS NULL`, no current-call image flag, and the conservative raw-session
image exclusion described above. Its results are:

| Metric | Result |
|---|---:|
| Sessions | 10 |
| Miss calls | 38 |
| Full misses | 5 |
| Partial misses | 33 |
| Heavy misses (`missed_tokens >= 10,000`) | 22 |
| Largest full miss | 72,267 missed tokens |
| Largest partial miss | 59,239 missed tokens |

All five full misses recovered on the next comparable model call to at least
90% of the prior reusable cache. Seventeen of the 33 partial misses had the
same cache-read value as the preceding call, and several stayed flat across
multiple calls before recovering. These are useful candidates for the
hot-cache -> bust -> hot-cache pattern, but the plateau cases still need
context overlap and next-call recovery before being called genuine busts.

The clean raw blocks around these targets contain ordinary turn, reasoning,
tool, and token-count events, with no explicit WebSocket, timeout, provider
error, or compaction event. Tool calls occur near some examples but not most;
the current/previous model settings are stable. This makes tools a possible
trigger for a subset, not a general explanation.

## Pi transport and reporting behavior

### The zero ambiguity

In the installed Pi AI package, the relevant code is:

`/Users/danclark/.nvm/versions/node/v24.17.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`

`finalizeResponse` currently does:

```js
const inputDetails = response.usage.input_tokens_details;
const cachedTokens = inputDetails?.cached_tokens || 0;
const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
```

It then writes `cachedTokens` to Pi's `usage.cacheRead`. Therefore these cases
are indistinguishable in the saved JSONL:

1. `input_tokens_details.cached_tokens` is explicitly `0`;
2. `input_tokens_details` is omitted;
3. the response has usage metadata but no cached-token detail.

The provider initializes all usage fields to zero before a response is
finalized. The clean full-miss records have nonzero input usage, so they did
receive a usage object, but the saved file cannot tell whether cache metadata
was absent or explicitly zero.

### WebSocket continuation behavior

The installed `openai-codex-responses.js` implementation:

- defaults Pi's configured transport to `auto`;
- supports `sse`, `websocket`, `websocket-cached`, and `auto`;
- sends `prompt_cache_key` derived from the Pi session ID;
- keeps a connection-scoped continuation with `previous_response_id`;
- only sends a delta when the request bodies match except for `input` and the
  prior input items match the continuation;
- clears the continuation after a WebSocket error;
- keeps a session WebSocket idle cache for about five minutes and a maximum
  connection age of about 55 minutes;
- after a WebSocket failure before stream start, records the failure and falls
  back to SSE for the session;
- after a failure after stream start, records the failure and throws rather than
  silently replaying the same request over SSE.

The six structured Pi transport diagnostics found so far are:

- 2026-07-11, `WebSocket error`, before stream start;
- 2026-07-19, `WebSocket error`, before stream start;
- 2026-07-20, `WebSocket error`, after stream start;
- 2026-07-24, `WebSocket closed 1000`, before stream start;
- 2026-07-25, `WebSocket error`, before stream start;
- 2026-08-01, `WebSocket error`, after stream start, request body about 1.05 MB.

Five of those source sessions are image-flagged in the archive. The August 1
session is source session 1094, which is active and excluded from the clean
cohort. Thus the transport evidence still shows that a failure can be followed
by a low-cache request, but it does not explain the 12 clean Pi full misses.

## OpenCode limitations

OpenCode's current SQLite records include assistant usage, model/provider,
finish state, message errors, parts, tool events, and previews. They do not
include:

- raw provider response usage or field presence;
- request body or prompt-cache key;
- WebSocket/SSE transport;
- connection reuse or `previous_response_id`;
- fallback state;
- the underlying error for an aborted message.

Since 2026-06-30 the database contains 31 `MessageAbortedError` records, 24 of
them on OpenAI `gpt-*` models. Their stored error is only `MessageAbortedError`
with detail `Aborted`.

For the 19 clean OpenCode full misses and 44 clean OpenCode partial misses:

- no current or immediately preceding archive call has an OpenCode message
  error;
- no OpenCode error appears in the same source session within five minutes of
  either side of a miss;
- no recent structured provider transport error was found in the database.

This is under-instrumentation, not evidence that OpenCode had no transport
problem. The database cannot distinguish a provider failure from a user or
agent abort.

## Best next experiments, without a fake server

Before generating any new misses, mine the existing archive for the
hot-cache -> heavy-miss -> hot-cache sequence. This is the direct test of the
costly, recoverable-bust hypothesis and requires no synthetic bust or network
fault. For each candidate, compare the preceding/current/following
model-call cache reads, `missed_tokens`, any recorded cache-write tokens,
reported cost, model/settings, tools, gap, and a request/prefix fingerprint if
one is available.

### 0. Mine recoverable bust sequences

Use the preceding call as the hot-cache baseline, the miss call as the
cost-bearing event, and the next compatible call as the recovery check. A
large miss followed by recovery is the desired sequence, not a reason to
discard the candidate. A plateau without evidence of shared prefix overlap or
subsequent recovery should remain provisional because it may be an ordinary
prompt extension.

The lowest-effort new-traffic experiment is then a transport matrix using
Pi's existing settings, not a custom server.

### 1. Compare transport modes

Pi documents a `transport` setting with these values:

- `sse`
- `websocket`
- `websocket-cached`
- `auto` (current default)

Use several fresh, image-free sessions with the same model, stable thinking
level, stable tools, and a long but non-compacting context. Run the same pattern
under each mode:

1. establish a large cached prefix;
2. send a trivial next-turn message;
3. record `cacheRead`, response IDs, and any diagnostics;
4. repeat enough times to separate ordinary cache variance from a pattern.

Interpretation:

- misses only under `auto` or `websocket-cached` point toward connection-scoped
  continuation or fallback behavior;
- misses under `sse` as well point away from WebSocket as the sole cause;
- misses under `websocket` but not `websocket-cached` would implicate the
  difference between a full WebSocket body and the continuation path;
- a missing usage field remains unresolved unless raw response metadata is also
  captured.

### 2. Restart Pi between turns

With `websocket-cached`, send one turn, exit Pi, resume the same session in a
new process, and send a trivial message. The in-memory WebSocket and
`previous_response_id` continuation will be gone, while the session's
`prompt_cache_key` can remain the same.

Compare this with an uninterrupted control. A large read in both cases would
suggest that the server cache is independent of the live continuation. A sharp
loss only after restart would show that connection continuity is materially
important, even if it does not identify whether Pi or the server is responsible.

### 3. Test the five-minute WebSocket idle boundary

The SDK's WebSocket connection cache has an approximately five-minute idle
lifetime. Repeat the same test with a gap shorter than five minutes and a gap
longer than five minutes. This isolates connection reuse more cleanly than
randomly waiting between user turns.

### 4. Toggle Wi-Fi only as a coarse fault injection

Turning Wi-Fi off between completed turns may leave Pi with a stale socket and
exercise the next-request reconnect path, but it does not guarantee a
mid-stream failure. Turning it off immediately after a long response begins is
closer to the observed after-stream-start failures, but is timing-sensitive and
can interrupt unrelated traffic.

Use a disposable test session and preserve the JSONL before experimenting. A
local HTTP proxy configured through Pi's documented `httpProxy` setting or a
firewall rule that terminates the connection is more repeatable than toggling
all network access. A TLS-intercepting proxy must be treated as sensitive: do
not log authorization headers, prompt bodies, images, or tool output.

### 5. Add narrow telemetry later

The useful fields are nullable and should be recorded before normalization:

- whether `response.usage` was present;
- whether `input_tokens_details` was present;
- raw `cached_tokens` value, including null/undefined;
- raw `cache_write_tokens` value;
- transport selected and transport actually used;
- whether a fallback occurred;
- whether the request was full-context or used `previous_response_id`;
- `prompt_cache_key`, response ID, request body byte size, and a redacted body
  hash;
- WebSocket connection created/reused and continuation state.

Pi already has provider hooks such as `onPayload` and `onResponse` in the SDK
path, so a small diagnostic extension or temporary wrapper is more promising
than a full fake provider server.

### 6. Separate parser testing from transport testing

A fixture-level test can feed the finalizer three synthetic completed responses:

```text
cached_tokens: 123
cached_tokens: 0
input_tokens_details omitted
```

The last two should remain distinguishable in diagnostics even though the
legacy session usage field is zero for both. This tests the reporting question
without making a network request.

## Query appendix

### Clean cohort

The core filtering shape is:

```sql
WITH image_sessions AS (
  SELECT DISTINCT t.session_id
  FROM model_calls mc
  JOIN turns t ON t.id = mc.turn_id
  WHERE mc.images IS NOT NULL
)
SELECT cm.status, cm.model_call_id, cm.previous_model_call_id,
       cm.previous_context_tokens, cm.current_context_tokens,
       cm.actual_cache_read_tokens, cm.gap_ms,
       src.harness, m.provider, m.name AS model,
       ss.id AS source_session_id, s.title
FROM cache_misses cm
JOIN model_calls mc ON mc.id = cm.model_call_id
JOIN models m ON m.id = mc.model_id
JOIN turns t ON t.id = mc.turn_id
JOIN sessions s ON s.source_session_id = t.session_id
JOIN source_sessions ss ON ss.id = t.session_id
JOIN sources src ON src.id = ss.source_id
WHERE cm.cause IS NULL
  AND cm.reason IS NULL
  AND (
    (src.harness = 'opencode' AND m.provider = 'openai') OR
    (src.harness = 'pi' AND m.provider = 'openai-codex')
  )
  AND m.name GLOB 'gpt-*'
  AND mc.started_at >= strftime('%s', '2026-06-30') * 1000
  AND ss.id <> 1094
  AND t.session_id NOT IN (SELECT session_id FROM image_sessions)
ORDER BY mc.started_at;
```

### OpenCode stored errors

```sql
SELECT datetime(time_created / 1000, 'unixepoch', 'localtime'),
       json_extract(data, '$.providerID') AS provider,
       json_extract(data, '$.modelID') AS model,
       json_extract(data, '$.error.name') AS error_name,
       json_extract(data, '$.error.data.message') AS error_detail
FROM message
WHERE time_created >= strftime('%s', '2026-06-30 00:00:00') * 1000
  AND json_extract(data, '$.error.name') IS NOT NULL
ORDER BY time_created;
```

### Raw session summaries

```bash
bash tools/pi-session-debug.sh /path/to/pi-session.jsonl
bash tools/codex-session-debug.sh /path/to/rollout.jsonl
```

The Pi script is useful for context/cache sequences and regression flags. It
cannot recover whether a zero came from an omitted provider field because that
information is already lost in the JSONL usage object.

## What is not established

- A full miss is not proven to be a provider-side cache deletion.
- A Pi zero is not proven to be a false report.
- A WebSocket failure is not proven to be necessary for a full miss.
- A WebSocket failure is not proven to be irrelevant; the excluded diagnostic
  sessions remain suggestive.
- A recovered miss is not harmless: recovery is consistent with the miss call
  having rebuilt a usable cache prefix.
- A cache plateau or turn-level cached percentage is not sufficient by itself
  to call a request a genuine bust.
- The current archive cannot prove exact prompt-prefix identity between two
  requests.
- The OpenCode database cannot reconstruct the underlying transport failure.

All analysis behind this document was read-only. No reproduction, network
fault injection, code change, test, build, or type check was performed.
