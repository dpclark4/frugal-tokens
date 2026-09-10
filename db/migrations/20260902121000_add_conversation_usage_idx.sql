-- migrate:up
CREATE INDEX conversation_model_calls_conversation_usage_idx
  ON conversation_model_calls(
    conversation_id, started_at, source_call_id,
    uncached_input_tokens, cache_read_tokens, cache_write_tokens,
    computed_cost, reported_cost
  );

-- migrate:down
DROP INDEX conversation_model_calls_conversation_usage_idx;
