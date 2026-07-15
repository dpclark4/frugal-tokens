# SQLite Archive Migration Plan

> **Implementation status:** This broad horizontal plan is retained as
> architectural reference. It is superseded for current implementation by
> [`sqlite-pi-vertical-plan.md`](./sqlite-pi-vertical-plan.md). Do not execute
> the rollout phases below unless the vertical Pi slice demonstrates a concrete
> need for them.

## Context

Frugal Tokens currently reads Claude Code, Pi, Codex, and OpenCode data directly
from their native files or database during API requests. Each source repository
discovers and parses records, normalizes them into the shared session model, and
then the application applies pricing, cache analysis, usage aggregation, and API
validation.

This repeatedly scans and parses mostly unchanged sessions. Session-list
enrichment can also reload sessions that were just parsed for their summaries.
The cost grows with local history and slows both UI feedback and feature
development.

The target is an application-owned SQLite database that serves all normal reads.
Harness storage remains read-only and becomes an ingestion source. SQLite is a
durable normalized archive, not a disposable cache: data remains available if a
harness later prunes its local history.

The migration must be incremental. Existing repositories remain the reference
implementation while SQLite is populated and queried in parallel. During
rollout, ordinary API requests can read both implementations, compare canonical
results, report differences, and return the configured authoritative result.
Legacy reads are authoritative first; SQLite becomes authoritative only after
explicit parity and performance gates are met.

## Agreed Decisions

- Seed one default local dataset owner; support additional users/imported
  datasets in the schema but not the first UI.
- Use a documented local application-data path for the owned database by
  default and allow `FRUGAL_TOKENS_DB_PATH` to override it.
- Initialize and migrate the owned database at startup.
- Sync automatically at startup and manually from the UI.
- Run sync in a background Deno Worker so synchronous parsing and `DatabaseSync`
  writes do not block API reads.
- Parse a changed session before mutation and replace it in one transaction.
- Preserve the last good import when a source is malformed or actively being
  written.
- Reparse a complete changed session in version one; do not add JSONL byte
  checkpoints yet.
- Retain archived sessions when the source disappears, marking them missing
  rather than deleting them.
- Include missing-source archived sessions in ordinary session lists and usage
  analytics; availability is diagnostic metadata, not a default visibility
  filter.
- Store normalized facts, bounded content previews, and image/activity metadata,
  but not complete raw transcripts or source events.
- Do not detect, import, expose, or analyze compaction events in version one.
  Add them later as context-transition records through a forward migration once
  each harness's source semantics are understood.
- Keep pricing, cache assessments, and analytics derived rather than persisting
  unversioned results.
- Clear only the current user's canonical archive/checkpoints; preserve schema,
  user, source configuration, durable source-session identity, and public IDs.
- Use ordinary API requests for shadow comparison rather than separate preview
  endpoints.
- Remove the complete legacy serving path after the confidence period; retain
  source adapters and focused verification.

## Goals And Non-Goals

Goals:

- Eliminate source discovery/parsing from steady-state reads.
- Preserve historical normalized data even when native tools prune it.
- Keep source-specific parsing isolated and testable.
- Support multiple dataset owners without adding authentication yet.
- Make sync incremental, idempotent, observable, and safe for active sessions.
- Detect regressions while normal application development continues.

Non-goals for version one:

- Full raw transcript storage, authentication, or user-management UI.
- Mutating harness-owned files or the OpenCode database.
- An ORM, materialized analytics, filesystem watching, or scheduled sync.
- Incremental replay of appended JSONL records.
- Compaction detection or compaction-aware cache-miss classification.
- Permanent dual reads.

## Existing Boundaries

| Area                    | Location                                                         |
| ----------------------- | ---------------------------------------------------------------- |
| API/startup             | `src/server/main.ts`                                             |
| Shared Zod models       | `src/shared/sessionSchemas.ts`                                   |
| Source adapters         | `src/server/*Repository.ts`                                      |
| Usage projection        | `src/server/usage.ts`                                            |
| Pricing/cache/analytics | `src/server/pricing.ts`, `cacheAnalysis.ts`, `usageAnalytics.ts` |
| Client API/UI           | `src/client/api.ts`, `src/client/SessionsPage.tsx`               |
| Source behavior notes   | `docs/harnesses.md`                                              |

The reusable seam already exists: source repositories produce canonical data,
while pricing, cache analysis, and analytics consume canonical data. The
migration should formalize this seam rather than move source rules into SQL.

## Target Architecture

```text
Read-only native sources
├── Claude Code JSONL and metadata
├── Pi JSONL
├── Codex JSONL
└── OpenCode SQLite
         │
         ▼
Harness scanners/normalizers
  discover candidates
  calculate change hints/fingerprints
  validate external records with Zod
  produce canonical import models
         │
         ▼
Background sync worker
  serialize writes
  parse before mutation
  replace one session transactionally
         │
         ▼
Frugal Tokens SQLite archive
         │
         ▼
SQLite read repository
         │
         ▼
Existing pricing, cache, analytics, API schemas, and UI
```

During rollout:

```text
UI request to existing endpoint
          │
          ├── legacy repository ──► response A ─┐
          │                                     ├── semantic diff
          └── SQLite repository ──► response B ─┘
                                                │
                                                ▼
                                   return authoritative response
```

## Code Boundaries

Introduce explicit contracts. Exact parameters should include
user/source/harness scope where needed.

```ts
interface SessionReadRepository {
  listSessions(page: number, pageSize: number): SessionListResponse;
  getSession(id: string): SessionDetail | undefined;
  listUsageCalls(startedAt?: number): UsageCall[];
}

interface SourceScanner {
  discover(): SourceSessionCandidate[];
  normalize(candidate: SourceSessionCandidate): NormalizedSession;
}
```

Only synchronization consumes `SourceScanner`; API services consume
`SessionReadRepository`. Extract module-level startup toward
`createApp(services)` plus an explicit server/resource lifecycle. Both
repositories must share pricing, cache, pagination, usage aggregation, and
response validation. Do not duplicate business logic for legacy and SQLite
routes.

## Schema Direction

The exact DDL should be reviewed before the first migration, but these entities
and relationships are required.

### Ownership And Checkpoints

| Table             | Key fields                                                                                                                                | Purpose                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `users`           | `id`, `name`, `created_at`                                                                                                                | Dataset owners; seed one local user.                         |
| `sources`         | `id`, `user_id`, `harness`, `kind`, `label`, `location`, `enabled`                                                                        | Configured directory, source DB, or future uploaded archive. |
| `sync_runs`       | `id`, `user_id`, `trigger`, `mode`, `status`, timestamps, counters, error summary                                                         | Startup/manual sync progress and history.                    |
| `source_sessions` | `id`, `public_id`, `source_id`, `external_id`, `parent_id`, availability, change hint/hash, parser version, first/last seen, imported time, last error | Durable native/API identity and sync checkpoint.             |

Require `unique(source_id, external_id)`. A missing source session remains in
`source_sessions` and retains its canonical rows.

### Canonical Data

| Table          | Key fields                                                                                                             | Purpose                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `sessions`     | `id`, `source_session_id`, title, agent, source timestamps                                                             | Replaceable canonical session metadata. |
| `turns`        | `id`, `session_id`, `ordinal`, `started_at`                                                                            | Ordered user turns.         |
| `turn_inputs`  | `id`, `turn_id`, `ordinal`, kind, bounded preview, original length, truncation flag, MIME metadata                     | User text/image metadata.   |
| `models`       | `id`, `provider`, `name`                                                                                               | Provider/model identity.    |
| `model_calls`  | `id`, `turn_id`, source call ID, ordinal, model, timestamps, reported cost, token columns, finish/activity fields      | Usage-producing calls.      |
| `call_content` | `id`, `model_call_id`, `ordinal`, kind, bounded preview, original length, truncation flag, MIME metadata               | Assistant content metadata. |
| `tool_events`  | `id`, `model_call_id`, source tool ID, ordinal, name, status, timestamps, child session, bounded input/output previews | Tool and subagent activity. |

Keep the existing token categories directly on `model_calls`: uncached input,
cache read, aggregate/5-minute/1-hour cache writes, fresh prompt, output,
reasoning, and processed. A mandatory one-to-one token table adds joins without
improving normalization.

Do not initially store computed cost, cache assessments, session totals,
subagent totals, or chart series. Recompute them with existing
source-independent logic.

### Identity

Native IDs are only unique within a source. Durable identity is:

```text
user → source → external session ID
```

Use integer SQLite keys for joins and a stable random
`source_sessions.public_id` for API/UI identity. Preserve native IDs
separately. Keeping the public ID on the durable source identity row allows
clear/reimport and failed replacement to preserve API identity while canonical
session rows are replaced. Update client expansion/detail keys, which currently
use bare session IDs, before exposing multiple sources.

### Previews And Privacy

Store bounded previews so pruned sessions can support future debugging UI
without storing complete transcripts. The current recommendation is 512
characters, with original length, truncation state, kind, and optionally a
content hash.

- Preserve user and assistant text previews.
- Preserve bounded tool input/output previews if approved.
- Preserve image count and MIME type when available; never store image bytes.
- Avoid image paths, absolute paths, and URLs as image identity.
- Preserve `hasReasoning` without reasoning text initially.
- Do not expose previews until an API/UI feature needs them.
- Never dump prompts, commands, paths, or tool output in logs or parity reports.

### Initial Indexes

Start with unique source identity plus indexes for source parent/availability,
session update ordering, turn/call/tool ordering, call start time, and recent
sync runs. Inspect query plans before adding indexes or denormalized summary
tables.

## SQLite Runtime

Use direct `node:sqlite` `DatabaseSync`, matching the existing OpenCode adapter.
Use forward-only transactional migrations with `PRAGMA user_version` and:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

Add `FRUGAL_TOKENS_DB_PATH` or choose a documented default. Update `deno.json`
with narrowly scoped environment/write permissions; current server tasks are
read-only. The owned database and read-only OpenCode source connection must be
distinct, and clear/migration code must never receive the OpenCode connection.

## Synchronization

### Fast Sync Algorithm

1. Discover candidates from every enabled source.
2. Mark discovered source sessions seen for the current run.
3. Compare source-specific cheap change hints.
4. Skip unchanged hints.
5. Hash filesystem candidates whose size or modification time changed.
6. Skip normalization when the resulting fingerprint is unchanged.
7. Read, parse, and Zod-validate a changed session outside a transaction.
8. Produce a complete normalized import model.
9. Begin one session-replacement transaction.
10. Upsert identity and replace turns, calls, content metadata, and tools.
11. Record the successful fingerprint/parser version and commit.
12. On failure, retain the previous canonical data and record the error.
13. After a source completes scanning, mark undiscovered sessions missing
    without deleting them.

Never delete the current session before its replacement parses successfully.

Support `fast` and `verify` modes. Fast sync stats all artifacts and hashes
plausible changes. Verify sync hashes every filesystem artifact. Fast is the
startup/manual default; verify is an advanced action.

### Source Change Hints

| Source      | Candidate identity                | Fast hint                                                 |
| ----------- | --------------------------------- | --------------------------------------------------------- |
| Claude Code | Project-relative session identity | Transcript size/mtime plus relevant index/metadata token  |
| Pi          | Project-relative session identity | JSONL size/mtime                                          |
| Codex       | Relative rollout path             | JSONL size/mtime                                          |
| OpenCode    | Native session row ID             | Session update metadata plus related message/part changes |

Do not hash the complete OpenCode database. Enumerate session-level tokens with
SQL. Claude's `sessions-index.json` needs dependency handling because it can
change a title without changing a transcript.

### Full Session Replacement

Version one intentionally reparses a complete changed session. Claude streaming
fragments and tool results update earlier logical records; Codex depends on
preceding context and pending activity; JSONL can end in a partial record.
Incremental replay requires persistent parser state and broader invalidation.
Add it only if measurements show changed-session reparsing is a bottleneck.

### Worker Model

The API server owns a read connection; one Deno Worker owns the writer and all
scanning/hashing/parsing. A single worker queue serializes startup sync, manual
sync, verify, and clear. Progress is persisted in `sync_runs`. Startup serves
the last committed archive immediately and triggers sync in the background.
Per-session commits allow readers to see successful updates without waiting for
the entire run.

## Shadow Read Verification

### Read Modes

Recommended `FRUGAL_TOKENS_READ_MODE` semantics:

```text
legacy            serve only current repositories
compare-legacy    serve legacy; also read SQLite and compare
compare-database  serve SQLite; also read legacy and compare
database          serve only SQLite
```

Keep existing endpoints unchanged: `/api/sessions`, `/api/sessions/:id`, and
`/api/usage`. Comparison modes invoke both repositories through shared
orchestration, compare results, and return the selected authoritative response.
A shadow failure must not fail a successful authoritative request.

Compare every session-list and session-detail fetch during rollout. Detail
comparison is the strongest signal because it covers hierarchy, turns, calls,
tokens, images, tools, pricing, and cache analysis. Support usage comparison
too, but allow disabling it if legacy usage scans make routine interaction too
slow.

### Semantic Comparison

Do not compare raw serialized JSON. Canonicalization must:

- Compare source identity rather than database public IDs.
- Map parent/child public IDs to source identities.
- Normalize optional-field representation.
- Sort set-like provider/model arrays while preserving turn/call/tool order.
- Exclude ingestion metadata and preview fields not shared by both paths.
- Use a small tolerance for floating-point cost.
- Categorize database-only archived sessions instead of treating them as
  failures.

Use outcomes such as `match`, `mismatch`, `stale`, `archive_only`,
`database_not_ready`, `shadow_error`, and `unstable_source`. Active source data
newer than its imported checkpoint is stale, not automatically a database
regression. Archive retention will eventually change list totals, ordering, and
pagination; compare common live sessions semantically and report missing-source
database rows as archive-only.

Keep response bodies unchanged so current client Zod parsing continues to work.
Report bounded status through headers and structured logs:

```text
X-Frugal-Parity: match|mismatch|stale|skipped
X-Frugal-Parity-Differences: 2

endpoint=session-detail session=claude-code:abc
result=mismatch paths=turns[1].calls[0].tokens.cacheRead,modelCalls
```

Do not log full response objects. The UI may show a small parity indicator, but
no separate verification workflow is needed initially. Disable shadow reads
after the post-cutover confidence period because they preserve legacy latency.

## Management API And UI

Recommended endpoints:

```text
GET  /api/database/status
POST /api/database/sync       { mode: "fast" | "verify" }
GET  /api/database/runs/:id
POST /api/database/clear
```

Status should include schema readiness, active user, current/last run, source
statuses, archive counts, and import/error counters. Define shared Zod schemas
and validate them at the client boundary.

Add a global data toolbar between the page header and analytics with last sync,
progress, counts, Sync now, advanced Verify, Clear confirmation, and optional
parity status. After sync/clear, refetch status, sessions, and usage; clear
detail/expansion caches as needed while preserving ordinary filters.

Clear deletes only the current user's canonical data and resets import
checkpoints while preserving source registrations, source-session identity
rows, and public IDs for a complete reimport. Missing/availability state may be
reset to unknown until the next successful scan. No endpoint may clear or
mutate native source storage.

## Implementation And Rollout

### 1. Extract Stable Seams

- Define read repository/application service interfaces.
- Extract `createApp(services)` and explicit resource lifecycle.
- Share all business orchestration between repositories.
- Keep current endpoints and behavior unchanged.

Exit gate: startup configuration is isolated from an injectable application,
existing source repositories satisfy one read contract, and route-level behavior
remains unchanged.

### 2. Settle Durable Contracts

- Define and version the normalized import Zod schema before writing migrations.
- Settle root/child external identity per harness, public-ID lifecycle, source
  bootstrap, archive visibility, and clear behavior.
- Specify timestamp units, ordinal rules, token null-versus-zero semantics,
  preview truncation, foreign keys, uniqueness, and check constraints.
- Review the complete initial DDL as a durable contract.

Exit gate: all four harness fixtures can be represented by the import model
without relying on API response IDs or derived pricing/cache fields.

### 3. Build Database Foundation

- Settle path/permissions and add connection management/migrations.
- Create schema, indexes, and default user.
- Add canonical database read/write repositories, transactional replacement, and
  shutdown handling.
- Prove import-model to SQLite to canonical-read round trips without a worker.

Exit gate: migrations work from an empty database, replacement is atomic, and
round trips preserve identity, hierarchy, ordering, and absent token fields.

### 4. Separate Source Ingestion

- Define normalized import Zod schemas.
- Adapt current repositories into scanners/normalizers without changing
  semantics.
- Prove the path with Pi, then add Codex, Claude Code, and OpenCode.
- Retain focused native-source fixture tests.
- Treat invalid complete records as import failures and verify filesystem
  stability before accepting an active JSONL read.

Exit gate: deterministic fixtures cover every harness, malformed or changing
sources cannot replace the last good import, and normalization performs no
database mutation.

### 5. Implement Foreground Sync

- Add checkpoints, hints, hashes, parser-version invalidation, transactional
  replacement, last-good retention, and missing-source archival.
- Mark sessions missing only after a successful exhaustive source scan.
- Implement and test startup/manual sync, verify, and clear as a callable
  foreground service first.

Exit gate: new, unchanged, changed, malformed, active, missing, reappeared,
parser-version, failed-scan, clear, and idempotent cases are deterministic.

### 6. Add Worker And Management API

- Put the tested sync service behind one worker queue and persist run progress.
- Add startup sync plus status, manual sync, verify, and user-scoped clear
  endpoints.
- Define worker crash, shutdown, and concurrent mutation behavior.

Exit gate: committed archive reads remain responsive during sync, failed work
retains prior data, and no management operation can mutate source storage.

### 7. Implement SQLite Reads

- Implement list, detail/hierarchy, and usage-call queries.
- Preserve current response schemas where practical.
- Introduce public session IDs and fix client keys.
- Measure queries before denormalizing.

Exit gate: list, detail, hierarchy, and usage queries cover duplicate native IDs
across sources and users, and API/client identity changes are atomic.

### 8. Enable Shadow Comparison

- Add read-mode configuration and semantic comparators.
- Run normal UI reads through both repositories in `compare-legacy`.
- Add privacy-safe parity headers/logs and resolve unexplained differences.

Exit gate: canonicalization and comparison have explicit fixtures for stale,
archive-only, absent-versus-zero, hierarchy, ordering, and floating-point cases.

### 9. Add Management UI

- Add status/sync/verify/clear APIs and controls.
- Show job/parity state and invalidate all relevant client data after mutations.

### 10. Cut Over

- Develop normally in `compare-legacy` until parity gates pass.
- Switch to `compare-database` for a confidence period.
- Switch to `database` and remove the complete legacy serving path.
- Retain source adapters, fixtures, and import-to-database round-trip checks.

Each numbered section is a handoff-safe unit of work. Do not begin a unit whose
durable inputs are still unresolved, and do not combine public-ID migration,
worker concurrency, or cutover with an earlier unit merely to complete the plan
in one pass.

## Deferred Compaction Work

Compaction is a separate feature after the archive cutover. Version one does not
add placeholder event columns or infer compactions from cache-token changes. The
initial schema must retain stable session, turn, and model-call identities and
ordering so a later forward migration can add a `context_events` table
referencing the first model call affected by a compaction without rewriting
canonical call data.

Implement compaction support as these independent steps:

1. Investigate and fixture the durable compaction signal and ordering semantics
   for each harness.
2. Define a normalized context-transition event with session identity, source
   order, optional timestamp, and optional affected model-call identity; do not
   retain compacted summary text.
3. Add the event table through a forward migration and update transactional
   session replacement.
4. Hydrate events as context before the affected model call while retaining
   session-level events whose exact boundary is unknown.
5. Keep the token-derived cache outcome unchanged, but classify a partial or
   full miss immediately following a known compaction as compaction-related.
6. Report raw misses, compaction-related misses, and unexpected misses
   separately.

An event with no reliable affected-call boundary must not excuse a specific
cache miss. Compaction support should not require changing existing session,
turn, or model-call primary keys.

## Verification Strategy

Keep tests separated by layer:

| Layer               | Coverage                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| Source adapters     | Native fixture to normalized import model per harness                           |
| Sync                | New, unchanged, changed, malformed, missing, parser-version change, idempotency |
| Database repository | Pagination, hierarchy, detail, usage, identity, user isolation                  |
| Comparator          | Canonicalization, diff paths, stale/archive classifications                     |
| Business logic      | Pricing, cache, and analytics on canonical fixtures                             |
| API/UI              | Read modes, shadow failure, management safety, refresh/invalidation             |

Critical scenarios include duplicate native IDs across users/sources, partial
JSONL tails, failed replacement retaining good data, missing-source retention,
user-scoped clear, concurrent mutation requests, startup sync with readable
stale data, Claude metadata-only changes, OpenCode child updates, preview/image
preservation, detail parity, and expected archive-only list differences.

SQLite can become authoritative when:

- Empty-database migration and complete reimport succeed for all harnesses.
- No unexplained session-detail or usage mismatches remain in routine use.
- Stale active sessions and archived-only sessions are classified correctly.
- Multiple startup/manual sync cycles complete reliably.
- SQLite reads are materially faster and sync does not block API reads.
- Clear is user-scoped and cannot affect source storage.
- `compare-database` has run for an agreed confidence period without fallback.

Never silently fall back to legacy after SQLite becomes authoritative; fallback
would hide defects and make behavior depend on failure mode.

## Open Decisions

- Exact platform-specific default SQLite location and directory-creation
  behavior; `FRUGAL_TOKENS_DB_PATH` remains an override.
- Final preview limit; 512 characters is recommended.
- Whether version one stores both tool input and output previews.
- Whether parity appears only in diagnostics or always in the toolbar.
- Exact read-mode names and length of the post-cutover confidence period.

These choices do not change the core architecture or rollout.
