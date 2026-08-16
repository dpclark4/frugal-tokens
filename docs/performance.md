# Performance notes

## Canonical read path

All session and analytics reads use `ConversationRepository`. Global
`harness=all` requests run the same set-based conversation queries as scoped
requests, with an optional harness predicate; there is no per-harness provider
fan-out or mixed-provider pagination.

Session listing is database-paginated over root conversations. Conversation
rollups and cache-miss materializations serve list enrichment, overview, usage,
cost, shape, and cache analytics without reading the removed session schema.

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
