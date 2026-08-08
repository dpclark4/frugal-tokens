# Archive schema notes

## Canonical model

The archive separates physical ingestion state from logical conversations:

```text
Source
  └─ Source artifact
       ├─ projection checkpoint
       ├─ identities and lineage
       └─ occurrences

Conversation
  ├─ branches
  ├─ entries
  ├─ turns
  ├─ model calls
  │    └─ tool events
  ├─ subagent launches
  └─ rollup and cache-miss materializations
```

`source_sessions` retains its deployed table name, but its rows represent source
artifacts. It stores discovery identity, path, availability, physical stat hints,
and observation timestamps. `artifact_import_projections` stores the canonical
`conversation` parser/checksum/dependency checkpoint and its last error.

Conversations are the product session and counting unit. A linear artifact maps
to one conversation and branch. Related fork artifacts can map to one
conversation with several branches. Canonical calls are priced and counted once;
artifact call and entry occurrences preserve source provenance and distinguish
executed, copied, and unresolved evidence.

Subagent launches are separate from branch ancestry. A child conversation remains
a conversation with its own calls and is linked through
`conversation_subagent_launches`.

## Materialized data

`conversation_rollups.summary_json`, `overview_json`, and
`conversation_cache_misses` are disposable read materializations rebuilt by a
successful conversation write. Import and replacement transactions retain the
last successfully materialized conversation when parsing or writing fails.

Content storage remains privacy-bounded: entries and tool events store metadata
and bounded previews rather than complete raw harness records.

## Historical schema

The initial `sessions`, `turns`, `model_calls`, `models`, content, context,
reasoning, cache, and session-rollup tables were removed by the forward cleanup
migration after canonical cutover. Historical migrations remain unchanged so
existing databases can advance through the same migration chain.
