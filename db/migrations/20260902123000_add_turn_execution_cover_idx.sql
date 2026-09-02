-- migrate:up
CREATE INDEX conversation_turns_execution_idx
  ON conversation_turns(conversation_id, id, started_at, ordinal);

-- migrate:down
DROP INDEX conversation_turns_execution_idx;
