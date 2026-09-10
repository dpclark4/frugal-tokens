-- migrate:up
CREATE INDEX conversation_tool_events_call_execution_idx
  ON conversation_tool_events(model_call_id, completed_at, started_at);

-- migrate:down
DROP INDEX conversation_tool_events_call_execution_idx;
