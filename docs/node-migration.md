# Node migration checkpoints

## Agreed scope

- Node 26 only for development and production; Node 24 was explicitly dropped
  after its missing native `Temporal` support was confirmed.
- pnpm 12.10.1, pinned in `package.json`, with a tracked lockfile.
- TypeScript 7.0.2 for checking, tsx for execution, Vitest for tests.
- Retain Vite, React, Hono, Oxlint, anti-slop rules, and `node:sqlite`.
- Preserve application behavior, schemas, migration history, environment-variable
  names, ports, CLI arguments, and deployment behavior.
- Preserve existing task names as pnpm scripts, including maintenance and deployment.
- Preserve `node:assert` assertions, fixtures, and snapshot expectations.
- Deno remains for formatting; no bulk formatting or unrelated dependency upgrades.
- No browser testing, Vite+, general Deno shim, or unrelated refactoring.

## Checkpoints

Each implementation checkpoint gets a concise progress summary and a separate
commit after relevant verification. Do not bypass hooks. Ask before widening
scope or dropping compatibility.

### 1. Inventory and proposal — complete

- Runtime changes cover server/importers, database utilities, scripts, and the
  responses-cache-lab tool.
- Tests include 46 unit-test files and 7 HTTP integration-test files.
- Existing constructor parameter properties motivate tsx rather than syntax rewrites.
- All 15 SQL migrations applied successfully in memory on Node 24.17.0;
  `node:sqlite` exposes the required backup API. Full compatibility remains to test.
- Sourcing the contributor shell exposes Node 26.11.1 and pnpm 12.10.1.

### 2. Runtime and package management — complete

- Added pinned packages, pnpm lockfile, explicit native-build approvals, and
  `tsconfig.node.json`; the non-default filename avoids Deno automatically
  adding application entrypoints to its test graph during the transition.
- Migrated server/importer APIs and essential development, startup, and database
  commands; existing Deno task names forward migrated commands to pnpm.
- Preserved HTTP static fallback, remote-address handling, startup logging, and
  development port mapping.
- Kept the Deno test runner; HTTP tests now launch the Node server.
- Node 26 startup checks passed with an isolated database and the five HTTP
  fixtures: all 15 migrations, repeated migration, status, API/session detail,
  static assets, SPA fallback, development port validation, and the Vite proxy.
- Both `start` and `dev` passed with configuration loaded only from an isolated
  `.env`; `node --env-file` must execute a script directly because combining it
  with `--run` does not load the file for the child script.
- TypeScript 7 checking, Vite build, anti-slop gate, 281 existing unit tests, and
  11 existing HTTP tests with 66 nested steps passed; no expectations changed.
- Dependency declaration checking is skipped for existing Recharts declaration
  errors; application checking remains strict and includes Vite asset types.
- CI/deployment integration remains for checkpoint 4; Node 24 was subsequently
  evaluated and excluded by agreement at checkpoint 3.

### 3. Tests — complete

- Migrated all existing unit and HTTP tests to Vitest 5.0.3, retaining
  `node:assert` assertions and all fixture and snapshot files unchanged.
- Converted 66 nested HTTP steps into collected Vitest cases with suite-level
  server setup and teardown; the original coverage is now 71 HTTP cases.
- Added temporary-directory cleanup and bounded subprocess shutdown; retained
  the fixed clock, UTC timezone, isolated databases, and disabled external actions.
- Added two startup regression tests using only `.env` and three snapshot
  comparison tests; all 284 unit tests and 73 HTTP cases passed on Node 26.
- Preserved `--update-snapshots`; verified explicit updates and subsequent
  comparison in a disposable copy without touching repository snapshots.
- TypeScript checking now includes tests, test support, and Vitest configuration.
- Node 24.17.0 passed 251 unit tests and failed 33 because global `Temporal` is
  absent; its HTTP suite was not run after this failure.
- Decision: require Node 26, as explicitly approved, rather than add a Temporal
  polyfill or rewrite date logic; package engines and Node types reflect Node 26.

### 4. Remaining tooling and integration — pending

- Migrate maintenance/deployment commands, checking, linting, hooks, CI, and docs.
- Account for every existing `deno.json` task; verify safe commands directly and
  deployment command construction without publishing or changing hosted resources.
- Preserve Railway health checks, mounted database paths, migration-before-start,
  Cloudflare Pages deployment, and versioned demo database publishing.
- Verify tests, build, checks, and command behavior on Node 26.
- Leave Deno only in the formatting workflow.

## Risks to track

- The existing final migration has a deliberately empty `down` implementation:
  `db:rollback` removes its history entry without restoring deleted legacy
  tables, so reapplying it fails; restoring the matching database/application
  backup is required, and this migration history is unchanged.
- Node 24 does not enable `Temporal` by default; its V8 flag is experimental,
  and Node 24 is no longer a supported runtime.
- Node lacks Deno's `--allow-*` permission sandbox; isolate test subprocess
  environments and keep external actions disabled in tests.
- Filesystem entry methods, errors, exclusive writes, and timestamps differ.
- HTTP and child-process adapters must preserve environment precedence, signals,
  exit status, and cleanup ordering.
- Deno snapshots need a scoped reader/comparator or another expectation-preserving
  integration, not regenerated expected output.
- Confirm pnpm installation policy and Railway runtime selection; keep existing
  application and script dependency versions rather than upgrading incidentally.

## Separate formatter follow-up — not part of this migration

Choose and configure Oxfmt, review its formatting differences separately, replace
Deno formatting in hooks and CI, and then remove Deno configuration and tooling.
Do not combine the resulting formatting diff with runtime migration work.
