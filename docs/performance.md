# Performance Notes

## Resolved Demo Timestamp Bug

The demo database generator previously shifted every timestamp so the earliest
value became a fixed demo date. That was incorrect because
`source_sessions.source_modified_at` can contain a non-epoch value. In one
source archive, its value was `8,174,153`, so the calculated offset moved real
session activity into 2080.

This made the dashboard sluggish and rendered future session dates. The
generator now preserves original timestamps. Do not reintroduce timestamp
shifting without normalizing and validating every timestamp source first.

The regenerated sanitized database was responsive with this representative
data set:

| Measure | Count |
| --- | ---: |
| Root/source sessions | 989 |
| Turns | 6,657 |
| Model calls | 35,608 |
| Tool events | 34,302 |
| Compacted database size | 8.5 MB |

This indicates that the observed demo slowdown was caused by the timestamp
bug, not by SQLite storage size or the current row count.

## Observed All-Range Baseline

A single `range=all&harness=all` dashboard load over 36,480 calls spanning
136 days produced these server-side timings:

| Endpoint | Duration | Detail |
| --- | ---: | --- |
| `/api/ttl-misses` | 442.6 ms | No phase timing yet |
| `/api/usage` | 441.9 ms | 300.5 ms database; about 141 ms pricing and aggregation |
| `/api/overview` | 1,136.4 ms | No phase timing yet |

`/api/ttl-misses` and `/api/usage` both load the all-history call set. Their
filters are semantically equivalent for this request (`started_at >= 0` versus
no lower bound), so they duplicate the expensive read and in-memory work.
`/api/overview` is the largest request because it hydrates qualifying root
trees one at a time.

The server uses synchronous SQLite and JavaScript aggregation. Concurrent
browser requests can therefore delay one another, making the initial dashboard
load feel closer to the sum of these durations than any individual duration.

## Deferred Query Risks

These are known scaling risks from static review. Do not optimize them without
measuring an actual slow endpoint first.

### Usage And TTL Analytics Scan Before Filtering

`SessionRepository.listUsageCalls` builds a recursive tree for all sessions
before applying its optional date and harness predicates. The query shape is in
`src/server/sessionRepository.ts`. It can therefore traverse and hydrate calls
outside the requested range even though `model_calls.started_at` has an index.

Potential direction: apply optional filters through dynamic SQL and constrain
calls before tree expansion. The persisted `source_sessions.tree_root_id` can
avoid rebuilding the hierarchy recursively.

### Full-Tree Hydration For Overview

The sessions endpoint returns summary rows. The overview endpoint loads each
qualifying root session in full, one root at a time. Detail hydration batches a
session's calls, tools, and content, but still issues separate queries for each
node in the session tree.

This is appropriate for `GET /api/sessions/:id`, but it is expensive for the
overview as its root-session count and tree depth increase.

Potential direction: use overview-specific SQL aggregates or persisted summary
fields, and reserve full hydration for the detail endpoint. Batch hydration for
the entire tree when full details are required.

### Session Pagination And Detail Lookup

Session listing sorts by `updated_at`, computed public ID, and harness. The
existing `sessions_updated_idx` cannot satisfy all of those terms, so SQLite may
need to sort a broad result set. Each page also runs `COUNT(*)` and uses an
increasing `OFFSET`.

Session detail lookup filters through `COALESCE(public_id, external_id)`, which
does not have a matching index.

Potential direction: order ties by `source_session_id` to match the timestamp
index, switch to keyset pagination when needed, and index the public-ID lookup
or make `public_id` mandatory.

### Concurrent Initial Analytics Requests

The client initially requests overview, sessions, usage, and TTL metrics. The
server uses synchronous `DatabaseSync`, so expensive SQLite and JavaScript
aggregation work blocks the process and can delay unrelated requests.

Potential direction: defer non-critical analytics panels, combine shared data
retrieval, or cache expensive responses by range and harness.

### Precomputed Rollups

The `sessions` table already persists lifetime totals for tokens, calls, and
reported cost. Those fields can serve session lists and simple inclusive
totals, but cannot replace the call-level data used by the current analytics:
daily distributions, model breakdowns, per-session percentiles, cache chains,
and activity/concurrency intervals all depend on timestamps or call order.

If response caching after a successful sync is insufficient, prefer
date-bucketed, invalidatable rollups over a single session total. A root-session
and day/model rollup could cover usage and much of the overview while retaining
the detailed calls required for TTL-miss analysis. Do not persist computed
pricing without a pricing-version and invalidation strategy because model
prices can change.

## Measurement Before Optimization

Use the existing `Server-Timing` response headers and server logs for
`/api/usage` and `/api/sessions` to identify the slow endpoint. Before changing
SQL, run `EXPLAIN QUERY PLAN` against a representative archive and compare
endpoint latency before and after the smallest proposed change.
