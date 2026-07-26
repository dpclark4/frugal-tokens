# SQLite Concurrency Experiment

## Goal

The dashboard starts four independent requests for sessions, usage, TTL misses,
and overview. The server previously executed archive reads through one
synchronous `node:sqlite` connection on Deno's main JavaScript thread. Although
the browser initiated the requests concurrently, synchronous repository work
blocked the event loop and made their database work effectively serial.

The experiment tested whether a bounded pool of read-only SQLite connections in
Deno workers would make the initial dashboard complete closer to the duration
of its slowest endpoint rather than the sum of all endpoint durations.

## Implementation Tried

The experimental implementation:

- Retained the existing writable `SessionRepository` on the main thread for
  imports and synchronization.
- Added a generic five-worker reader pool.
- Opened one read-only `node:sqlite` connection per worker.
- Reused the existing synchronous `SessionRepository` inside each worker.
- Added an asynchronous `SessionReadPool` facade for `listSessions`,
  `getSession`, and `listUsageCalls`.
- Converted archive-backed API handlers to await pooled reads.
- Kept existing SQL, response schemas, and repository read behavior.

Relevant experimental files:

- `src/server/readerPool.ts`
- `src/server/sessionReadPool.ts`
- `src/server/sessionReadWorker.ts`
- `src/server/sessionReadPool.test.ts`
- `src/server/database.ts`
- `src/server/main.ts`

## Result: Requests Overlapped

The browser network waterfall confirmed that Sessions, Usage, TTL, and
Overview began at approximately the same time. The responses completed
progressively, with Sessions first and Overview last. This proved that moving
synchronous SQLite work into workers allowed the HTTP handlers to overlap.

The frontend was already initiating these requests independently through React
`useEffect` hooks. It was not explicitly sequencing them.

## Result: Overall Performance Regressed

Representative timings before the pool:

| Endpoint | Duration |
| --- | ---: |
| Sessions | 31 ms |
| TTL misses | 125 ms |
| Usage | 87 ms |
| Overview | 451 ms |

Representative timings with the five-reader pool:

| Endpoint | Duration | Change |
| --- | ---: | ---: |
| Sessions | 98 ms | 3.2x slower |
| TTL misses | 225 ms | 1.8x slower |
| Usage | 292 ms | 3.4x slower |
| Overview | 825 ms | 1.8x slower |

The approximate pre-experiment serialized total was 694 ms. The experimental
parallel completion time was governed by the 825 ms Overview request, so the
page completed more slowly despite successful overlap.

The compared data sets differed slightly (8,073 versus 8,148 usage calls and
240 versus 242 overview roots), but not enough to explain the regression.

## Likely Causes

### Repository calls were too fine-grained

The pool operated at the repository-method boundary rather than the complete
API-job boundary. Overview continued to list pages and hydrate each qualifying
root individually. Its 242 `getSession` operations each crossed the worker
message boundary.

Sessions similarly listed one page and then performed individual detail reads
for enrichment.

### Large intermediate values were cloned

Usage and TTL each loaded more than 8,000 `UsageCall` objects in a worker and
returned that unaggregated object graph to the main thread. Deno had to
structured-clone and deserialize those values before pricing and aggregation.
The final HTTP responses were much smaller than these internal intermediate
values.

### Concurrent readers contended for shared resources

The five workers concurrently traversed the same SQLite tables and consumed CPU,
memory bandwidth, page cache, and garbage-collection capacity. WAL permits
concurrent readers, but does not guarantee that each reader retains its isolated
latency under load.

Main-thread aggregation also became slower while workers continued consuming
resources. TTL aggregation increased from about 15 ms to 27 ms, and Usage
aggregation increased from about 24 ms to 43 ms.

## Frontend Startup Observation

A development-mode browser waterfall showed that the four API calls did not
start until approximately 500 ms after navigation. The trace showed Vite
serving TypeScript modules and loading the lazily imported `SessionsPage` before
React effects initiated the requests.

The same trace showed these browser request durations:

| Endpoint | Browser duration |
| --- | ---: |
| Sessions | 113 ms |
| TTL misses | 265 ms |
| Usage | 330 ms |
| Overview | 866 ms |

This produced approximately 1.4 seconds from navigation to the final Overview
response. Production should be measured separately because Vite's development
ES-module graph can add startup latency. If production retains a meaningful
delay, the default Sessions page could be eagerly loaded or its data fetching
could move to a router loader.

## Repository Structure Observation

When `FRUGAL_TOKENS_DATABASE_URL` is configured, all UI reads come from the
canonical archive. The harness-specific `repository`, `claudeRepository`,
`piRepository`, and `codexRepository` variables in `main.ts` are wrappers around
the same archive reader. Their direct-source alternatives are fallback behavior
for running without the archive.

If `FRUGAL_TOKENS_DATABASE_URL` is required in practice, a later cleanup can
remove direct-source API reads and expose one application-facing reader:

```ts
sessionReader.listSessions(page, pageSize, harness);
sessionReader.getSession(harness, id);
sessionReader.listUsageCalls(start, harness);
```

Source-specific code would remain in the import path, while API reads would use
only the archive. This cleanup would reduce complexity but would not by itself
solve the measured performance regression. The dominant problems are
fine-grained hydration, large worker transfers, and duplicated analytics reads.

## Better Direction for a Future Experiment

If worker-based concurrency is revisited, use coarse API or analytics jobs:

```ts
analyticsPool.sessions({ page, pageSize, harness });
analyticsPool.usage({ range, harness });
analyticsPool.ttlMisses({ range, harness });
analyticsPool.overview({ range, harness });
```

Each worker should perform the complete operation:

1. Read SQLite.
2. Hydrate required data.
3. Apply pricing.
4. Aggregate analytics.
5. Return only the compact API response.

This would avoid transferring large intermediate call arrays, remove hundreds
of Overview worker messages, and move synchronous aggregation off the main
event loop. It would still require measurement because concurrent scans can
contend.

Additional follow-up opportunities:

- Batch Overview hydration rather than issuing one detail query per root.
- Avoid independently loading equivalent call sets for Usage and TTL.
- Measure isolated pooled endpoint latency versus concurrent latency to separate
  worker-transfer overhead from reader contention.
- Record worker queue wait, worker execution, transfer, and aggregation as
  distinct timing phases.
- Compare development and production frontend startup waterfalls.

## Recommendation

Shelf or revert the current fine-grained repository pool rather than shipping it
as a performance improvement. It successfully demonstrated concurrent request
execution, but representative total page completion regressed. Preserve this
experiment and its measurements as input to a future coarse-job worker design.

## Verification Performed

During the experiment, the following checks passed:

- `deno task check`
- Reader-pool integration test
- Database tests
- Session repository tests

The full test suite was not run.
