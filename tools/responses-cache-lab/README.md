# Responses Cache Lab

`responses-cache-lab` is a small, deterministic research harness for raw OpenAI
Responses API usage reporting. It calls the standard HTTP endpoint with native
`fetch`, stores the exact response body, and reports whether cache metadata was
explicit, omitted, or malformed.

It is intentionally not an autonomous agent. A scenario describes the calls;
another model or controller can generate or edit that JSON and invoke the CLI
again.

## Run

The repository's `.env` can be loaded by Deno. The key is read only from the
environment and is never accepted as a command-line argument:

```bash
deno run --env-file=.env \
  --allow-env=OPENAI_API_KEY,OPENAI_BASE_URL,RESPONSES_CACHE_LAB_DIR,HOME,USERPROFILE \
  --allow-read --allow-write --allow-net \
  tools/responses-cache-lab/main.ts run \
  --scenario tools/responses-cache-lab/scenarios/text-warm-follow-up.json
```

The default model is currently pinned to `gpt-5.6-luna`, and the checked-in
scenarios use that model. `--model` remains available for an explicit comparison
or if the model is not enabled for the API key. Do not assume a Pi Codex model
is available through a normal OpenAI API key.

Useful options:

```text
--format json          Emit the manifest for a controller or another model.
--scenario -           Read scenario JSON from stdin.
--model ID             Override the pinned/scenario model.
--reasoning-effort X   Set none, minimal, low, medium, high, or xhigh.
--reasoning-mode pro   Use GPT-5.6 pro reasoning mode when available.
--base-url URL         Override OPENAI_BASE_URL.
--output-dir PATH      Override the diagnostics root.
--capture-request      Store raw request JSON; off by default.
--stream / --no-stream Override the scenario's stream setting.
--timeout-ms N         Abort one request after N milliseconds; no retries occur.
--dry-run              Validate scenario JSON without making a request.
```

For example, a driver can provide a new experiment without writing a file:

```bash
printf '%s' "$SCENARIO_JSON" | deno run --env-file=.env \
  --allow-env=OPENAI_API_KEY,HOME --allow-read --allow-write --allow-net \
  tools/responses-cache-lab/main.ts run --scenario - --format json
```

## Scenario Format

The canonical form uses a sequence of new logical input items. In `full-replay`
mode the harness accumulates prior response output and sends the full logical
input on every request. In `previous-response-id` mode each call sends only its
new input and references the preceding response ID.

```json
{
  "id": "text-warm-follow-up",
  "model": "gpt-5.6-luna",
  "mode": "full-replay",
  "reasoning": { "effort": "medium" },
  "store": false,
  "instructions": "Answer briefly.",
  "prompt_cache_key": "responses-cache-lab-text-v1",
  "delay_ms": 0,
  "calls": [
    {
      "id": "warm",
      "input": [
        {
          "role": "user",
          "content": [
            { "type": "input_text", "text": "Establish a stable test prefix." }
          ]
        }
      ]
    },
    {
      "id": "follow-up",
      "input": [
        {
          "role": "user",
          "content": [
            {
              "type": "input_text",
              "text": "Now answer with one short sentence."
            }
          ]
        }
      ]
    }
  ]
}
```

`initial_input` and `follow_up_input` are accepted as a shorthand for the two
entries in `calls`. Each input may be a string or a JSON array of Responses
input items. A scenario must contain at least two calls. `delay_ms` may also be
set on an individual call. The delay is between high-level scenario calls, not
between a model response and its deterministic tool continuation.

For a checked-in deterministic text fixture, a call may use `input_file` instead
of `input`. The path is resolved from the working directory, read once at run
time, and wrapped as one user text item. This is explicit fixture loading, not a
model-controlled filesystem tool.

The following fields are supported:

| Field              | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `model`            | Standard Responses API model ID; defaults to `gpt-5.6-luna`.              |
| `mode`             | `full-replay` or `previous-response-id`.                                  |
| `reasoning`        | Optional raw reasoning object; examples use `{ "effort": "medium" }`.     |
| `input_file`       | Optional deterministic text fixture path used instead of `input`.         |
| `store`            | Defaults to `false` for replay and `true` for previous-response mode.     |
| `instructions`     | Optional Responses API instructions string.                               |
| `tools`            | Optional function tools only. Built-in and filesystem tools are rejected. |
| `tool_outputs`     | Static output values keyed by function name.                              |
| `prompt_cache_key` | Optional stable cache key sent on every request.                          |
| `stream`           | Optional SSE mode. Non-streaming is the default.                          |
| `max_tool_rounds`  | Maximum deterministic function-call continuations, default 4.             |

The runner never executes a shell command, reads a real filesystem tool, or asks
a model to decide what to do next. If a response contains a function call, the
matching `tool_outputs` value is required. A string is sent as-is; other JSON
values are serialized. For deterministic large output, use this bounded
descriptor:

```json
"tool_outputs": {
  "get_fixture": {
    "text": "fixed deterministic tool text ",
    "repeat": 10000
  }
}
```

### Reasoning Control

The `reasoning` object is sent in the raw request. The main control is effort:

```json
"reasoning": { "effort": "high" }
```

Supported effort values are `none`, `minimal`, `low`, `medium`, `high`, and
`xhigh`. The CLI override is useful when the same scenario is run at several
settings:

```bash
deno run --env-file=.env --allow-env=OPENAI_API_KEY,HOME \
  --allow-read --allow-write --allow-net tools/responses-cache-lab/main.ts run \
  --scenario tools/responses-cache-lab/scenarios/full-replay.json \
  --reasoning-effort high
```

`reasoning.mode: "pro"` is also accepted for GPT-5.6 deployments that expose
that mode. Effort is a budget/control request, not a promise of an exact
reasoning-token count. The provider-reported actual count is captured from
`usage.output_tokens_details.reasoning_tokens`. This harness does not request,
print, or separately persist hidden chain-of-thought text.

## Stored Data And Privacy

Runs default to:

```text
~/.local/share/frugal-tokens/diagnostics/responses-cache-lab/<run>/
```

`RESPONSES_CACHE_LAB_DIR` or `--output-dir` changes the root. Directories are
created with mode `0700` and files with mode `0600` where the filesystem
supports those modes.

Each run contains:

```text
manifest.json              Call metadata and safe usage-shape summaries.
raw-responses/0001.json    Exact non-streaming response bytes.
raw-responses/0001.sse     Exact SSE response bytes when streaming.
requests/0001.json         Only with explicit --capture-request.
```

Request bodies are hashed and sized by default but are not written. Raw request
capture can contain prompts, tool output, and images, so opt in deliberately.
Authorization headers and API keys are never written. Only a small allowlist of
non-secret response headers is retained in the manifest. Raw responses may
contain model output and must be treated as sensitive.

The large-prefix example reads the checked-in `fixtures/stable-prefix.txt` file.
Do not point `input_file` at credentials or other private files unless you
intentionally want to send them to the provider.

## Usage Shape

For each call the manifest records:

- scenario ID, call ID, ordinal, start time, elapsed time, and call kind;
- HTTP status, safe response headers, response ID, response status, stop status,
  incomplete reason, and error status;
- exact raw response path and response byte size;
- whether `usage` and `input_tokens_details` exist, plus their keys;
- raw `cached_tokens` and `cache_write_tokens` field states, including missing,
  explicit `undefined`, `null`, and values;
- raw `input_tokens`, `output_tokens`, `total_tokens`, and reasoning token
  fields when present;
- request body SHA-256, request byte size, and optional request body path.

Cache classification is deliberately shape-oriented:

| Classification          | Meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `explicit-zero`         | `input_tokens_details.cached_tokens` is numeric zero. |
| `omitted-cache-details` | `usage` exists but `input_tokens_details` does not.   |
| `omitted-cached-tokens` | Details exist but the `cached_tokens` key does not.   |
| `nonzero`               | `cached_tokens` is a positive integer.                |
| `malformed/unexpected`  | Cache fields have an unexpected type or value.        |
| `usage-missing`         | The response has no usable `usage` object.            |

These are provider-reported fields. A nonzero value does not prove the
provider's internal cache state, and an explicit zero does not by itself prove
why a prefix was not read.

## Standard API Versus Pi/Codex

This tool uses:

```text
POST https://api.openai.com/v1/responses
Authorization: Bearer OPENAI_API_KEY
```

It does not use the official SDK, Pi, the ChatGPT Codex backend, or a WebSocket.
Native `fetch` is used specifically so the raw response JSON or SSE body is
available before any client normalization.

Pi's investigated `openai-codex-responses` implementation is a different
provider path. It uses a ChatGPT backend, ChatGPT account-token headers,
WebSocket continuation when configured or selected by `auto`, and
`previous_response_id` state held by the connection. Its finalizer currently
maps an omitted cache detail and an explicit `cached_tokens: 0` to the same
normalized `cacheRead: 0`.

The harness is therefore an independent standard-API control, not an exact Pi
reproduction. Similar input, cache-read, cache-write, output, timing, and
request-fingerprint concepts can be compared, but endpoint, authentication,
transport, continuation state, model availability, and response normalization
are not directly comparable. A future Codex/WebSocket probe should be a separate
clearly labeled transport path rather than being hidden behind this standard API
result.

## Interpreting A Sequence

The useful pattern is:

```text
warm cache -> one low/zero-read request -> cache rebuild -> warm cache
```

Compare individual calls in `manifest.json`, not only a turn average. A later
hot call is evidence that a usable prefix was available again; it does not make
the earlier low-read call free. Missing cache metadata should remain a reporting
ambiguity rather than being treated as a proven miss.

The harness does not add retries, synthetic failures, or fake providers. A
network error, timeout, incomplete response, and cache classification remain
separate fields.

## Comparing With Pi Telemetry

For a matching Pi session, use the existing privacy-safe summary and telemetry
files:

```bash
bash tools/pi-session-debug.sh /path/to/pi-session.jsonl
jq -r 'select(.event == "provider_request" or .event == "assistant_completion") |
  [.event, .sequence, .timestamp, (.payload.bytes // ""),
   (.usage.input // ""), (.usage.cacheRead // ""), (.stopReason // ""),
   (.websocketDelta.usedPreviousResponseId // "")] | @tsv' \
  "$HOME/.pi/agent/diagnostics/cache-telemetry/<session>.jsonl"
```

Match model, provider, logical-prefix continuity, tool/image presence, prompt
cache key strategy, call ordinal, and idle gap where possible. Keep Pi's
WebSocket counters and diagnostics separate from this harness's standard HTTP
status and raw usage shape. In particular, do not use a later Pi cache hit to
erase the cost or ambiguity of the earlier call.

## Tests

The usage extractor has fixture-level tests and does not require network access:

```bash
deno test --allow-read tools/responses-cache-lab/usage.test.ts
```

The tests cover nonzero, explicit zero, omitted details, omitted cached-token
key, missing usage, and malformed cache fields.

## Examples

The checked-in scenarios are pinned to `gpt-5.6-luna`. Pass `--model` to compare
another model:

```text
scenarios/text-warm-follow-up.json
scenarios/hello-world.json
scenarios/small-tool-output.json
scenarios/large-tool-output.json
scenarios/image-vs-no-image.json
scenarios/idle-gap.json
scenarios/full-replay.json
scenarios/previous-response-id.json
scenarios/large-prefix-warm-follow-up-recovery.json
```
