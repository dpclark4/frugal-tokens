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

## UI Descriptions

- Do not add subtitles, helper text, or descriptive copy beneath headings,
  labels, cards, or settings by default. Prefer one concise,
  self-explanatory heading or label. Only add supporting copy when the user
  explicitly asks for it or when it is necessary to prevent misunderstanding
  or error, and never use it to restate the heading.

## Analytics Dashboard Design

- Prefer compact observability-report sections over generic KPI-card grids.
- Give each metric or visualization a distinct user question; avoid repeating
  nearby totals, rates, or activity measures.
- Make denominators, coverage, and interpretation limits explicit where needed.
  Supporting copy must clarify methodology or prevent misunderstanding; it must
  not restate the label.
- Prefer distributions for skewed per-session measures, trends for change over
  time, ranked tables for categorical comparison, and composition charts only
  when part-to-whole comparison is meaningful.
- Use color semantically and sparingly: do not imply that more usage,
  subagents, longer sessions, or cache misses are inherently good or bad.
- Distinguish observed data, derived metrics, likely explanations, and
  confirmed causes. Do not claim avoidable cost or inefficiency without
  supporting evidence.
- Preserve information density by removing redundancy before reducing type
  size, and do not truncate primary labels or values.

## Commit Messages

When asked to commit, use a concise imperative title followed by a factual
bullet-point body:

- Context: the observed problem or motivation.
- Changes: the essential implementation changes.
- Outcome: the resulting behavior or user-facing effect.

Keep each bullet to one sentence. Use only established facts; do not invent
backstory. Apply this format to every commit, including when the user only
says "commit."
