-- migrate:up
ALTER TABLE conversation_rollups ADD COLUMN first_activity_at INTEGER;
ALTER TABLE conversation_rollups ADD COLUMN last_activity_at INTEGER;
ALTER TABLE conversation_rollups
  ADD COLUMN subagent_model_calls INTEGER NOT NULL DEFAULT 0
  CHECK (subagent_model_calls >= 0);
ALTER TABLE conversation_rollups
  ADD COLUMN subagent_uncached_input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (subagent_uncached_input_tokens >= 0);
ALTER TABLE conversation_rollups
  ADD COLUMN subagent_cache_read_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (subagent_cache_read_tokens >= 0);
ALTER TABLE conversation_rollups
  ADD COLUMN subagent_cache_write_tokens INTEGER
  CHECK (
    subagent_cache_write_tokens IS NULL OR
    subagent_cache_write_tokens >= 0
  );
ALTER TABLE conversation_rollups ADD COLUMN overview_json TEXT
  CHECK (overview_json IS NULL OR json_valid(overview_json));

UPDATE conversation_rollups AS conversation
SET (
  rollup_version,
  first_activity_at,
  last_activity_at,
  subagent_model_calls,
  subagent_uncached_input_tokens,
  subagent_cache_read_tokens,
  subagent_cache_write_tokens,
  overview_json
) = (
  SELECT
    legacy.rollup_version,
    legacy.first_activity_at,
    legacy.last_activity_at,
    legacy.subagent_model_calls,
    legacy.subagent_uncached_input_tokens,
    legacy.subagent_cache_read_tokens,
    legacy.subagent_cache_write_tokens,
    legacy.overview_json
  FROM conversation_branches branch
  JOIN session_rollups legacy ON legacy.root_session_id = branch.source_session_id
  WHERE branch.conversation_id = conversation.conversation_id
  ORDER BY branch.forked_from_branch_id IS NOT NULL, branch.id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM conversation_branches branch
  JOIN session_rollups legacy ON legacy.root_session_id = branch.source_session_id
  WHERE branch.conversation_id = conversation.conversation_id
);

CREATE INDEX conversation_rollups_activity_idx
  ON conversation_rollups(last_activity_at, conversation_id);
CREATE INDEX artifact_model_call_occurrences_branch_order_idx
  ON artifact_model_call_occurrences(
    branch_id,
    source_order_start,
    model_call_id
  );
CREATE INDEX artifact_entry_occurrences_branch_order_idx
  ON artifact_entry_occurrences(branch_id, source_order_start, entry_id);

-- migrate:down
DROP INDEX artifact_entry_occurrences_branch_order_idx;
DROP INDEX artifact_model_call_occurrences_branch_order_idx;
DROP INDEX conversation_rollups_activity_idx;
ALTER TABLE conversation_rollups DROP COLUMN overview_json;
ALTER TABLE conversation_rollups DROP COLUMN subagent_cache_write_tokens;
ALTER TABLE conversation_rollups DROP COLUMN subagent_cache_read_tokens;
ALTER TABLE conversation_rollups DROP COLUMN subagent_uncached_input_tokens;
ALTER TABLE conversation_rollups DROP COLUMN subagent_model_calls;
ALTER TABLE conversation_rollups DROP COLUMN last_activity_at;
ALTER TABLE conversation_rollups DROP COLUMN first_activity_at;
