# Harness Storage Reference

This document records how supported AI coding harnesses store data and how
Frugal Tokens maps that data into shared concepts. Keep source observations
separate from derived metrics and provider-specific inferences.

## Shared Vocabulary

- **Session:** A harness conversation or task container.
- **User turn:** Begins with a user message and ends before the next user
  message.
- **Model call:** A completed assistant invocation with non-zero token usage.
- **Tool event:** A tool invocation associated with a model call.
- **Subagent:** A child session launched by a tool event.

## OpenCode

### Source

- Format: SQLite
- Normal path on macOS: `~/.local/share/opencode/opencode.db`
- Frugal Tokens path: required `OPENCODE_DB_PATH` environment variable
- Access: read-only; never mutate the OpenCode database
- Schema observed on July 10, 2026 with OpenCode 1.17.x

OpenCode's schema is an implementation detail and may change. Keep SQL and raw
JSON decoding isolated in the OpenCode repository.

### Storage Structure

```text
project
  -> session
    -> message
      -> part

session
  -> child session (session.parent_id)
```

Core tables and relationships:

| Table | Purpose | Relationship |
|---|---|---|
| `project` | Worktree and VCS metadata | `session.project_id -> project.id` |
| `session` | Conversation, totals, model, and parent | `session.parent_id -> session.id` |
| `message` | User and assistant records as JSON | `message.session_id -> session.id` |
| `part` | Text, reasoning, tools, and step boundaries | `part.message_id -> message.id` |
| `workspace` | Optional branch/workspace metadata | `session.workspace_id -> workspace.id` |

The current local database has no `workspace` rows, so historical Git branches
are not available for the sessions inspected.

### Canonical Mapping

| OpenCode data | Frugal Tokens concept |
|---|---|
| `session` row | Session |
| `message.data.role = "user"` | User-turn boundary |
| Assistant message with non-zero usage | Model call |
| `part.data.type = "tool"` | Tool event |
| `part.data.type = "compaction"` | Context-transition event |
| Session with `parent_id` | Subagent session |
| `task` part metadata `sessionId` | Link from tool event to subagent |

Order messages by `time_created, id`. Each user message starts a turn; following
assistant calls belong to that turn until the next user message. One turn may
contain many calls because each tool-use loop invokes the model again.

Ignore assistant records whose reported token usage is entirely zero.

### Compaction

OpenCode records a durable compaction signal as a synthetic user message with a
part whose `data.type` is `compaction`. The following assistant call generates
the compacted summary. Frugal Tokens preserves that call's usage and cost but
does not retain its generated summary text.

The normalized context event is attached immediately before the first later
model call whose provider request uses the compacted context. This may be in
the same turn or a later user turn. If the session ends before another model
call, the event remains session-level with no inferred boundary. Token changes
alone never create a compaction event or establish its boundary.

Cache hit, partial-miss, and full-miss outcomes remain token-derived. A partial
or full miss on the explicitly affected call is additionally classified as
compaction-related; an unbounded event cannot explain a specific miss.

The normalized event contract is harness-independent: event type, session
ownership, source order, optional timestamp, and optional affected model call.
Current source support is:

| Harness | Compaction support |
|---|---|
| OpenCode | Explicit `compaction` part; affected call resolved when present |
| Claude Code | Explicit `system/compact_boundary`; affected call resolved when present |
| Codex | Source signal and ordering not yet investigated |
| PI | Explicit JSONL `compaction` record; affected call resolved when present |

PI compaction support currently follows the importer's existing linear,
append-order interpretation of a session file. A verified persisted event had
`type`, `id`, `parentId`, `timestamp`, and `summary`; optional fields described
elsewhere such as `firstKeptEntryId`, `tokensBefore`, and `fromHook` were absent.
The summary is not retained. Because PI does not persist a separate assistant
usage record for summary generation in this fixture, the first later assistant
call with usage is the affected provider request. Branch reconstruction remains
out of scope.

Claude Code records a compaction as a system entry with subtype
`compact_boundary`. A verified manual event included optional metadata such as
pre/post token counts and preserved-message UUIDs, but normalized detection
uses only the explicit type/subtype and record order. The generated summary is
a later synthetic user record that does not start a normalized turn and is not
retained. The first later assistant message with usage is the affected provider
request. `/compact` command text and cache-token changes are not detection
signals.

### Usage And Cost

Assistant message JSON supplies:

```text
tokens.input
tokens.cache.read
tokens.cache.write
tokens.output
tokens.reasoning
cost
```

Frugal Tokens currently derives these internal fields, displayed as New input
and Total activity:

```text
freshPrompt (New input) = input + reported cache write
processed (Total activity) = input + cache read + cache write + output + reasoning
```

Interpret these as reported billing categories, not globally unique text.
Provider semantics differ:

- xAI/Grok implicit caching reports discounted reads but no distinct writes.
- Anthropic reports explicit cache writes and reads.
- A zero write in OpenCode may mean no write was reported, not that no cache was
  populated.
- Reasoning and total-token fields do not always reconcile exactly for every
  provider. Preserve raw values where practical.

OpenCode-reported cost, reconstructed cost, invoice cost, and counterfactual
cost are separate concepts.

### Tools And Subagents

Tool parts expose privacy-safe metadata including tool name, status, and start
and completion times. Inputs and outputs may contain sensitive paths, commands,
file contents, or web data and should not be displayed by default.

Subagents are complete child sessions. Link them using both:

```text
child session.parent_id = parent session.id
task part.state.metadata.sessionId = child session.id
```

The resulting hierarchy is recursive:

```text
session -> turn -> model call -> task tool -> subagent session -> turn -> ...
```

Keep parent-only, child-only, and combined usage distinct to avoid double
counting child sessions that also appear in the session list.

### Other Metadata

Useful but not currently required fields include session directory, project
worktree, VCS, harness version, agent, retries, errors, and
Git tree snapshots. A snapshot is a Git tree object, not a commit or branch.

Absolute paths, branch names, filenames, URLs, prompts, reasoning, patches,
commands, and tool outputs should be treated as sensitive user data.

### Implementation Pointers

- Shared normalized schemas: `src/shared/sessionSchemas.ts`
- SQLite adapter and raw decoders: `src/server/opencodeRepository.ts`
- API routes: `src/server/main.ts`
- Session UI: `src/client/SessionsPage.tsx`
- Reference fixture: `ses_0b8d314b5ffeBwIBzZmNhmoVCi` (3 turns, 5 calls,
  `$0.4861795` reported)
- Subagent fixture: `ses_0b155ab5affer9adyuA3Gg2Br8`

## Claude Code

### Source

- Format: JSONL transcripts and optional JSON metadata
- Frugal Tokens path: required `CLAUDE_CODE_PROJECT_PATH` environment variable
- Normal default: `~/.claude/projects/<encoded-cwd>`
- Version observed: Claude Code 2.1.202
- Access: read-only

Each top-level `<session-id>.jsonl` is a session. Use the latest timestamp in
the transcript for session activity and ordering; copied-file modification
times are not authoritative. Assistant records sharing a `message.id` are
streaming fragments of one model call: merge their distinct content blocks and
count their usage once. Keeping only the last fragment can lose text or tool
activity.

A turn starts at a human or typed prompt, an SDK prompt, a rendered `❯ ...`
command prompt, or the initial prompt in a sidechain transcript. Metadata and
intermediate local-command records, including `isMeta`, `<command-name>`,
`<local-command-stdout>`, and command caveats, do not start turns. Tool-result
user records remain in the current turn. SDK sessions are regular sessions,
not subagents.

Assistant content blocks map `text`, `thinking`, and `tool_use` to call
activity. A later user `tool_result` block supplies completion/error status.
Agent results expose an `agentId`, which links to
`<session-id>/subagents/agent-<agentId>.jsonl`; the matching `.meta.json`
provides the description and parent tool-use ID.

Model identity is recorded per call. Commands such as `/model` can therefore
produce sessions containing calls from multiple models. If Claude provides no
generated title, use the first genuine prompt as the display-title fallback.

Claude usage maps as follows:

| Claude Code field | Frugal Tokens field |
|---|---|
| `input_tokens` | `uncachedInput` |
| `cache_read_input_tokens` | `cacheRead` |
| `cache_creation_input_tokens` | `cacheWrite` |
| input plus cache creation | `freshPrompt` |
| `output_tokens` | `output` |

Current normalized-model gaps:

- Thinking is included in Claude's output tokens, so `reasoning` remains zero;
  `hasReasoning` still reflects the presence of a thinking content block.
- Transcripts do not report dollar cost, so `reportedCost` remains absent.
- Server-side web search/fetch billing units, turn duration, branch changes,
  and structured tool payloads are not represented in the current shared
  schema.

The normalized model preserves aggregate, 5-minute, and 1-hour cache writes.
Repositories do not compute prices. A separate pricing enrichment layer applies
versioned model rate cards and emits `computedCost`; it leaves that field absent
for unknown models or aggregate-only cache writes that cannot be classified by
TTL. Reported and computed costs remain separate values.

The bundled xAI Grok 4.5 rate card uses $2/M uncached input tokens, $0.50/M
cache-read tokens, and $6/M output or reasoning tokens. OpenCode-reported cost
remains available alongside the computed value for comparison.

Bundled GPT rate cards currently cover the short-context tiers for the GPT 5.6
Sol/Terra/Luna family, GPT 5.5 and 5.5 Pro, and GPT 5.4, Mini, Nano, and Pro.
Calls with 272k or more input-side tokens remain unpriced until long-context
pricing is implemented. A model without a published cache-write rate also
remains unpriced when its source reports cache-write tokens.

Pricing thresholds and model rates apply per model call. Session computed cost
is the sum of its individually priced calls, never a price applied to aggregate
session tokens. If any call cannot be priced, the session computed total remains
absent rather than presenting a partial total.

## Adding A Harness

For each new harness, record only:

1. Storage format, location, and version observed.
2. Native primitives and relationships.
3. Mapping to sessions, turns, model calls, tools, and subagents.
4. Token and cost semantics, including unavailable categories.
5. Privacy-sensitive fields that should remain excluded.
6. Adapter paths and small real or sanitized fixtures.
