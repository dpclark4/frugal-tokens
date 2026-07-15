# SQLite Pi Vertical Migration Plan

## Why This Supersedes The Broad Plan

The original archive plan front-loaded a generic schema, four ingestion
adapters, synchronization infrastructure, shadow reads, management APIs, and a
cutover strategy. Those may eventually be useful, but implementing them before
one harness works end to end creates two risks:

- Source parsing rules can be duplicated between legacy repositories and new
  scanners.
- Infrastructure can be generalized around assumptions that have not been
  exercised by a real import/read path.

Frugal Tokens is still small enough to migrate one feature slice at a time. The
current goal is therefore one complete Pi path. Work on another harness begins
only after Pi is imported, read, compared, and manually exercised.

The earlier `sqlite-db` branch is reference material, not code that must be
reintroduced. Reuse pieces only when they make the Pi slice smaller or safer.

## Starting Point

This branch starts from `3c83445`, which provides:

- An injectable `createApp(services)` boundary.
- Existing legacy repositories and behavior unchanged.
- Route tests for repository injection and combined pagination.

The database is development-only and disposable until a later decision
explicitly declares its data durable. Migration 1 may be revised rather than
carrying compatibility for abandoned local schemas.

## Scope

Build this path:

```text
Pi JSONL
  -> one Pi parser
  -> normalized Pi session facts
  -> foreground SQLite import
  -> SQLite Pi repository
  -> existing pricing/cache/usage orchestration
  -> opt-in Pi API reads
```

Version one of this slice includes:

- Database path resolution and a minimal forward migration.
- Foreground/manual import of Pi sessions.
- Transactional replacement that preserves the last good imported session.
- Pi session list, detail, and usage reads from SQLite.
- Stable API identity for imported sessions.
- Existing token categories, cache-write TTL split, reported cost, activity,
  images, and tools needed for current response parity.
- Focused fixtures plus a real-data smoke-test procedure.

## Non-Goals

Do not implement during the Pi slice:

- Claude Code, Codex, or OpenCode ingestion.
- A generic multi-harness scanner framework.
- Background Workers, filesystem watching, or scheduled sync.
- Sync history/progress tables, management APIs, or management UI.
- General shadow-read infrastructure.
- Authentication, multi-user UI, or imported archives.
- Compaction detection or compaction-aware cache classification.
- Complete transcripts, reasoning text, image bytes, or unlimited tool data.
- Permanent dual reads or removal of legacy repositories.

## Architectural Rules

### One Pi Parser

Do not create a second Pi decoder beside `PiRepository`. Extract one parser that
owns Pi record validation, turn boundaries, call filtering, token mapping, tool
matching, timestamps, titles, and model ordering.

During migration, both paths may project from that parser:

```text
                    -> legacy SessionDetail projection
shared Pi parser --|
                    -> SQLite import projection
```

If a fact is needed only for archival storage, extend the parser's result rather
than reparsing the JSONL elsewhere.

### Keep The Database Minimal

Add only tables and indexes required by Pi list/detail/usage and stable import
identity. Do not add speculative synchronization, user-management, or other
harness structures. Prefer additive migrations after a demonstrated need.

The schema must not prevent later harnesses, hierarchy, previews, or context
events, but it does not need placeholder columns or tables for them.

### Foreground Before Background

Expose import as an ordinary callable service or development command. Measure it
before introducing a Worker. If foreground import is fast enough for local
history, keep it simple.

### Explicit Read Selection

Legacy Pi reads remain the default. Database Pi reads require an explicit
development configuration. Do not silently fall back from database reads to
legacy reads because that hides defects.

## Units Of Work

### 1. Extract The Pi Parser

- Separate JSONL reading/validation and Pi normalization from repository query
  methods.
- Preserve current `PiRepository` responses exactly.
- Reject malformed complete JSONL records.
- Tolerate only an incomplete final line from an actively written file.
- Detect a file changing during read and avoid accepting that parse.

Exit gate: all existing Pi repository tests pass through the extracted parser,
with additional malformed/active-file cases. No database code is involved.

### 2. Add The Minimal Pi Database

- Resolve a configurable owned database path.
- Add migration execution with `PRAGMA user_version`.
- Define only source identity and canonical Pi session/turn/call/tool facts
  needed by current API responses.
- Keep pricing, cache assessment, totals, and analytics derived.

Exit gate: an empty database migrates idempotently and enforces identity,
ordering, token nullability, and foreign-key constraints.

### 3. Import Pi In The Foreground

- Discover Pi JSONL files with source-relative identity.
- Skip unchanged sessions using a simple size/mtime hint; content hashing can be
  added only if needed.
- Parse before mutation.
- Replace one complete session transactionally.
- Preserve the previous imported session when parsing or replacement fails.
- Retain imported sessions when a source file disappears; deletion policy is
  deferred.

Exit gate: new, unchanged, changed, malformed, actively written, and repeated
imports are deterministic and idempotent.

### 4. Read Pi From SQLite

- Implement Pi list pagination, detail, and usage-call reads.
- Reuse existing pricing, cache analysis, usage aggregation, and API validation.
- Keep database-specific IDs out of source parsing and public responses.

Exit gate: fixture imports round-trip through SQLite into current response
schemas without a second business-logic path.

### 5. Add Opt-In Pi API Reads

- Add one explicit Pi read setting with `legacy` and `database` modes.
- Apply it only to Pi; other harnesses remain unchanged.
- Keep endpoint shapes and client behavior unchanged.

Exit gate: route tests cover both modes, database failures are visible, and no
silent fallback occurs.

### 6. Verify With Real Pi History

- Import the configured local Pi directory.
- Compare counts, representative details, tokens, costs, tools, and usage
  aggregates with legacy Pi reads.
- Measure import and read latency.
- Record mismatches as focused parser/repository tests.

Exit gate: no unexplained Pi mismatches remain and database reads are useful in
normal local operation.

## Commit Boundaries

Commit after each numbered unit passes its exit gate. Do not combine parser
extraction, schema design, API mode changes, and another harness in one commit.

After unit 6, choose one of these based on evidence:

1. Port Codex as the next vertical harness slice.
2. Improve Pi import performance or correctness.
3. Add background synchronization because measured foreground behavior requires
   it.

Do not resume the broad horizontal rollout by default.

## Deferred Compaction

Compaction remains a later feature. A future additive migration can introduce
context events associated with the first affected model call. The Pi slice does
not detect, infer, persist, or classify compactions.
