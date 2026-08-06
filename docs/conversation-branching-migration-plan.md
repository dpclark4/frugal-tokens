# Conversation Branching Migration Plan

## Status

Design and implementation handoff. No milestone in this document is implemented
unless its status is updated explicitly.

## Executive summary

Frugal Tokens currently treats each imported harness artifact as one logical
session with one linear list of turns. Codex forks violate that assumption. A
fork creates another rollout artifact, records `forked_from_id`, and copies the
selected history into the new artifact. The copied records describe executions
that already happened; they are not new model calls.

Importing every rollout independently therefore inflates session, turn, token,
and spend metrics. The target model separates:

- the source artifact that was observed;
- the logical conversation counted as a session;
- branches through that conversation;
- canonical transcript entries and model executions;
- occurrences showing where canonical facts appeared in source artifacts;
- normalized turns and disposable analytics rollups.

The migration must be additive. The current importer and repository remain
user-facing while a new projection is populated and compared in shadow mode.
Reads then move to the new repository one harness at a time. Existing tests
remain active throughout the transition and are ported, not discarded, as each
legacy path is retired.

## Terminology

Use these terms consistently in schema, code, tests, and UI:

| Term            | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Source          | A configured harness location, such as a directory or database.                                                                         |
| Source artifact | The currently observed state of one importable source object, such as a Codex rollout JSONL file. It is not immutable revision history. |
| Conversation    | The logical session and analytics counting unit.                                                                                        |
| Branch          | A resumable path/head in a conversation.                                                                                                |
| Entry           | A canonical transcript event such as a message, tool result, or compaction event.                                                       |
| Occurrence      | Evidence that a canonical entry or call appeared in a source artifact.                                                                  |
| Model call      | One actual model execution and its usage/cost facts.                                                                                    |
| Turn            | A normalized user-work grouping over entries and model calls.                                                                           |
| Subagent launch | A relationship in which one conversation launches another. It is separate from branching.                                               |
| Projection      | A parsed representation built from source artifacts, such as the legacy archive or the new conversation model.                          |

In this document, `1 --- 1` means one-to-one, `1 ---< *` means one-to-many, and
`* >---< *` means many-to-many.

## Observed Codex behavior

The issue was reproduced with three Codex 0.146.0 rollout artifacts. Identifiers
are retained here because they are useful for local investigation; committed
automated fixtures must be sanitized.

```text
Original
  019fd485-8690-7e90-b4fc-30aa8ef31fa9

Fork A
  019fd485-c55a-74d0-ab24-83c4bab7ad4c
  forked_from_id -> Original

Fork B
  019fd48e-accd-78c2-94d3-8715a08d56f7
  forked_from_id -> Original
```

The logical turn topology is:

```text
shared turn 1
  -> shared turn 2
       |-> Fork A turn 3 -> Fork A turn 4
       `-> Original turn 3 -> Original turn 4 -> Fork B turn 5
```

The source artifacts contain these paths:

```text
Original: shared 1, shared 2, original 3, original 4
Fork A:   shared 1, shared 2, fork A 3, fork A 4
Fork B:   shared 1, shared 2, original 3, original 4, fork B 5
```

Expected interpretation:

```text
logical conversations = 1
branches              = 3
unique executed turns = 7
turn occurrences      = 13
```

In the copied prefix, Codex preserves strong identity evidence including
`task_started.payload.turn_id`, assistant response IDs, original task timing,
and token usage. Outer JSONL record timestamps may be rewritten to the fork
creation time, so outer timestamp equality is not an identity requirement.
Content equality alone must never establish identity.

## Current model

The initial archive schema is centered on `source_sessions` and `sessions`:

```text
Source
  1 ---< * SourceSession / imported artifact
              |
              |-- 1 --- 1 Session
              |             |
              |             |-- 1 ---< * Turn
              |             |             |
              |             |             |-- 1 ---< * TurnInput
              |             |             `-- 1 ---< * ModelCall
              |             |                            |
              |             |                            |-- 1 ---< * CallContent
              |             |                            `-- 1 ---< * ToolEvent
              |             |
              |             |-- 1 ---< * ContextEvent
              |             `-- 1 --- 1 SessionRollup
              |
              `-- parent 1 ---< * child SourceSession
                  currently used for subagents
```

Relevant implementation:

- `db/migrations/20260714120000_create_initial_archive.sql`
- `src/server/fileSessionImporter.ts`
- `src/server/sessionRepository.ts`
- `src/server/sessionRollups.ts`
- `src/server/codexImporter.ts`
- `src/server/codexRepository.ts`

### What is lacking

1. A source artifact and a logical session are effectively one-to-one.
2. Turns are owned by one artifact/session and only have a session-local
   ordinal; stable Codex turn IDs are not retained.
3. Codex calls receive synthetic IDs such as `1-1` rather than durable source
   execution identity.
4. There is no representation of copied versus executed occurrences.
5. `source_sessions.parent_id` means a subagent/child session. Reusing it for
   forks would misclassify branches and still sum copied usage into descendant
   rollups.
6. Session list, rollup, cost, cache, and activity queries generally treat root
   source sessions as the counting unit.
7. The current one-file-at-a-time sync cannot atomically rebuild a conversation
   whose projection depends on several artifacts.
8. One parser/checkpoint state per source session is insufficient while legacy
   and new projections coexist.

The current model remains valid for linear artifacts, and its behavior must be
preserved during migration.

## Target model

The target separates provenance, topology, canonical facts, and projections:

```text
Source
  1 ---< * SourceArtifact

Conversation
  |-- 1 ---< * Branch
  |             |-- forked-from ---> Branch
  |             |-- fork-point ----> Entry
  |             `-- current-head --> Entry
  |
  |-- 1 ---< * Entry
  |             `-- parent 1 ---< * child Entry
  |
  |-- 1 ---< * Turn
  |             `-- parent 1 ---< * child Turn
  |
  |-- 1 ---< * ModelCall
  |             |-- * --- 0..1 Turn
  |             |-- 1 ---< * output Entry
  |             `-- 1 ---< * ToolEvent
  |
  `-- 1 --- 1 ConversationRollup

SourceArtifact
  * >---< * Entry
  via ArtifactEntryOccurrence

SourceArtifact
  * >---< * ModelCall
  via ArtifactModelCallOccurrence

Conversation
  1 ---< * SubagentLaunch
                  `-- * --- 1 ChildConversation
```

### Source artifacts

A source artifact stores current import-source state:

```text
source identity and external ID
artifact path
availability
size / modification hint / harness change hint
current checksum when available
first and last observed times
```

It is not immutable audit history. If reproducible historical imports become a
requirement, add `ImportRevision` later and attach occurrences to revisions. Do
not imply revision history by storing observations against an otherwise mutable
artifact.

During the additive migration, the existing `source_sessions` table may continue
serving this role to minimize disruption. A final cleanup may rename it after
all legacy session semantics have been removed.

### Conversations

A conversation is the unit presented and counted as a session. A Codex fork
family is one conversation. A linear source artifact initially maps to one
conversation with one branch.

Conversation metadata and rollups must be derived from canonical calls rather
than sums of branch paths.

### Branches

A branch identifies a resumable path and records harness fork provenance:

```text
source artifact
parent/forked-from branch, when known
exact fork-point entry, when known
current head entry
fork-point provenance: explicit | inferred-confirmed | unresolved
```

The entry parent graph is authoritative transcript topology. The branch parent
and fork point preserve the harness operation and make debugging and UI labels
straightforward when a parent branch later advances.

A source artifact commonly has one branch for Codex and may expose several
branches for an in-file tree harness such as Pi. No one-child constraint may be
placed on branch ancestry.

### Entries

Entries preserve the general transcript graph. Each entry has at most one parent
in the initial tree model. Multiple children represent forks.

Entries produced by a model call or tool event need deterministic order and
role. The schema should support fields equivalent to:

```text
producer_model_call_id nullable
producer_tool_event_id nullable
output_ordinal nullable
kind / role
occurred_at nullable
stable source entry identity when available
bounded content metadata
```

At most one producer may be set. Produced entries require an output ordinal, and
output ordinals must be unique within a producer.

A future harness with true branch merging would require an edge table and a DAG
model. Current observed harness semantics are trees; merge support is not part
of this migration.

### Turns

Turns are normalized user-work groupings used by analytics and the linear table
UI. They belong to conversations and may retain a parent-turn relationship for
efficient branch-aware queries.

A model call is canonically owned by its conversation. Its nullable `turn_id` is
a replaceable classification. Do not introduce a `TurnModelCall` many-to-many
relation: one canonical call belongs to at most one canonical user turn, even
when that turn appears in several artifact paths.

### Model calls and occurrences

A model call is one execution and owns usage/cost facts. It must have direct
conversation ownership independent of turn classification.

Model-call occurrences make execution identity auditable. The shape should
support:

```text
source_artifact_id
branch_id nullable
model_call_id
source turn/call IDs when available
source record order or range
occurrence kind: executed | copied | unknown
identity basis: stable-id | explicit-lineage | unresolved
bounded, non-sensitive evidence metadata
```

For a confirmed shared Codex call:

```text
Original occurrence -> executed on Original branch
Fork A occurrence    -> copied on Fork A
Fork B occurrence    -> copied on Fork B
```

The call is stored and priced once. Branch-local attribution is derived from its
confirmed executed occurrence. An `origin_branch_id` may be materialized later
for performance, but occurrence provenance remains authoritative.

Do not add generic raw-record archival in this migration. Raw JSONL storage
would increase storage and privacy scope. Targeted occurrence rows with source
order/ranges and bounded evidence are sufficient while the source remains
available.

### Identity and deduplication rules

Identity confidence is a correctness boundary:

```text
confirmed identity -> one canonical entity with several occurrences
probable identity  -> separate canonical entities; optional diagnostic link
unknown identity   -> separate canonical entities
```

Prefer evidence in this order:

1. Stable harness/provider entry, turn, tool, or response ID.
2. Explicit source ancestry plus preserved source identity.
3. Other deterministic harness-specific identity evidence.
4. Content fingerprints only as supporting evidence, never as identity alone.

Only confirmed shared calls are deduplicated for spend. Unresolved historical
fork records remain separate and should expose identity/attribution coverage
rather than silently merging.

### Subagent launches

Forks and subagents are separate graphs. A subagent launch is its own domain
fact with fields equivalent to:

```text
parent_conversation_id
child_conversation_id
launch_entry_id nullable
model_call_id nullable
tool_event_id nullable
provenance
```

Link a real tool event when the harness supplies one. Do not create synthetic
tool events solely to satisfy the relationship; that would pollute tool-call
analytics.

### Rollups and metric definitions

Initially materialize only conversation-level rollups. Compute branch values
from canonical topology and occurrences until measurement justifies dedicated
branch rollup tables.

Definitions:

```text
Session count
  = conversations

Conversation usage and cost
  = each unique canonical model call once

Branch-local usage and cost
  = calls with a confirmed executed occurrence on that branch

Branch-path usage and cost
  = unique calls along the selected branch lineage

Turn count per conversation
  = unique executed canonical turns
```

Conversation totals and branch-local totals are additive. Branch-path totals are
not additive because paths share ancestors.

## Import and checkpoint design

### Live data and committed fixtures

The live application must continue reading actual configured harness storage,
including `~/.codex/sessions` when configured. A changed artifact should be read
once, checksummed once, and supplied to active projections.

Automated tests must use sanitized committed fixtures or temporary test files,
not live home-directory data. Live files are machine-specific, mutable,
privacy-sensitive, unavailable in CI, and much larger than necessary. Real files
remain useful for local investigation and optional manual integration checks.

### Physical fingerprint versus projection dependency

Keep two invalidation concepts separate:

```text
Artifact fingerprint/checksum
  Did this physical source object change?

Projection dependency digest
  Must this derived conversation projection be rebuilt?
```

Do not replace artifact checksums with a Codex family checksum.

### Projection-specific checkpoints

Legacy and new projections need independent parser state. Add a checkpoint
concept equivalent to:

```text
artifact_import_projections
  source_artifact_id
  projection_name
  parser_version
  source_checksum / change hint
  dependency_digest nullable
  imported_at
  last_error

  UNIQUE(source_artifact_id, projection_name)
```

The exact representation may vary for database-backed harnesses. OpenCode change
hints must not be forced into file checksum semantics. Claude dependency digests
and existing file stat/checksum optimizations must remain supported.

### Codex family digest

The Codex conversation projection depends on all known members. Compute a
deterministic digest from stable, sorted values including:

```text
conversation importer/parser version
artifact external ID
artifact checksum
forked-from external ID
availability state
```

This ensures:

- an unchanged non-forked Codex artifact remains skipped;
- an unchanged fork family remains skipped;
- a parent append rebuilds the family without changing child checkpoints;
- adding or removing a fork rebuilds the family;
- a child discovered before its parent can import provisionally;
- later parent arrival changes the family and resolves ancestry;
- missing/reappearing artifacts change family dependencies.

### Shadow projection safety

During migration, read changed source bytes once and project independently:

```text
Observed source bytes
  |-> legacy projection transaction
  `-> conversation-v2 projection transaction
```

This is not an atomic dual-write requirement. Until cutover, legacy remains
user-facing. A V2 failure must not damage legacy data, and a failed V2 family
rebuild must retain the previous successful V2 projection.

## Revised delivery sequence after Milestone 2

The implementation will use the existing application contracts as the primary
validation surface for the new model. This adjusts sequencing without weakening
the milestone correctness boundaries:

1. Complete Codex family import and occurrence correctness in Milestone 3.
2. Build a V2 compatibility repository that implements the existing session,
   usage, tool, cache, rollup, and analytics read contracts from conversation
   tables while selecting one linear branch path by default.
3. Port existing behavioral tests to that repository and cut reads over by
   harness as soon as parity and intentional Codex fork semantics pass. Much of
   Milestones 4 and 5 may therefore be delivered together rather than keeping a
   long-lived parallel read implementation.
4. Continue legacy projection writes during this validation period so each
   harness retains a tested rollback path. The accelerated read cutover does not
   accelerate destructive cleanup.
5. Add the branch-aware API and UI only after existing endpoints have validated
   the conversation model in normal application use.

This compatibility-first cutover avoids simultaneously debugging a new storage
model, new endpoint contract, and new UI. Per-harness delegation, unresolved
identity coverage, and all existing Milestone 4 and 5 exit criteria still apply.

## Delivery milestones

Each milestone has an independent stopping point. Do not begin the next
milestone merely because the previous implementation compiles; satisfy its exit
criteria first.

### Milestone 0: Baseline behavior and fixtures

Status: complete.

Implementation record:

- Sanitized sibling and nested Codex fixtures live under
  `src/server/fixtures/codex-branching/` with their expected topology and
  counting contracts documented in the fixture README.
- `src/server/codexBranchingFixtures.test.ts` protects both the future logical
  conversation contract and the current three-independent-linear-sessions Codex
  behavior.
- `src/server/fileSessionImporter.test.ts` protects the file import lifecycle,
  including checksum skips, metadata-only changes, parser bumps, last-good
  projection retention, missing artifacts, and reappearance.
- Existing harness importer tests remain the linear behavior baseline for
  OpenCode, Claude Code, Pi, and Codex. No production semantics changed.

Work:

- Preserve every existing importer, repository, analytics, API, and shared
  schema test.
- Add a sanitized three-artifact Codex fixture matching the observed sibling
  forks.
- Add a small synthetic nested-fork fixture.
- Record current linear behavior for OpenCode, Claude Code, Pi, and Codex.
- Add or retain import lifecycle coverage for first import, unchanged sync,
  content change, metadata-only change with identical checksum, parser bump,
  parse failure, missing source, and reappearance.

Exit criteria:

- Existing tests remain green without changing production semantics.
- Fixtures contain only the identity, ancestry, timing, minimal content, tool,
  compaction, and usage fields needed by their tests.
- The expected `1 conversation / 3 branches / 7 unique turns / 13
  occurrences`
  contract is explicit in tests or fixture documentation.

### Milestone 1: Projection-specific checkpoints

Status: complete.

Implementation record:

- `artifact_import_projections` stores parser, checksum/change-hint,
  dependency-digest, import, and error state independently per source artifact
  and projection; the migration backfills existing state as `legacy`.
- Legacy checkpoint columns remain dual-written during the additive migration,
  while repository checkpoint reads use the projection-specific rows.
- File observation now reads and checksums a changed artifact once, shares one
  observation with active shadow projections, and tracks projection outcomes
  independently.
- Shadow parser bumps and failures do not invalidate or roll back the legacy
  parser checkpoint or visible legacy projection. OpenCode change hints and
  Claude dependency fingerprints retain their existing semantics.

Work:

- Add projection-specific import checkpoint storage.
- Migrate or adapt current checkpoint data without changing visible reads.
- Refactor file import orchestration so changed bytes and checksums can be
  shared by legacy and V2 projections.
- Preserve harness-specific change hints and dependency behavior.

Exit criteria:

- All existing importer behavior remains unchanged.
- An unchanged second sync performs the expected skip.
- A V2 parser bump does not invalidate the legacy parser checkpoint.
- V2 failure leaves legacy data and checkpoint state usable.
- File-backed and database-backed harness tests remain valid.

### Milestone 2: Additive shadow schema and linear adapters

Status: complete.

Implementation record:

- The additive conversation projection stores conversations, branches, entries,
  normalized turns, canonical calls, tools, entry/call occurrences, subagent
  launches, and conversation rollups without changing legacy read tables.
- `ConversationProjectionRepository` transactionally replaces linear sessions
  and trees, preserving the prior V2 projection if a replacement fails.
- Codex, Pi, Claude Code, and OpenCode populate `conversation-v2` in shadow mode
  with independent checkpoints; source observations and dependency snapshots
  remain shared with legacy orchestration.
- Cross-projection tests compare linear metadata, turns, calls, usage, models,
  tools, timestamps, and reported costs. V2 replacement is idempotent and all
  server reads remain on the legacy repository.

Work:

- Add the new conversation, branch, entry, turn, call, occurrence, launch, and
  conversation-rollup tables alongside legacy tables.
- Adapt each existing normalized import to emit one conversation, one branch,
  and one linear path into V2.
- Keep all API and repository reads on legacy storage.

Exit criteria:

- Linear V1 and V2 projections agree on documented session metadata, turns,
  calls, tokens, models, tools, timestamps, and costs.
- V2 import is idempotent.
- No duplicate canonical calls exist in a linear conversation.
- V2 failures do not alter legacy rows or visible behavior.

### Milestone 3: Codex family importer

Status: complete.

Implementation record:

- Generic source-artifact identity and lineage tables retain provider identity,
  unresolved parent identity, resolved parent artifacts, relationship kind, and
  provenance without introducing Codex-specific canonical tables.
- File projection orchestration builds connected artifact families, validates
  ancestry, computes dependency digests from parser version, checksum, lineage,
  and availability, and reads each required artifact through a shared
  observation cache.
- The Codex metadata pass records session and `forked_from_id` identity while
  the normalized import retains stable turn, response, message, tool, and
  source-order evidence.
- `ConversationProjectionRepository` transactionally replaces a generic artifact
  family, constructs canonical turn and entry topology, resolves branch parents,
  fork points, and heads, and writes executed, copied, or unknown entry and call
  occurrences with bounded evidence.
- Confirmed stable or explicit-lineage identity deduplicates canonical calls;
  unresolved copied-looking content remains separate. Conversation rollups sum
  unique canonical calls once.
- Codex uses the family importer under a bumped V2 parser version while legacy
  imports, reads, and checkpoints remain authoritative and unchanged.
- Sanitized and synthetic tests cover sibling and nested forks, different fork
  points, parent continuation and append, new and late members, missing and
  reappearing parents, no-new-turn forks, copied multi-call/tool turns,
  compaction boundaries, missing identity, malformed cycles, idempotent skips,
  and transactional last-good retention.

Work:

- Add a Codex metadata pass for session ID and `forked_from_id`.
- Build connected fork families recursively.
- Preserve stable turn, message, response, and tool identity.
- Construct canonical entry and turn topology.
- Classify call occurrences as executed, copied, or unknown.
- Deduplicate only confirmed identity.
- Resolve fork points and branch heads with provenance.
- Rebuild an affected family transactionally using its dependency digest.
- Bump the V2 Codex parser version without disturbing legacy checkpoints.

Required cases:

- non-forked session;
- several sibling forks;
- nested fork;
- forks at different points;
- parent continuing after a child fork;
- parent advancing after children were imported;
- child discovered before parent;
- missing and reappearing parent;
- fork with no new turns;
- copied multi-call/tool turn;
- compaction near a fork boundary;
- stable and missing source identity;
- malformed ancestry cycle.

Exit criteria:

- The observed fixture yields one conversation, three branches, seven unique
  executed turns/calls where applicable, and thirteen path occurrences.
- Shared calls have one canonical row with executed/copied occurrences and
  bounded identity evidence.
- Reimport is idempotent.
- An unchanged family causes no canonical rewrite.
- Parent append, new child, missing member, and late parent cause the correct
  family rebuild.
- Failed rebuild preserves the prior successful family projection.

### Milestone 4: Parallel conversation repository and parity reporting

Status: complete.

Implementation record:

- `ConversationCompatibilityRepository` reconstructs the existing list, detail,
  usage, tool, cache, cost, overview, session-shape, subagent, and initial-input
  contracts from conversation tables. Existing detail responses continue to
  expose one selected linear path.
- Selected paths come from branch occurrences, while canonical usage and
  analytics traverse unique conversation calls. Cache predecessors follow the
  executed occurrence on its branch, including the shared predecessor at a fork,
  rather than global artifact or timestamp order.
- Linear importer tests now compare legacy and conversation list, detail, usage,
  tool, cache, cost, rollup, subagent, and initial-input reads. JSON response
  parity treats absent properties and properties whose value is `undefined` as
  equivalent because both serialize identically.
- Codex fork tests cover selected sibling paths, canonical unique-call counts,
  branch-local cache ancestry, compaction placement, and separation of branches
  from subagent launches.

Work:

- Introduce a conversation repository alongside the legacy session repository.
- Reconstruct selected branch paths from parent topology.
- Hydrate calls, entries, tools, context events, and subagent launches.
- Build a parity utility for linear V1/V2 results.
- Resolve cache predecessors along the selected branch rather than artifact
  timestamp order.

Exit criteria:

- Linear fixtures have exact or explicitly documented parity.
- Sibling and nested branch traversal returns correct paths.
- Conversation usage counts canonical calls once.
- Branch-local attribution uses confirmed executed occurrences.
- The first call after each fork uses the shared predecessor for cache analysis.
- Fork branches never appear as subagents.

### Milestone 5: Analytics and per-harness read cutover

Status: in progress.

Implementation record:

- `SessionReadRepository` delegates every harness to exactly one provider and
  combines harness-level results for global endpoints. It namespaces internal
  session, turn, and call identifiers when providers are mixed so rollback
  cannot merge unrelated analytics records that happen to share a table-local
  integer ID.
- All existing API reads use the facade. OpenCode, Claude Code, Pi, and Codex
  default to conversation reads; setting
  `FRUGAL_TOKENS_CONVERSATION_READ_HARNESSES` to a comma-separated subset moves
  omitted harnesses back to legacy reads, and an empty value rolls all harnesses
  back.
- The API binds before the startup refresh and keeps each harness on legacy
  reads until that harness completes a successful V2 synchronization. This
  prevents stale V2 reads and preserves the legacy rollback path, but the
  current synchronous import loop can still monopolize the server event loop.
- Conversation overview, activity, usage, session-shape, and initial-input
  analytics read materialized conversation rollups with set-based SQL. Session
  list enrichment and cache misses now have disposable V2 materializations
  instead of reconstructing every session tree or replaying all calls per
  request.
- Global delegation tests verify that mixed providers contribute each harness
  once and that global usage, overview, and cost totals equal the selected
  harness-level inputs.
- The conversation cost shim retains reported per-call costs when a model has no
  rate card. Codex intentionally no longer marks a session unpriced solely
  because the legacy projection stored a synthetic context-operation record;
  those records are compaction metadata, not model executions.
- Unresolved occurrence identity remains explicit in the generic occurrence
  tables. It never deduplicates calls by content, and branch-local predecessor
  attribution uses confirmed executed occurrences; linear projections retain
  ordinal fallback where source occurrence order is unavailable.

Current checkpoint and measured performance:

- On the development archive after materialization, observed API timings were
  approximately 6-12 ms for overview, 63-123 ms for 30-day usage, 61-118 ms
  for 30-day cache misses, and 27-45 ms for the first 25 sessions.
- The all-V2 facade now delegates global reads directly to one set-based
  conversation query instead of issuing one conversation query per harness.
- Missing foreign-key replacement indexes reduced a live changed Codex
  artifact synchronization from approximately 5.4 seconds to 0.6 seconds.
  Prepared-statement reuse in both projection repositories removed repeated SQL
  compilation from clean imports.
- An isolated clean rebuild of both legacy and conversation projections for the
  full development corpus completed in 23.8 seconds: OpenCode 15.6 seconds,
  Claude Code 0.25 seconds, Pi 2.36 seconds, and Codex 5.54 seconds. The earlier
  baseline for the same dual-projection startup path was approximately 72
  seconds.
- The follow-up pass completed in 0.58 seconds while one active Codex artifact
  changed and was reimported in 0.35 seconds; the other 783 artifacts were
  recognized as unchanged in approximately 0.23 seconds combined.
- Batching complete OpenCode source snapshots increased source-read and archive
  time and was rejected. A direct transaction benchmark showed only about 14 ms
  of avoidable commit overhead across 772 writes, so transaction batching does
  not explain the remaining clean-import time.
- File-backed shadow projections now reuse the normalized legacy value instead
  of parsing changed Pi and Codex artifacts twice. Conversation and legacy
  writers cache prepared statements for the repository lifetime.
- A live compatibility audit passes the existing list, detail, usage, tool,
  cache, rollup, subagent, initial-input, and cost contracts for Pi and Claude
  Code after excluding internal row IDs and treating cost differences below
  `1e-12` as floating-point accumulation noise. The audit found and corrected
  working-directory compaction, call-preview formatting, and deterministic
  cost-summary ordering differences.
- The three observed Codex sibling artifacts are three independent legacy
  sessions with 4, 4, and 5 calls, while V2 stores conversation `1151` with
  three branches, seven canonical turns/calls, thirteen call occurrences, and
  109,290 unique processed tokens. Both fork branches resolve to the original
  artifact through generic source-artifact lineage.

Remaining work and foreseen risks:

- Complete the live OpenCode compatibility audit. Its full-corpus comparison is
  substantially larger than Pi and Claude Code and did not finish within the
  initial 30-second diagnostic window; split the audit into named endpoint
  comparisons so failures remain bounded and actionable.
- Materialize effective per-call conversation cost during import and aggregate
  it in SQL. V1 stores per-call cost and uses SQLite `SUM`, while the current V2
  cost shim recomputes calls during reads and reduces them in JavaScript. The
  values agree within floating-point noise, but this adds reader work and is not
  the desired final rollup design. The attempted column migration was removed
  from this stopping point rather than committing an incomplete cutover.
- Reassess clean-import performance only against measured phases. OpenCode is
  now dominated by approximately 8.1 seconds of source extraction and 5.9
  seconds of dual archive writes; transaction batching and bulk snapshot reads
  have been measured and are not current optimization candidates.
- Import remains synchronous on the API event loop. The listener binds before
  refresh and legacy reads remain available until each V2 projection succeeds,
  but cooperative or worker-based execution remains an optional operational
  improvement after import throughput and parity work.
- Run the complete existing test suite, including legacy importer and analytics
  tests. No old test should be removed or weakened to complete the cutover.
- Keep legacy writes and the per-harness rollback facade in place. Stopping
  legacy writes, removing legacy tables, and adding the branch-aware API remain
  later milestones and are not cleanup work within Milestone 5.

Work:

- Update activity, usage, cost, cache, performance, tool, session-shape, and
  related analytics to consume conversation-aware repository interfaces.
- Allow the server repository facade to select legacy or V2 reads by harness.
- Cut Codex over only after parity and fork semantics pass.
- Cut other harnesses over individually after their linear adapters pass.
- Aggregate global analytics from each harness provider without duplicating a
  harness in both projections.

Exit criteria for each harness:

- Existing behavioral tests run against the new repository.
- Linear harness totals remain unchanged except for documented bug fixes.
- Global totals equal the sum of harness-specific totals.
- Codex fork families contribute one session and unique calls once.
- Unresolved identity/attribution coverage is explicit.
- Import checkpoint skips continue to work after read cutover.

### Milestone 6: Additive API contract

Status: not started.

Work:

- Keep the existing linear turn response as the default selected path.
- Add optional branch metadata to shared schemas.
- Support a branch query parameter on session detail.
- Use the root conversation ID as the stable session route ID.

Expected shape:

```text
SessionDetail
  id
  branchCount
  selectedBranchID
  branches[]
    id
    forkedFromID
    forkPointTurnID
    headTurnID
    updatedAt
  turns[]  selected branch path
```

Exit criteria:

- Existing non-branching clients remain compatible.
- Session list returns one row per conversation.
- Default detail selects the most recently active branch.
- Explicit branch selection returns the correct path.
- Unknown or cross-conversation branch IDs are rejected.

### Milestone 7: Branch UI

Status: not started.

Work:

- Show one session-list row per conversation.
- Show a compact branch count only when more than one branch exists.
- Add branch selection near existing turn navigation.
- Preserve branch selection in the URL.
- Mark the fork point compactly.
- Continue rendering one linear selected path rather than all transcripts at
  once.
- Keep subagent navigation visually separate.

Exit criteria:

- The observed three artifacts appear as one session with three selectable
  branches.
- Each branch displays the correct path and shared history.
- Refresh and copied URLs preserve selection.
- Linear sessions remain visually unchanged.
- Keyboard and narrow-screen behavior remain usable.

### Milestone 8: Cleanup and later harness trees

Status: not started.

Work after all harnesses use V2:

- Stop legacy projection writes.
- Remove legacy repository compatibility code.
- Remove old canonical tables in a later migration.
- Rename source-session terminology to source-artifact terminology where useful.
- Update demo database create, merge, deployment, and redaction scripts.
- Update harness and schema documentation.
- Implement Pi and Claude native entry trees in separate follow-up milestones.

Do not remove legacy storage until every harness has passed its new repository
and analytics contract tests.

## Test preservation and verification strategy

Existing tests are requirements, not disposable implementation tests. Throughout
migration:

```text
Existing tests -> protect current behavior
V2 tests       -> verify the new model
Parity tests   -> compare V1 and V2 for linear sessions
Fork tests     -> verify intentionally changed semantics
```

When a harness cuts over:

1. Keep its current behavioral assertions.
2. Run them against the new implementation.
3. Change only assertions whose semantics intentionally changed.
4. Document why each changed assertion is correct.
5. Remove legacy-only tests only when the legacy path is removed.

Minimum import lifecycle matrix for every applicable harness:

```text
first import
unchanged second sync
source content change
size/mtime change
metadata-only change with identical checksum
parser-version change
failed parse preserves last good projection
missing source
reappearing source
projection-specific failure isolation
```

Additional harness cases:

```text
Claude Code: dependent subagent artifact changes
OpenCode: database change hints and read-only access
Pi: linear parity before native tree support
Codex: single artifact and complete fork-family matrix
```

Add migration tests that begin with the current schema and representative data,
apply new migrations, keep legacy reads working, populate V2, and verify that a
V2 failure cannot damage V1.

Per project instructions, implementation agents should run the smallest relevant
verification once after a milestone appears complete and report both checks run
and relevant checks not run.

## Compatibility, cutover, and rollback

The migration is intentionally reversible until cleanup:

```text
Before Codex read cutover
  legacy projection and repository remain authoritative

After Codex read cutover
  switch Codex repository delegation back to legacy if needed

Before each other harness cutover
  its legacy projection remains current and tested

Before legacy cleanup
  all harnesses must pass V2 repository and analytics tests
```

Do not build a long-lived SQL union that attempts to merge legacy and V2 rows
for the same harness. Delegate a harness to exactly one read provider, then
combine harness-level results through repository interfaces.

API additions should be optional until the new UI ships. The existing UI should
continue receiving one linear path throughout backend migration.

## Explicit non-goals

The following are deliberately excluded from the initial migration:

- immutable source/import revision history;
- storage of every raw JSONL or database record;
- content-based or probabilistic automatic deduplication;
- materialized branch-local and branch-path rollup tables;
- a many-to-many Turn/ModelCall relation;
- synthetic tool events for subagent launches;
- simultaneous native branch support for every harness;
- transcript branch merging/DAG semantics;
- rendering all branch transcripts simultaneously;
- deleting legacy storage before per-harness cutover is verified.

## Implementation file map

Likely affected areas include:

```text
db/migrations/
  additive schema and checkpoint migrations

src/server/fileSessionImporter.ts
  shared source observation and projection checkpoints

src/server/codexImporter.ts
src/server/codexRepository.ts
  metadata discovery, family graph, identity, and occurrences

src/server/claudeCodeImporter.ts
src/server/claudeCodeRepository.ts
src/server/piImporter.ts
src/server/piRepository.ts
src/server/openCodeImporter.ts
src/server/opencodeRepository.ts
  initial linear V2 adapters; native trees later

src/server/sessionRepository.ts
src/server/sessionRollups.ts
  legacy repository, new conversation repository boundaries, rollups

src/server/*Analytics.ts
  conversation counting and canonical-call consumption

src/shared/sessionSchemas.ts
  additive branch-aware API contracts

src/server/main.ts
src/client/api.ts
  branch query and response handling

src/client/SessionsPage.tsx
src/client/SessionDetailPage.tsx
src/client/SessionDetailPage.css
  one-row conversation listing and branch selection

scripts/createDemoDatabase.ts
scripts/mergeDemoDatabases.ts
scripts/prepareDatabase.ts
  new schema lifecycle and demo handling

docs/schema-notes.md
docs/harnesses.md
  final model and observed harness behavior
```

Exact files should be confirmed at the start of each milestone rather than
changed speculatively.

## Instructions for implementation agents

A fresh implementation agent should:

1. Read `AGENTS.md` and this document completely.
2. Inspect the current files referenced by the next milestone.
3. Confirm that previous milestone status and exit criteria are satisfied.
4. Implement only the next incomplete milestone.
5. Preserve existing tests and add the milestone-specific tests.
6. Run one targeted verification after the work appears complete.
7. Update this document's milestone status and record any established design
   deviation with its reason.
8. Stop before beginning another milestone unless explicitly requested.

Do not reinterpret a copied Codex occurrence as an execution merely to make
counts align. Do not overload subagent relationships with branch ancestry. Do
not switch user-facing reads before shadow parity is established.
