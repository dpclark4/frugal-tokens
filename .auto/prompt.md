# Autoresearch: main-page responsiveness

## Objective
Reduce the time before the main dashboard has all of its current data for the representative local page `/?harness=all&range=30&date=2026-09-02`, while preserving response data for every endpoint except work-rhythm payloads when their calendar/detail data is deliberately split out. Prefer the smallest simple implementation. Investigate query shape/indexes, the work-rhythm calendar split, and whether moving synchronous SQLite work off the request event loop is actually worthwhile.

The benchmark uses a dedicated API process on port 19000 backed by the consistent `.auto/archive.sqlite` snapshot copied from the representative local archive. It issues the same five dashboard data requests plus harness discovery concurrently, as the browser does on an initial load. Requests contain a cache-busting query parameter so the server response cache does not hide database/aggregation work. The current implementation's critical and complete paths are the same; after a deliberate work-rhythm split, `critical_ms` should represent the lightweight initial dashboard response set and detail/calendar latency should remain a secondary observation. Override with `FRUGAL_TOKENS_BENCHMARK_URL` when needed; the page itself remains at `http://localhost:5273`. The snapshot avoids live source synchronization changing response data between iterations.

## Metrics
- **Primary**: `critical_ms` (ms, lower is better) — median wall time for the concurrent initial dashboard request set.
- **Secondary**: `complete_ms`, per-endpoint medians (`activity_ms`, `work_rhythm_ms`, `session_shape_ms`, `usage_ms`, `cache_misses_ms`, `harnesses_ms`), `critical_bytes`, `work_rhythm_bytes`, and `data_regressions`.
- Response JSON for harnesses, activity overview, session shape, usage, and cache-miss overview is compared with `.auto/reference/*.json`; a mismatch fails the measurement. Work-rhythm JSON is parsed and measured but intentionally not compared byte-for-byte because its calendar/detail contract may be split.

## How to Run
`./.auto/measure.sh` — outputs structured `METRIC name=value` lines. It assumes the stable benchmark API is running at `http://localhost:19000`; override with `FRUGAL_TOKENS_BENCHMARK_URL`.

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
- Early live-server probes showed `/api/work-rhythm` as the dominant request: its root execution interval query was roughly 108 ms of a roughly 114 ms request in one cold probe, while work-rhythm aggregation was roughly 4 ms. Warm repeated probes were closer to 8–10 ms for that query, so use repeated medians and do not trust the cold outlier. `/api/activity-overview` was roughly 20 ms and includes a second rollup query plus cache-miss query.
- The live archive changed during early setup, so the benchmark now uses `.auto/archive.sqlite` and response references must be recaptured against that fixed snapshot.
- `DatabaseSync` is a single synchronous SQLite connection. Concurrent dashboard requests therefore serialize on the event loop; measure concurrent wall time before considering a pool.
- `listOverviewRollups` already supports omitting descendant spend and root execution intervals, so experiments should use those switches rather than duplicate data paths.
- Kept experiment: `conversation_tool_events(model_call_id, completed_at, started_at)` is a covering index for root execution interval loading; it reduced the isolated query from about 6.2 ms to 3.2 ms and the first stable concurrent median from 41.83 ms to 37.23 ms, with all guarded responses unchanged. A repeat was noisy at 43.88 ms but still reported the query phase near 5 ms.
- Kept experiment: `conversation_model_calls(conversation_id, started_at, source_call_id, uncached_input_tokens, cache_read_tokens, cache_write_tokens, computed_cost, reported_cost)` covers the recursive subagent usage query; the isolated query fell from about 3.4 ms to 2.2 ms and the concurrent median reached 35.39 ms. Guarded responses and byte counts stayed unchanged.
