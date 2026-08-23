# Agent Instructions

## Verification And Git

Conserve tool calls and tokens during implementation.

- Do not run tests, type checks, builds, linters, format checks, or Git
  inspection as routine intermediate steps.
- Run relevant verification once, after the requested work appears complete.
- Prefer the smallest targeted verification that provides useful confidence.
- Batch independent verification commands when possible.
- Run Deno tests with `--reporter=dot` by default to minimize captured output.
  If tests fail, rerun only the failing file or test with `--reporter=pretty`
  when detailed diagnostics are needed.
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
  labels, cards, or settings by default. Prefer one concise, self-explanatory
  heading or label. Only add supporting copy when the user explicitly asks for
  it or when it is necessary to prevent misunderstanding or error, and never use
  it to restate the heading.
- Do not add eyebrows, kickers, preheadings, subtitles, or helper text that
  repeats a nearby heading or label. Positioning text above rather than below a
  heading does not make repetition useful.
- Modals should default to one concise heading, only the body copy required to
  explain consequences or prevent error, and actions. Do not add a section label
  or eyebrow unless it communicates distinct information.
- Omit headings, legends, labels, and instructions when their meaning can be
  reliably inferred from the surrounding context, layout, axes, or controls.
- Treat supplemental text as an attention and space cost. Before adding it,
  remove it mentally and ask whether any actionable meaning is lost. If not,
  omit it. Include non-primary copy deliberately only when it communicates
  information the interface cannot convey more directly; otherwise favor less
  text and visual clutter.

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
- Use color semantically and sparingly: do not imply that more usage, subagents,
  longer sessions, or cache misses are inherently good or bad.
- Distinguish observed data, derived metrics, likely explanations, and confirmed
  causes. Do not claim avoidable cost or inefficiency without supporting
  evidence.
- Preserve information density by removing redundancy before reducing type size,
  and do not truncate primary labels or values.

## Dashboard Typography And Tooltips

Treat the homepage dashboard typography as a small role-based design system. Use
the semantic custom properties defined on `.new-page` in
`src/client/NewPage.css` rather than introducing one-off sizes.

- Use the sans-serif application face for page and section headings. Use
  `var(--mono)` for metrics, tables, controls, chart labels, annotations, and
  tooltips. Use tabular numerals for aligned numeric data.
- Apply `--dashboard-type-section-title` (`23px`) to every primary dashboard
  section heading, including sections that reuse older shared components.
- Apply `--dashboard-type-summary` (`21px`) to compact section totals. Reserve
  `--dashboard-type-metric-primary` (`32px`) and
  `--dashboard-type-metric-secondary` (`24px`) for the Usage hierarchy; do not
  turn ordinary values into hero metrics.
- Apply `--dashboard-type-detail` (`16px`) to selected-day or similarly scoped
  detail metrics, `--dashboard-type-table` (`12px`) to table values and metric
  names, and `--dashboard-type-tooltip-value` (`11px`) to emphasized tooltip
  values.
- Apply `--dashboard-type-label` (`10px`) to controls, table headings,
  subsection headings, chart axes, tooltip body text, and supporting metadata.
  Apply `--dashboard-type-micro` (`9px`) only to dense annotations such as chart
  callouts, calendar weekdays, and tertiary paths. Do not use dashboard text
  smaller than `9px`.
- Keep uppercase mono labels concise, semibold, and lightly tracked. Do not use
  uppercase treatment for prose, values, session names, or tooltip content.
- Use `dashboardChartFont` and `dashboardChartLabelSize` from
  `src/client/new/formatters.ts` for Recharts axes. Keep exceptional chart
  annotations at the micro size instead of defining another axis size.
- Tooltips should use the global light `.tooltip-surface` primitive and its
  semantic custom properties from `src/client/styles.css`. Use the shared
  off-white background, neutral border, `5px` radius, compact shadow and
  padding, `10px` body text, and `11px` dark titles or emphasized values. Use
  `--tooltip-muted` for labels and secondary metadata and `--tooltip-rule` for
  dividers.
- Match tooltip structure and typography across routes and charts before adding
  a local variant. A variant may change width, positioning, visibility, or
  layout to fit its data, but must inherit the surface, color, type scale,
  border, radius, and shadow from `.tooltip-surface`.
- Expose custom hover information on keyboard focus when the underlying element
  is focusable. Tooltips must clarify data rather than carry actions or repeat
  visible labels unnecessarily.
- Responsive rules may reduce hero metrics or rearrange content, but should not
  create new typography roles or reduce labels below the micro size.

## Commit Messages

When asked to commit, use a concise imperative title followed by a factual
bullet-point body:

- Context: the observed problem or motivation.
- Changes: the essential implementation changes.
- Outcome: the resulting behavior or user-facing effect.

Keep each bullet to one sentence. Use only established facts; do not invent
backstory. Apply this format to every commit, including when the user only says
"commit."
