# Session diagnostics card

## What we are filling

The bottom-right overview card currently shows **Initial input** by harness over time. Initial input is already represented in Session shape, and the trend does not show whether starting context affected cost, time, or cache behavior. The replacement should add relationship analysis without making an already dense dashboard feel like another mini-dashboard.

## Current direction

Build one large relationship visualization with two explicit modes: **Spend** and **Processed input**.

- X: estimated active time
- Y: priced spend or processed input on a disclosed pseudo-log scale
- Small muted points for ordinary sessions
- Direct value labels on the three highest sessions for the selected metric
- Labeled dashed references for period medians
- Tooltip: title, harness/model, estimated active time, observed wall-clock span, spend, input, reuse, and turns
- Keyboard-accessible point navigation to session details

The implementation uses a Recharts `ScatterChart` with one point per session. Recharts is sufficient for this prototype and rendering roughly 300 SVG points is reasonable. Pseudo-log axes preserve zero values while expanding the dense low-value regions. Processed input and token reuse remain available in every tooltip rather than adding simultaneous size and color encodings. The purpose of this pass is to evaluate the real distributions before committing to anomaly scoring or density binning.

The activity-overview response includes the selected-period session rows needed by the chart. Active time uses the same estimation method as Estimated work. Session duration uses the imported session start and end timestamps and can include idle gaps, including time outside the selected reporting period for a session that overlaps it. Spend, processed input, and token reuse include only activity inside the selected period.

## Decisions from the discussion

- Keep the plotting area large; do not start with the 65/35 scatter, Pareto, and friction split.
- Do not use subtle previous/next arrows initially. Hidden pages have poor discoverability and require interaction to learn what exists.
- Do not call out inefficient sessions yet. The chart shows unusual relationships, not task quality or completed work.
- Do not build workflow-friction classifications yet. Repeated reads, retries, compactions, or model changes can be legitimate.
- Do not prioritize a Pareto page yet. The Usage section already reports spend from the top 10% of sessions.
- Keep Initial input available in Session shape and session-level data rather than dedicating this card to it.

## What to evaluate next

1. Open the 30-day all-harness view with real data.
2. Check whether approximately 300 points remain legible or collapse into a few overlapping clusters.
3. Check whether long or expensive tails compress the majority of sessions against the axes.
4. Check whether the pseudo-log spend and input axes make dense clusters legible without confusing interpretation.
5. Decide whether the labeled medians help orientation or merely add noise.
6. Check whether the three direct value labels collide at realistic widths.
7. Check whether full-session duration is clear when the chart metrics cover only the selected period.
8. Check 90 days and narrow layouts before further interaction polish.

If the raw plot is crowded, keep the same conceptual view but replace the background points with density bins or hexagonal bins and overlay only notable sessions. Recharts has no first-class hexbin chart, but it can render client-computed bins with a custom scatter shape. Marginal distributions are another option.

## Candidate future views

The first alternate is implemented as a labeled metric control rather than hidden pagination: processed input against estimated active time. Preserve this explicit-control pattern if another relationship is added.

### Cost concentration

- Sessions ranked by spend
- Bars or area: session spend
- Line: cumulative share of spend
- Question: is spend broad or driven by a small tail?

This is lower priority because the top-decile-spend KPI already answers the headline question.

### Workflow signals

Potential signals include repeated failures, frequent compaction, large tool outputs, repeated file reads, rapid model switching, and cache misses after long idle gaps. Build this only when each signal has a defensible definition, coverage, and attributable cost or time. Label associations as signals rather than confirmed waste.

### Cache retention

Plot idle gap against miss rate or miss cost, with provider/model TTL boundaries. This is likely better as a drill-down from Cache misses than as a page in Session diagnostics.

## Broader future ideas

- Context growth by turn number
- Cache-failure position within a session
- Calls per user turn and failure recovery
- Main-agent versus subagent cost composition
- Cost and input distributions by session shape
- Personal-baseline control charts
- Outcome-oriented measures such as time to passing checks, accepted changes, or reverted work

Outcome data is the strongest future basis for judging effective AI use. Until it exists, spend, duration, input, and cache behavior should be presented as observed characteristics rather than proof that usage is correct or incorrect.

## Resume checklist

- Run the app and inspect both relationship modes with real 30-day data.
- Capture a screenshot at the same viewport as the current overview reference.
- Record whether raw points, translucent points, or density bins communicate best.
- Confirm point-to-session mouse and keyboard navigation.
- If either mode is not useful, remove it rather than adding more pagination.
