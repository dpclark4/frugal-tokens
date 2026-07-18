# Agent Instructions

## Verification And Git

Conserve tool calls and tokens during implementation.

- Do not run tests, type checks, builds, linters, format checks, or Git
  inspection as routine intermediate steps.
- Run relevant verification once, after the requested work appears complete.
- Prefer the smallest targeted verification that provides useful confidence.
- Batch independent verification commands when possible.
- Run intermediate verification only when needed to diagnose an error or guide
  the implementation.
- Do not run Git commands unless the user requests Git work, repository state is
  necessary for safe editing, or a final diff inspection is useful.
- When it is ambiguous whether a verification or Git command is needed, do not
  run it.
- In the final response, report verification performed and explicitly mention
  relevant checks that were not run.

## Commit Messages

When asked to commit, use a concise imperative title followed by a factual
bullet-point body:

- Context: the observed problem or motivation.
- Changes: the essential implementation changes.
- Outcome: the resulting behavior or user-facing effect.

Keep each bullet to one sentence. Use only established facts; do not invent
backstory. Apply this format to every commit, including when the user only
says "commit."
