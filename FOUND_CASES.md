# Found cache-miss cases

Small, evidence-based notes from the local Pi/Codex telemetry extension and
WebSocket wiretap. A normalized `cacheRead: 0` is not by itself proof that the
provider explicitly reported `cached_tokens: 0`; the raw wiretap is needed for
that, and it only covers WebSocket traffic.

## Case 001 — WebSocket stream failure, then SSE full-context retry

**Date:** 2026-08-03  
**Harness/provider:** Pi / `openai-codex`  
**Model:** `gpt-5.6-sol`

### Identifiers

- Archive source session ID: `1110`
- Pi session ID: `019fc515-9dc2-78ed-ae36-95342bb646ae`
- Pi turn/call: turn 4, archive call 11
- Archive model-call ID: `83288`
- Archive `source_call_id`: `b69dc57f`

The raw session summary labels the miss as `4.12` because an unarchived failed
attempt appears immediately before it. The archive database calls the observed
completed miss call 11.

### Artifacts

```text
Session:
~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-03T00-45-56-035Z_019fc515-9dc2-78ed-ae36-95342bb646ae.jsonl

Telemetry:
~/.pi/agent/diagnostics/cache-telemetry/2026-08-03T00-45-56-035Z_019fc515-9dc2-78ed-ae36-95342bb646ae.jsonl

WebSocket wiretap:
~/.pi/agent/diagnostics/cache-telemetry/wiretap/codex-websocket-2026-08-03T00-45-55Z-90637.jsonl
```

Use `tools/pi-cache-telemetry/triage.md` to resolve the archive row and inspect
these artifacts without printing raw prompts or tool bodies. The safe session
summary is:

```bash
bash tools/pi-session-debug.sh \
  ~/.pi/agent/sessions/--Users-danclark-programming-frugal-tokens--/2026-08-03T00-45-56-035Z_019fc515-9dc2-78ed-ae36-95342bb646ae.jsonl
```

### Observed sequence

1. Turn 4 call 10 was warm: `cacheRead=111104`.
2. An extra attempt (`telemetry sequence=36`, raw Pi message `9f97a4a4`)
   started a WebSocket continuation with `previous_response_id` and a one-item
   input delta.
3. The WebSocket began streaming, including 1,848 function-call argument
   delta frames, but never emitted a terminal response frame.
4. The wiretap recorded:
   - `01:11:19.536Z`: WebSocket `error`, empty message, type `error`
   - `01:11:19.537Z`: close code `1006`, empty reason, `wasClean=false`
   - client cleanup immediately afterward: close code `1000`, reason `done`
5. Pi telemetry recorded `WebSocket error`, phase
   `after_message_stream_start`, `websocketFailures=1`, `deltaRequests=1`, and
   `fallbackActive=true`.
6. Archive call 11 (`telemetry sequence=37`) then completed over SSE using the
   full logical input (`163` items, `940250` bytes), with exact prefix and
   unchanged envelope fingerprints. It reported `cacheRead=0`,
   `uncached_input=113517`, and cost `$0.684705`.
7. The following call recovered to `cacheRead=112128`.

The wiretap captured partial function-call arguments locally, but the
accumulated approximately 6.5 KB was incomplete JSON and had no corresponding
`function_call_arguments.done` or response terminal event. It was therefore not
safe to inject as a completed tool call or conversation turn.

### Assessment

This is strong evidence for a **transport-triggered transient cache bust**:

```text
warm WebSocket continuation
-> abnormal WebSocket close
-> full-context SSE retry / normalized zero read
-> warm cache recovery
```

The failure is not proven to be specifically on OpenAI's side: close code 1006
can result from the provider edge, an intermediary network, or the local
WebSocket runtime. It does not look like a structured payload or cache-key
rejection because the continuation was accepted and streamed for about a
minute before the connection disappeared.

The raw provider `cached_tokens` state for the miss is **unavailable** because
that request used SSE, which the WebSocket wiretap does not capture.

## Working hypothesis for future cases

This pattern could explain **some** Codex CLI misses, and possibly other
clients using the same OpenAI WebSocket/continuation path. It cannot currently
explain all OpenCode or Codex misses: OpenCode may use a different transport,
and a zero read without a transport failure may be a provider/cache event,
metadata omission, prompt change, image/tool-output discontinuity, or another
cause.

A useful match signature is:

```text
warm read
-> WebSocket error/abnormal close or fallback
-> zero/low read on a full-context retry
-> warm read afterward
```

For each additional case, record the session, telemetry file, optional wiretap,
archive model-call ID, preceding/current/following cache reads, continuation
state, close/failure details, and whether raw `cached_tokens` was actually
present.
