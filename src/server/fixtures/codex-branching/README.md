# Sanitized Codex branching fixtures

These fixtures are synthetic, committed test data. They contain no live home-directory paths, user content, credentials, or provider payloads.

## `sibling-forks`

The three artifacts encode this conversation:

```text
turn-shared-1
  -> turn-shared-2
       |-> turn-fork-a-3 -> turn-fork-a-4
       `-> turn-original-3 -> turn-original-4 -> turn-fork-b-5
```

Expected canonical contract:

- conversations: 1
- branches/source artifacts: 3
- unique turns: 7
- turn occurrences across artifact paths: 13

The copied prefixes preserve turn, message, response, tool, task timing, compaction, and usage identity. Their outer JSONL timestamps are deliberately rewritten to demonstrate that outer timestamp equality is not required for identity.

## `nested-fork`

The three artifacts form root -> child -> grandchild ancestry. They contain three unique turns and six turn occurrences, with each descendant copying its ancestor path before executing a new turn.
