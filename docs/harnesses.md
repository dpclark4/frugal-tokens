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
- Default path on macOS: `~/.local/share/opencode/opencode.db`
- Override in Frugal Tokens: `OPENCODE_DB_PATH`
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
| Session with `parent_id` | Subagent session |
| `task` part metadata `sessionId` | Link from tool event to subagent |

Order messages by `time_created, id`. Each user message starts a turn; following
assistant calls belong to that turn until the next user message. One turn may
contain many calls because each tool-use loop invokes the model again.

Ignore assistant records whose reported token usage is entirely zero.

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

Frugal Tokens currently derives:

```text
fresh prompt = input + reported cache write
processed = input + cache read + cache write + output + reasoning
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
worktree, VCS, harness version, agent, compaction events, retries, errors, and
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

## Adding A Harness

For each new harness, record only:

1. Storage format, location, and version observed.
2. Native primitives and relationships.
3. Mapping to sessions, turns, model calls, tools, and subagents.
4. Token and cost semantics, including unavailable categories.
5. Privacy-sensitive fields that should remain excluded.
6. Adapter paths and small real or sanitized fixtures.
