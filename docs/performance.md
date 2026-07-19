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

### Full-Tree Hydration For Summary Views

The sessions endpoint enriches each list row by loading its complete session
tree. The overview endpoint similarly loads qualifying root sessions in full.
Detail hydration issues separate queries for context events, turns, model calls,
tools, content, and child sessions in `SessionRepository.#detail`.

This is appropriate for `GET /api/sessions/:id`, but it is expensive for list
and overview views. It is an N+1-style risk as session count and tree depth
increase.

Potential direction: use summary-specific SQL aggregates or persisted summary
fields for list and overview endpoints, and reserve full hydration for the
detail endpoint. Batch child-row reads when full hydration is required.

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

## Measurement Before Optimization

Use the existing `Server-Timing` response headers and server logs for
`/api/usage` and `/api/sessions` to identify the slow endpoint. Before changing
SQL, run `EXPLAIN QUERY PLAN` against a representative archive and compare
endpoint latency before and after the smallest proposed change.
