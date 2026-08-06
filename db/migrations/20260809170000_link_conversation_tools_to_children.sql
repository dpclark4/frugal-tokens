-- migrate:up
ALTER TABLE conversation_tool_events
  ADD COLUMN child_conversation_id INTEGER
  REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX conversation_tool_events_child_idx
  ON conversation_tool_events(child_conversation_id);

-- Existing conversation projections are rebuilt by their parser-version bumps.

-- migrate:down
DROP INDEX conversation_tool_events_child_idx;
ALTER TABLE conversation_tool_events DROP COLUMN child_conversation_id;
