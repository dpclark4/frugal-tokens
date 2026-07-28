-- migrate:up
CREATE TABLE session_rollups (
  root_session_id INTEGER PRIMARY KEY
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  rollup_version INTEGER NOT NULL CHECK (rollup_version > 0),
  first_activity_at INTEGER,
  last_activity_at INTEGER,
  computed_cost REAL CHECK (computed_cost IS NULL OR computed_cost >= 0),
  thinking_latest TEXT,
  thinking_values_json TEXT NOT NULL CHECK (json_valid(thinking_values_json)),
  thinking_classified_calls INTEGER NOT NULL CHECK (
    thinking_classified_calls >= 0
  ),
  context_latest INTEGER CHECK (context_latest IS NULL OR context_latest >= 0),
  context_peak INTEGER CHECK (context_peak IS NULL OR context_peak >= 0),
  context_peak_turn INTEGER CHECK (
    context_peak_turn IS NULL OR context_peak_turn > 0
  ),
  context_peak_call INTEGER CHECK (
    context_peak_call IS NULL OR context_peak_call > 0
  ),
  subagent_count INTEGER NOT NULL CHECK (subagent_count >= 0),
  subagent_user_turns INTEGER NOT NULL CHECK (subagent_user_turns >= 0),
  subagent_model_calls INTEGER NOT NULL CHECK (subagent_model_calls >= 0),
  subagent_image_inputs INTEGER NOT NULL CHECK (subagent_image_inputs >= 0),
  subagent_uncached_input_tokens INTEGER NOT NULL CHECK (
    subagent_uncached_input_tokens >= 0
  ),
  subagent_cache_read_tokens INTEGER NOT NULL CHECK (
    subagent_cache_read_tokens >= 0
  ),
  subagent_cache_write_tokens INTEGER CHECK (
    subagent_cache_write_tokens IS NULL OR subagent_cache_write_tokens >= 0
  ),
  subagent_cache_write_5m_tokens INTEGER CHECK (
    subagent_cache_write_5m_tokens IS NULL OR
      subagent_cache_write_5m_tokens >= 0
  ),
  subagent_cache_write_1h_tokens INTEGER CHECK (
    subagent_cache_write_1h_tokens IS NULL OR
      subagent_cache_write_1h_tokens >= 0
  ),
  subagent_fresh_prompt_tokens INTEGER NOT NULL CHECK (
    subagent_fresh_prompt_tokens >= 0
  ),
  subagent_output_tokens INTEGER NOT NULL CHECK (
    subagent_output_tokens >= 0
  ),
  subagent_reasoning_tokens INTEGER NOT NULL CHECK (
    subagent_reasoning_tokens >= 0
  ),
  subagent_processed_tokens INTEGER NOT NULL CHECK (
    subagent_processed_tokens >= 0
  ),
  subagent_reported_cost REAL CHECK (
    subagent_reported_cost IS NULL OR subagent_reported_cost >= 0
  ),
  subagent_computed_cost REAL CHECK (
    subagent_computed_cost IS NULL OR subagent_computed_cost >= 0
  ),
  overview_json TEXT NOT NULL CHECK (json_valid(overview_json))
);

CREATE INDEX session_rollups_activity_idx
  ON session_rollups(last_activity_at, root_session_id);

-- migrate:down
DROP INDEX session_rollups_activity_idx;
DROP TABLE session_rollups;
