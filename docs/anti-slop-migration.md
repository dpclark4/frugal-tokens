# Anti-slop migration

## Goal

Adopt the vendored anti-slop rules without weakening their severity or
laundering types merely to satisfy lint. The migration should preserve evidence
from inference, parse external data at I/O boundaries, use named domain
contracts, and document the checked invariant behind every necessary type
assertion.

The strict Oxlint configuration remains the migration report. A rule-level
`prek` gate enforces clean rules while migration work continues in reviewable
units.

## Baseline

Captured with `deno task lint:oxlint` after installing anti-slop 1.79.0.

Initial state:

- 705 findings across 74 files
- 8 rules reported findings
- 7 configured rules passed

Current state:

- 695 findings
- `no-unknown-returns` is clean and enforced by the gate
- Returning parsed session details also removed 4 known-value widening findings

| Rule                                        | Initial findings | Files | Status             |
| ------------------------------------------- | ---------------: | ----: | ------------------ |
| `require-safety-comment-for-type-assertion` |              173 |    41 | Not started        |
| `no-conditional-empty-object-spread`        |              166 |    24 | Not started        |
| `no-shape-in-symbol-names`                  |              130 |    15 | Not started        |
| `no-runtime-typeof`                         |              103 |    23 | Not started        |
| `no-unknown-parameters`                     |               60 |    14 | Not started        |
| `no-known-value-widening`                   |               42 |    23 | Not started        |
| `no-unsafe-dictionary-type`                 |               25 |    14 | Not started        |
| `no-unknown-returns`                        |                6 |     5 | Complete and gated |

Rules already clean:

- `no-chained-type-assertions`
- `no-module-mocking`
- `no-object-parameters`
- `no-reflect-apply`
- `no-reflect-get`
- `no-unknown-type-aliases`
- `no-widen-then-assert`

## Work units

### 1. External-data boundaries

Start here because the `unknown` and `typeof` findings frequently describe the
same missing parsing boundary. Prefer Zod schemas or existing domain parsers
over collections of ad hoc narrowing helpers.

- [ ] Shared compaction imports and repository schemas
  - `src/server/compactionImport.ts`
- [x] Parse Claude Code, Codex, OpenCode, and Pi session details before
      returning
- [x] Give stable telemetry and diagnostic values concrete return contracts
- [ ] Cursor artifact parsing
  - `src/server/cursorAgentRepository.ts`
- [ ] Source artifact and file import errors
  - `src/server/sourceArtifactRepository.ts`
  - `src/server/fileSessionImporter.ts`
- [ ] Responses cache lab parsing
  - `tools/responses-cache-lab/`
- [ ] Pi cache telemetry parsing
  - `tools/pi-cache-telemetry/extensions/cache-telemetry.ts`
- [ ] Remaining client and server runtime narrowing

Expected rules reduced by this unit:

- `no-unknown-returns`
- `no-unknown-parameters`
- `no-runtime-typeof`
- Some `no-unsafe-dictionary-type`
- Some assertion findings

### 2. Preserve inferred evidence

- [ ] Replace open dictionary annotations with inference, `satisfies`, or named
      owner contracts
- [ ] Replace unsafe dictionary value contracts with parsed or domain-specific
      values
- [ ] Verify shared contracts before migrating leaf modules

Expected rules reduced by this unit:

- `no-known-value-widening`
- `no-unsafe-dictionary-type`

### 3. Structural object construction

- [ ] Replace conditional empty-object spreads with explicit construction
- [ ] Handle shared builders before repetitive call sites
- [ ] Keep optional-property semantics unchanged

Expected rule reduced by this unit:

- `no-conditional-empty-object-spread`

### 4. Domain naming

- [ ] Classify symbols containing `shape` by domain meaning
- [ ] Rename exported/shared symbols before local symbols
- [ ] Avoid replacing `shape` with another vague representation word

Expected rule reduced by this unit:

- `no-shape-in-symbol-names`

### 5. Assertions

Do this last because earlier schema and inference work should remove assertions.
Do not add generic safety comments mechanically.

- [ ] Remove assertions made unnecessary by parsing or inference
- [ ] Replace assertion-based narrowing with domain constructors where available
- [ ] Add `SAFETY:` comments only when a concrete checked invariant remains

Expected rule reduced by this unit:

- `require-safety-comment-for-type-assertion`

### 6. Enforcement

- [ ] Reach zero anti-slop findings
- [ ] Run Deno lint, type checks, and tests
- [x] Add the rule-level Oxlint gate to `prek.toml`
- [ ] Decide whether `deno task check` should include Oxlint

The gate uses `.oxlintrc.prek.json`. It enforces every rule that has no known
findings, while `.oxlintrc.json` remains the full migration target. Promote a
rule into the gate as soon as it reaches zero globally; do not gate by aggregate
finding counts.

## Coordination

Parallel implementation should use disjoint file sets, not one agent per rule.
Several rules overlap in the same parsing functions, and independent rule-based
edits would conflict or produce inconsistent boundary designs.

Recommended workflow for each work unit:

1. Record its starting rule counts.
2. Establish shared contracts and parsing conventions in a primary change.
3. Split remaining leaf files among agents only when their paths do not overlap.
4. Run the relevant rules during implementation.
5. Run the full Oxlint baseline once at completion.
6. Update this document and commit the unit separately.

## Current hotspots

| Findings | File                                                     |
| -------: | -------------------------------------------------------- |
|       63 | `src/server/conversationRepository.ts`                   |
|       39 | `tools/pi-cache-telemetry/extensions/cache-telemetry.ts` |
|       33 | `tools/responses-cache-lab/main.ts`                      |
|       32 | `src/server/opencodeRepository.ts`                       |
|       31 | `tools/responses-cache-lab/scenario.ts`                  |
|       31 | `src/server/cursorAgentRepository.ts`                    |
|       30 | `src/server/main.ts`                                     |
|       28 | `src/server/codexRepository.ts`                          |
|       26 | `src/server/claudeCodeRepository.ts`                     |
|       25 | `src/server/conversationWriteRepository.ts`              |
