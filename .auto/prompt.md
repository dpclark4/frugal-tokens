# Autoresearch: main-page responsiveness

## Objective
Reduce the time before the main dashboard has all of its current data for the representative local page `/?harness=all&range=30&date=2026-09-02`, while preserving response data for every endpoint except work-rhythm payloads when their calendar/detail data is deliberately split out. Prefer the smallest simple implementation. Investigate query shape/indexes, the work-rhythm calendar split, and whether moving synchronous SQLite work off the request event loop is actually worthwhile.

The benchmark uses the running local dev app and issues the same five dashboard data requests plus harness discovery concurrently, as the browser does on an initial load. Requests contain a cache-busting query parameter so the server response cache does not hide database/aggregation work. The current implementation's critical and complete paths are the same; after a deliberate work-rhythm split, `critical_ms` should represent the lightweight initial dashboard response set and detail/calendar latency should remain a secondary observation.

## Metrics
- **Primary**: `critical_ms` (ms, lower is better) — median wall time for the concurrent initial dashboard request set.
- **Secondary**: `complete_ms`, per-endpoint medians (`activity_ms`, `work_rhythm_ms`, `session_shape_ms`, `usage_ms`, `cache_misses_ms`, `harnesses_ms`), `critical_bytes`, `work_rhythm_bytes`, and `data_regressions`.
- Response JSON for harnesses, activity overview, session shape, usage, and cache-miss overview is compared with `.auto/reference/*.json`; a mismatch fails the measurement. Work-rhythm JSON is parsed and measured but intentionally not compared byte-for-byte because its calendar/detail contract may be split.

## How to Run
`./.auto/measure.sh` — outputs structured `METRIC name=value` lines. It assumes the dev app is running at `http://localhost:5273`; override with `FRUGAL_TOKENS_BENCHMARK_URL`.

## Files in Scope
- `src/server/main.ts` — dashboard API routes, request orchestration, and response timing.
- `src/server/conversationRepository.ts` — SQLite read queries and rollup hydration used by dashboard routes.
- `src/server/activityOverview.ts` — activity/spend response aggregation and work-rhythm diagnostics orchestration.
- `src/server/workRhythm.ts` — work-time and calendar/detail aggregation.
- `src/server/database.ts` — SQLite connection setup; only change if an experiment demonstrates a simple safe benefit.
- `src/shared/sessionSchemas.ts` — API contracts when a split endpoint requires them.
- `src/client/api.ts`, `src/client/NewPage.tsx`, and `src/client/new/WorkRhythm.tsx` — request scheduling and rendering for any endpoint split.
- Related focused tests may be added or updated when behavior changes.
- `.auto/prompt.md`, `.auto/measure.sh`, `.auto/measure.py`, `.auto/reference/`, and `.auto/ideas.md` — benchmark and durable experiment notes.

## Off Limits
- Do not modify imported source data, the SQLite archive, pricing data, or benchmark behavior to improve results.
- Do not remove dashboard features or weaken response-data checks to claim a win.
- Do not add dependencies or replace SQLite with a different datastore.
- Do not change unrelated routes or UI styling.
- Do not treat the work-rhythm calendar split itself as a response-data regression, but preserve the semantics of all other dashboard responses.

## Constraints
- Prefer less code and straightforward ownership over speculative architecture.
- Keep the initial page behavior correct and preserve the existing API contracts unless a split requires a narrowly scoped new contract.
- Use Server-Timing and query plans to identify the bottleneck before changing query shape.
- A primary improvement is only a keep when response-data checks pass and the change is not disproportionate to its gain.
- Do not overfit to one timing sample; `.auto/measure.sh` reports medians from repeated concurrent samples.
- Do not run routine full validation during iterations. Run the smallest relevant verification once a candidate is complete or when diagnosing a failure.

## What's Been Tried
- Baseline pending. Initial source inspection shows `/api/work-rhythm` is the dominant request on the representative archive: its root execution interval query is roughly 108 ms of a roughly 114 ms request, while work-rhythm aggregation is roughly 4 ms. `/api/activity-overview` is roughly 20 ms and includes a second rollup query plus cache-miss query.
- `DatabaseSync` is a single synchronous SQLite connection. Concurrent dashboard requests therefore serialize on the event loop; measure concurrent wall time before considering a pool.
- `listOverviewRollups` already supports omitting descendant spend and root execution intervals, so experiments should use those switches rather than duplicate data paths.
