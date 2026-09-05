-- migrate:up
CREATE INDEX conversation_model_calls_turn_execution_idx
  ON conversation_model_calls(turn_id, source_call_id, completed_at, started_at);

-- migrate:down
DROP INDEX conversation_model_calls_turn_execution_idx;
