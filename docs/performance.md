# Performance notes

## Canonical read path

All session and analytics reads use `ConversationRepository`. Global
`harness=all` requests run the same set-based conversation queries as scoped
requests, with an optional harness predicate; there is no per-harness provider
fan-out or mixed-provider pagination.

Session listing is database-paginated over root conversations. Conversation
rollups and cache-miss materializations serve list enrichment, overview, usage,
cost, shape, and cache analytics without reading the removed session schema.

## Measured checkpoint

The conversation migration recorded representative warm timings of roughly
6–12 ms for overview, 63–123 ms for 30-day usage, 61–118 ms for 30-day cache
misses, and 27–45 ms for the first 25 sessions. A synchronized unchanged pass
completed in about 0.58 seconds on that development corpus. These measurements
are historical reference points, not performance guarantees.

## Query risks

- `ConversationRepository.listUsageCalls` constructs conversation/subagent and
  branch-local predecessor relationships before hydrating usage observations.
  Measure scoped ranges before changing that query shape.
- Session listing uses `COUNT(*)`, ordered pagination, and increasing `OFFSET`.
  Consider keyset pagination only after page-depth measurements justify it.
- SQLite access is synchronous, so several expensive initial dashboard requests
  can delay one another even when each query is set-based.
- Materialized computed costs require an explicit pricing-version invalidation
  strategy before rate-card-only repricing can be separated from parser bumps.

Use `Server-Timing`, synchronization phase logs, and `EXPLAIN QUERY PLAN` against
a representative archive before optimizing. Compare warm pages 1, 2, and 8 for
`harness=all` when changing list SQL.
