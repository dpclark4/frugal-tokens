# Session Explorer Data Model Considerations

## Background

These notes came from reworking the session explorer around its actual
hierarchy: sessions contain turns, turns contain model calls, and model calls
can contain tool calls or launch subagent sessions. The current archive is
already sufficient for a better explorer, but several normalized fields are
display-oriented previews or inferred semantics rather than durable domain
concepts.

This is a focused product backlog, not a proposal for an immediate schema
rewrite. See [schema-notes.md](schema-notes.md) for the broader archive and
transcript-graph discussion.

## Considerations

### Terminal assistant responses are inferred

- **Problem:** The explorer infers that the last text-only model call in a turn
  produced the assistant response.
- **Gap or impact:** Interrupted calls, unusual provider finish reasons, and
  harness-specific behavior can be mislabeled or leave a real response
  unidentified.
- **Suggested change:** Normalize a call outcome during import and explicitly
  identify the terminal assistant response for a turn. Retain the native finish
  reason as provenance.

### Call activity and response content are conflated

- **Problem:** `ModelCall.preview` is a 64-character summary sourced from either
  text content or a tool target. It is not a stable representation of the
  call's output.
- **Gap or impact:** The UI cannot reliably distinguish intermediate narration,
  a tool request, and the final user-facing response from this field alone.
- **Suggested change:** Keep a compact activity summary as a derived display
  field, but expose ordered, typed call content separately. Classify its role
  only where the source data supports that classification.

### Content previews have inconsistent metadata

- **Problem:** Turn inputs and call content retain original length and
  truncation state, while tool input and output previews do not expose the same
  metadata.
- **Gap or impact:** The explorer cannot consistently tell users whether a
  value is complete, offer meaningful expansion, or explain why content stops.
- **Suggested change:** Use one preview metadata shape across turn inputs, call
  content, tool inputs, and tool outputs: preview, original length, truncation,
  MIME type where relevant, and optional content hash.

### Provider finish reasons are not normalized

- **Problem:** Providers use values such as `stop`, `end_turn`, `tool_use`, or
  no finish reason at all.
- **Gap or impact:** UI code must know provider vocabulary and can classify the
  same outcome differently across harnesses.
- **Suggested change:** Store a normalized outcome such as `completed`,
  `tool-requested`, `length-limited`, `interrupted`, or `error`, alongside the
  unmodified source value.

### Subagent entry points are indirect

- **Problem:** A subagent session is connected through a tool event's child
  session ID, while the parent relationship is also represented at the session
  level.
- **Gap or impact:** It is harder to answer which exact turn, call, and tool
  launched a subagent, and consistency depends on application code maintaining
  both sides of the relationship.
- **Suggested change:** Preserve an explicit launch relation containing parent
  session, turn, model call, tool event, and child session identifiers. Validate
  that the session-level parent agrees with the launch relation.

### Direct and inclusive metrics are easy to confuse

- **Problem:** Session, turn, call, and subagent summaries mix direct metrics
  with values rolled up from descendant subagents.
- **Gap or impact:** A value can be technically correct but unclear in the UI,
  and future calculations may accidentally count descendants twice.
- **Suggested change:** Establish shared direct/inclusive metric types and
  naming. Compute inclusive values through one traversal and document which
  level owns each materialized aggregate.

### Ordered content is flattened for the API

- **Problem:** The archive stores ordered `call_content` rows, but the session
  detail API currently exposes selected previews rather than the ordered list.
- **Gap or impact:** Intermediate model text, multiple text blocks, reasoning,
  and content ordering cannot be presented or analyzed accurately.
- **Suggested change:** Add an ordered content-block API when the explorer is
  ready to show intra-turn model responses. Avoid treating the first text block
  as the complete call response.

### Public identifiers have contextual uniqueness

- **Problem:** Imported call and session identifiers are not universally
  guaranteed to be unique outside their source or parent scope.
- **Gap or impact:** Expansion state, cross-links, and future deep links can
  collide if they use source identifiers without their owning scope.
- **Suggested change:** Use archive IDs or explicit compound public keys for UI
  identity while retaining native IDs for provenance.

## Suggested Order

1. Normalize call outcomes and terminal-response identity.
2. Add a consistent preview metadata contract.
3. Make subagent launch relationships explicit and validated.
4. Expose ordered call content for intermediate-response exploration.
5. Standardize direct and inclusive metric contracts.
