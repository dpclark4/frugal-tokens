# Archive Schema Notes (Placeholder)

## Purpose and current decision

Frugal Tokens is a local, read-only analytics view of OpenCode, Claude Code,
Pi, and Codex sessions. The current schema is fit for that purpose: it
normalizes known harness data into sessions, user-facing turns, model calls,
tool activity, content previews, context events, and token/cost aggregates.

This document records possible future directions. **It does not propose a
near-term schema overhaul.** The current schema should remain the default
until a concrete product requirement—especially in-session branch display or
analysis—justifies a migration.

## Current conceptual model

```text
Source
  └─ Source session (an imported artifact and its import/checkpoint state)
       └─ Session (analytics metadata and aggregate metrics)
            └─ Turn (a user-initiated unit of work)
                 ├─ Turn input(s)
                 └─ Model call(s)
                      ├─ Assistant content
                      └─ Tool event(s)
                           └─ Tool input/output previews
```

A turn can contain more than one model call. For example, one user prompt may
cause a model call that requests a tool, additional calls after tool results,
and then a final response. Session-level token, cost, and count columns are
materialized aggregates that make the session list and overview fast.

`source_sessions.parent_id` is a separate, session-level relationship. It can
represent related source sessions such as subagents or harness-provided child
sessions; it is not a representation of branches inside one transcript.

## Current schema callouts

### Strengths

- The source artifact/import lifecycle is separated from successfully parsed
  session data. This permits missing, unchanged, and failed imports to be
  tracked without corrupting analytics data.
- Calls, models, tool events, content previews, and context events have clear
  foreign-key ownership.
- Session aggregates avoid expensive scans of every model call for common list
  and overview queries.
- The import boundary already provides shared normalized types, while allowing
  harness-specific decoders.

### Limitations and tradeoffs

These are not current defects; they are costs of the analytics-first model.

- A turn is an opinionated linear, user-driven abstraction. It does not retain
  a general message/event graph.
- Pi record `id` / `parentId` relationships are currently flattened during
  import. The SQLite archive therefore cannot recover Pi `/tree` branches.
- Content is retained as metadata and bounded previews, not full source
  payloads, durable attachment locations, or binary image data. This is good
  for a local analytics archive, but limits later replay and reparsing.
- `context_events` has only type, order, time, and an optional model-call
  target. It has no stable source-event identity or extensible payload.
- `turn_inputs` and `call_content` repeat the same content metadata shape.
  Tool input/output previews repeat part of it again.
- `sessions` duplicates metrics derivable from turns and calls. This is an
  intentional performance tradeoff and requires transactional imports to keep
  aggregate values in sync.
- `providers_json` and `models_json` are convenient session summaries, but are
  less relational than deriving models from calls or storing a
  `session_models` relation.
- The session-level parent/tree-root relationships are maintained by
  application code. SQLite does not enforce that a parent belongs to the same
  source or that the graph is acyclic.

## Small improvements worth considering only when needed

1. Make public session identifiers unambiguous at their API lookup scope.
2. Add optional, privacy-conscious `metadata_json` fields to preserve
   harness-specific data that has no current first-class column.
3. Preserve stable native source-entry IDs where available, even before a full
   graph feature is built.
4. Prefer nullable timestamps for unknown source times over using the Unix
   epoch as a sentinel.
5. If richer content support becomes valuable, consolidate content ownership
   without weakening foreign keys.

None of these is required for the current product.

## Possible future normalized model

The most promising future improvement is not a wholesale replacement of the
analytics tables. It is an optional, general entry graph that preserves native
transcript topology while retaining the current session → turn → call model
for analytics and table rendering.

```text
sources
  └─ source_sessions
       └─ sessions
            ├─ session_entries
            │    └─ parent_entry_id → session_entries.id
            └─ turns
                 └─ model_calls
```

A sketch of the new table:

```text
session_entries
  id PK
  session_id FK → sessions.source_session_id
  source_entry_id                 -- native message/event ID
  parent_entry_id FK → session_entries.id NULL
  ordinal                          -- append/source order
  occurred_at NULL
  kind                             -- message, tool result, compaction, etc.
  role NULL
  turn_id FK → turns.id NULL       -- optional analytics/display association
  metadata_json NULL

  UNIQUE (session_id, source_entry_id)
  UNIQUE (session_id, ordinal)
```

Each importer would preserve its native IDs and parent links where it has
them. A turn remains the user-facing analytics unit; `turn_id` associates an
entry with that unit when meaningful. The UI can derive branches by walking
entries, including branches whose parent chain passes through an assistant,
tool-result, compaction, or other non-turn event.

This is preferable to adding only `turn.parent_turn_id`: native transcript
branches do not necessarily connect directly from one user turn to another.

If a harness provides an explicit active leaf, it should be stored separately
(or represented by a durable active-entry reference). If it does not, the UI
must use a documented harness-specific fallback rather than assume timestamp
order always identifies the active branch.

### Optional content consolidation

If repeated content structures become burdensome, `turn_inputs`,
`call_content`, and tool input/output previews could eventually become one
`content_items` table with direct nullable foreign keys to its possible owners,
a direction (`input`/`output`), and a check that exactly one owner is set. This
would preserve referential integrity. A loose polymorphic
`owner_type`/`owner_id` design would be simpler to write but would lose useful
foreign-key guarantees.

## Future tree support and table UI

Several harnesses can express session relationships or transcript branching in
different ways. Pi `/tree` is the clearest in-session example: a JSONL file
contains entries linked by `id` and `parentId`; selecting an earlier point and
continuing creates another path in the same session file. Other harnesses may
provide child/subagent sessions, forks, or comparable branch-like structures.

A general entry graph would let the archive preserve these differences without
forcing all harnesses into Pi's exact semantics.

The UI should remain table-first because most chats are linear:

- By default, render the selected/active lineage as the existing linear turn
  table.
- At a point with multiple child paths, display a compact branch indicator,
  such as `2 branches` or `1 alternate`.
- Expanding the indicator inserts inactive paths directly below their shared
  ancestor, with a small indentation/connector and a branch summary row (turn
  count, calls, tokens, cost, and perhaps a preview).
- Mark the current lineage clearly; keep inactive branches visually quieter
  and collapsed by default.
- Derive ordering from the entry graph, not merely timestamps, since branches
  are often appended to the source file after the shared ancestor.
- Treat branches as turn/user-message-oriented in the table even though the
  underlying entry graph preserves all event types.

This provides useful branch visibility without making ordinary linear sessions
pay the visual complexity of a full tree navigator.
