# HTTP tests and fixtures

```sh
deno task test:e2e
deno task test:e2e --update-snapshots  # Review snapshot changes.
```

`tests/` calls the real HTTP server; `snapshots/` holds response snapshots using
Deno 2.9+'s built-in `t.assertSnapshot()` (no snapshot library).
`support/server.ts` reads `fixtures/{pi,codex}/` into fresh, migrated temporary
SQLite storage. It waits for import and cleans up afterward. Personal session
configuration, title generation, and periodic sync are disabled.
`support/main.ts` fixes `Date.now()` and no-argument `new Date()` at February 1,
2026, 12:00 UTC, and the server runs in UTC. Overview and cache-miss overview
tests use `range=all`; other dashboard tests exercise fixed 30/90-day windows.
Real time passing does not expire fixtures. The scrubber shifts sessions to
January 15, 2026: keep new fixtures within the tested windows and before the
fixed clock. For longer fixtures, adjust the fixed clock/windows and
intentionally update snapshots.

## Coverage

- Homepage data: harnesses, usage, activity overview, work rhythm, session
  shape, cache-miss overview, and overview.
- Other analytics: performance and collapsed/expanded tool calls.
- Sessions: imported Pi/Codex list, harness/miss filters, every supported sort
  key in both directions, pagination, empty results, and invalid filters.
- Pi `astra-full1-partial2`: full detail response, full/partial cache miss
  counts, cost scenarios with both cache TTLs, missing sessions, and invalid
  inputs.
- Dashboard validation: invalid harnesses, ranges, timezones, and model/expand
  parameters; activity also covers a Pi-only 90-day non-UTC view and empty data.

These are HTTP integration tests, not browser rendering/navigation tests. GitHub
Actions runs `deno task test:e2e` in CI's separate **Run HTTP e2e tests** step.
Snapshot updates generate expected responses; review them before accepting
behavior changes. Normal test runs compare responses without rewriting
snapshots.

## Adding a session (agents)

1. Given a session file or localhost session URL, locate the original file
   outside the repository. Use the requested fixture name; otherwise derive one
   using the naming convention below.
2. Scrub to a new file outside the repository:

   ```sh
   deno run --allow-read --allow-write scripts/scrubSession.ts \
     --harness pi --input /path/to/original.jsonl \
     --output /tmp/new-scenario.jsonl --name new-scenario
   ```

   Use `--harness codex` for Codex. Existing outputs are never overwritten.
3. Review the output before copying it to `e2e/fixtures/<harness>/`. Text and
   tool payloads and images are synthetic; IDs/paths are remapped and dates
   shifted. Clipboard-image references retain image detection, not original
   paths. Usage, costs, time gaps, tool names, models, and reasoning settings
   remain: check those identifiers for private aliases too. Unknown fields are
   omitted; unsupported events, content blocks, or tool arguments fail. Extend
   the scrubber and its synthetic tests when needed—never fall back to copying
   raw payloads.
4. Compare relevant original/scrubbed import metrics locally. Give the fixture a
   focused test; update snapshots intentionally and run `deno task test:e2e`.
   Adding fixtures changes the shared sessions list and its count assertions.

Sanitization produces a review candidate, not a guarantee of safe publication.
Never commit originals or raw snapshots. Recorded tokens need not match the
replacement text. The initial thinking-change fixtures retain Pi/Codex
analytics, but omit private instructions, signatures, account metadata, and
extension state. `pi/astra-ttl3-full2.jsonl` has 101 calls: three TTL-classified
full misses and two other full misses; these classifications are not proof of
provider-side causes.

## Fixture names

Use `<model>[-<model>...]-<miss-kind><count>[-<miss-kind><count>...]`, e.g.
`astra-full1-partial2` or `sol-terra-thinking1`. Use distinct, concise model
slugs in first-use order. Omit zero counts; use `no-misses` when all are zero.
Codex filenames need the importer's `rollout-` prefix, e.g.
`rollout-sol-terra-thinking1.jsonl`.

Read the session's `models` and `cacheSummary` in `/api/sessions`, or compute
`summarizeSessionCache(analyzeSessionCache(detail))` from the imported session
(`src/server/cacheAnalysis.ts`). Do not infer counts from URL filters or
screenshots. Map fields in this order: `ttlRelatedMisses` → `ttl`,
`thinkingChangeRelatedMisses` → `thinking`, `compactionRelatedMisses` →
`compaction`, `fullMisses` → `full`, `partialHits` → `partial`. These categories
are disjoint; do not add `unexpectedMisses` again. Verify the scrubbed fixture
retains the counts. Add a short scenario suffix if a name already exists; never
overwrite a fixture.

Scrubber tests:
`deno test --allow-read --allow-write scripts/scrubSession.test.ts`.
