# Frugal Tokens Handoff

## Background

Frugal Tokens is a working name for a local-first tool that explains the token
economics of AI coding sessions. The immediate goal is to get a useful UI into
the world quickly, use it to make the data tangible, and iterate from direct
feedback rather than designing the entire product in advance.

The first data source is OpenCode. The application should read OpenCode's local
session data and help answer questions such as:

- How many user turns and model calls were in a session?
- How many tokens were uncached input, cache reads, cache writes, output, and
  reasoning?
- What did each model call cost according to OpenCode?
- What would it cost using our own versioned pricing data?
- Where did cache hits, partial hits, probable expirations, and rewrites occur?
- How much did caching save compared with processing every prompt uncached?

The initial product is an exploratory local web application, not an enterprise
telemetry platform. Favor working software and fast feedback over speculative
infrastructure.

## Initial Product

Build a single-page application that can:

1. List local OpenCode sessions.
2. Open a session and group its model calls by user turn.
3. Show token and cost breakdowns for each model call.
4. Summarize cache reads, writes, outputs, and costs for the session.
5. Compare OpenCode's reported cost with an independently reconstructed cost.
6. Start supporting simple counterfactuals, especially a no-cache estimate.

The exact UI and internal domain model are intentionally not finalized. Use the
models below as a lens and a starting point, then refine them with the user as
the UI makes shortcomings visible.

Do not define a large API contract before the first screens exist.

## Proposed Stack

Use a small, conventional application:

- Deno backend
- Hono HTTP server
- React SPA built with Vite
- TanStack Router for client-side routing
- Zod for shared runtime schemas and inferred TypeScript types

Do not begin with TanStack Start, SSR, Remix-style server functions, tRPC, a
cloud database, authentication, or a package monorepo. The browser needs a
local backend because it cannot directly read OpenCode's SQLite database.

During development, Vite can proxy `/api` to the Deno server. For a production
local build, Hono can serve both the JSON API and the built SPA so the tool runs
as one process.

Use the latest stable releases available when implementation begins. Check the
official documentation and package registries at that time instead of trusting
version numbers copied into this document. Confirm that the chosen Deno SQLite
driver can open the database read-only.

## Shared Types

Use shared Zod schemas in a normal source directory, for example:

```text
src/
  client/
  server/
  shared/
    sessionSchemas.ts
    pricingSchemas.ts
```

The backend can construct and validate response objects with these schemas. The
frontend can import the inferred types and optionally parse responses at the
network boundary:

```ts
export const modelCallSchema = z.object({
  // Provisional fields; refine while building the UI.
})

export type ModelCall = z.infer<typeof modelCallSchema>
```

This provides runtime validation and shared types without adding tRPC. Hono's
typed client may be evaluated later, but it is not required for the MVP.

## OpenCode Storage

The local database inspected on macOS is:

```text
~/.local/share/opencode/opencode.db
```

Treat the location as a default, not a universal constant. Allow it to be
overridden and account for platform differences later.

Open the database read-only. Never mutate OpenCode's database. Its schema is an
implementation detail and may change between OpenCode versions, so isolate SQL
and JSON decoding in an OpenCode adapter or repository.

The relevant tables observed on July 10, 2026 are `session`, `message`, and
`part`.

### `session`

Relevant columns include:

```text
id
project_id
parent_id
directory
title
version
time_created
time_updated
time_compacting
time_archived
model
cost
tokens_input
tokens_output
tokens_reasoning
tokens_cache_read
tokens_cache_write
metadata
```

`model` and `metadata` are JSON text. Token and cost columns are denormalized
session totals. They are useful for quick summaries, but calculations should be
reconcilable against individual assistant messages.

### `message`

Observed table shape:

```text
id           TEXT PRIMARY KEY
session_id   TEXT
time_created INTEGER
time_updated INTEGER
data         TEXT (JSON)
```

Assistant-message JSON contains the fields needed for per-call analysis:

```ts
type AssistantMessageUsage = {
  role: "assistant"
  providerID: string
  modelID: string
  cost: number
  time: {
    created: number
    completed?: number
  }
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}
```

The exact JSON contains additional fields and can evolve. Parse external data
defensively rather than assuming every record is complete.

In the sessions inspected, `tokens.input` represented uncached input. Total
prompt input for a model call was:

```text
prompt input = input + cache.read + cache.write
```

OpenCode's displayed context total for the latest completed model call was:

```text
context total = input + cache.read + cache.write + output + reasoning
```

Validate these semantics against the installed OpenCode version and provider.
Provider SDKs do not all report token categories identically.

### `part`

Observed table shape:

```text
id           TEXT PRIMARY KEY
message_id   TEXT
session_id   TEXT
time_created INTEGER
time_updated INTEGER
data         TEXT (JSON)
```

Parts describe text, reasoning, tool calls, tool results, and model-call step
boundaries. Useful JSON fields observed include:

```text
type
tool
text
state.output
```

The MVP does not need to read or display prompt content. Part metadata and
output sizes can later explain where uncached input came from, such as a large
file read or web fetch. Avoid exposing sensitive prompt, file, or tool-output
content by default.

## Turns And Model Calls

A user turn and a model call are not the same thing.

- A user message begins a user turn.
- One user turn can cause several model calls through tool-use loops.
- Each completed assistant message with non-zero token usage represents a model
  call for analytical purposes.
- An in-progress assistant record can exist with all token fields set to zero;
  ignore it until usage is populated.

To group an existing session, order messages by `time_created` and `id`, then
increment the turn number at each user message. Associate following assistant
model calls with that turn until the next user message.

Model-call timestamps matter more than user-message timestamps for cache
analysis. Tool start and completion times may later explain why the gap between
model calls exceeded a cache TTL.

## Provisional Normalized Model

This is a starting point, not a settled contract:

```ts
type ModelCall = {
  harness: "opencode" | "claude-code" | string
  harnessVersion?: string

  sessionID: string
  sessionTitle?: string
  userTurn: number
  callWithinTurn: number

  provider: string
  model: string
  variant?: string

  startedAt: number
  completedAt?: number
  gapSincePreviousCallMs?: number

  tokens: {
    uncachedInput: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
  }

  cost: {
    reported?: number
    reconstructed?: number
    currency: "USD"
    pricingVersion?: string
  }
}
```

Preserve provider-specific raw usage separately where practical. Normalization
can discard details needed by later pricing or cache simulations.

## Cost Semantics

Keep distinct cost concepts instead of treating one number as authoritative:

```text
reported cost       Cost stored by OpenCode
reconstructed cost  Usage priced with Frugal Tokens' catalog
invoice cost        Provider billing, only when actually available
counterfactual cost Simulated cost under another cache policy
```

Call reconstructed results "API-equivalent estimates" when the user may be
using a subscription or gateway rather than direct per-token API billing.

Pricing data must be versioned by effective date. Depending on the provider,
cost can vary by model, context tier, cache TTL, processing mode, region, and
gateway markup. Avoid permanently hard-coding current prices into analytical
logic.

OpenCode's recorded cost can lag provider pricing. In particular, GPT-5.6
introduced billable cache writes on July 10, 2026. OpenAI documents
`cache_write_tokens` in the response, while the OpenCode installation and
source inspected during discovery recorded cache reads but zero cache writes
for GPT-5.6 calls. Re-check this behavior against the current OpenCode version
when implementation begins.

## Initial Derived Metrics

Useful early metrics include:

- User turns and model calls
- Calls per user turn
- Prompt input per call
- Cache-read and cache-write tokens
- Cache-read share of prompt input
- Output and reasoning tokens
- Reported and reconstructed cost
- Cost per user turn and model call
- Time gap between model calls
- Probable cache hits, partial hits, misses, and rewrites

Use cautious language for causes. A long gap followed by zero reads and a full
write is a probable TTL expiration, but a miss can also come from changed tool
definitions, changed instructions, prefix mutation, routing, or eviction.

## Counterfactuals

The first counterfactual should be no caching because it can be computed from
observed usage with relatively few assumptions:

```text
no-cache input cost =
  (uncached input + cache reads + cache writes) * base input price
```

Output and reasoning costs remain as observed.

Five-minute versus one-hour TTL simulations are promising but require stronger
information to be exact. A future live collector could record model-call and
tool-call timing, cache breakpoint lengths, and privacy-preserving keyed hashes
of cacheable prefixes. That would help distinguish expiration from prompt
invalidation without collecting prompt content.

## Reference Session

This OpenCode session is a useful real-world fixture:

```text
Session:  ses_0b8d314b5ffeBwIBzZmNhmoVCi
Model:    claude-opus-4-8
Turns:    3 user turns
Calls:    5 model calls
Cost:     $0.4861795 reported
```

Its model calls showed:

| Turn | Call | Input | Cache read | Cache write | Output | Cost |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 0 | 20,057 | 98 | $0.127816 |
| 1 | 2 | 2 | 20,057 | 1,966 | 3,396 | $0.107226 |
| 2 | 1 | 2 | 22,023 | 3,478 | 627 | $0.048434 |
| 3 | 1 | 2 | 0 | 26,229 | 104 | $0.166541 |
| 3 | 2 | 2 | 26,229 | 378 | 827 | $0.036162 |

Turn 2 occurred about 2 minutes and 22 seconds after the preceding model call
and reused the cache. Turn 3 occurred about 13 minutes and 38 seconds later;
the read dropped to zero and almost the entire prompt was rewritten. The next
call four seconds later read the recreated cache. This is a strong example of a
probable five-minute TTL expiration and immediate reuse.

At then-current Opus prices, the observed session cost was about $0.486180. A
simple no-cache estimate was about $0.728435. This fixture can validate the
first decoder, grouping logic, pricing calculation, and UI.

## Future Possibilities

These ideas should influence extensibility but not expand the MVP:

- Import Claude Code and other harness data through separate adapters.
- Explain tool calls that add unusually large amounts of uncached context.
- Simulate five-minute, one-hour, and no-cache policies.
- Add a live OpenCode plugin for richer timing and provider metadata.
- Aggregate privacy-conscious telemetry within an organization.
- Detect harness or provider regressions from changes in cache effectiveness,
  tool duration, tokenization, or cost.
- Offer opt-in, cohort-level ecosystem benchmarks.

Token telemetry can diagnose computational and workflow efficiency. It should
not be treated as an individual productivity score. Any future collection
should default to local processing, exclude content, require explicit consent,
and avoid employee leaderboards.

## MVP Boundaries

Start read-only and local. Do not initially build:

- User accounts or authentication
- Hosted ingestion
- Organizational dashboards
- Cross-user comparisons
- Prompt-content collection
- A plugin system
- Exact TTL attribution
- A generalized provider framework beyond what the first UI needs

The next session should inspect this document, verify the current OpenCode
schema and current stable dependency versions, then scaffold the smallest
end-to-end slice that lists sessions and opens one session's model-call
breakdown.
