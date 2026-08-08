-- migrate:up
DROP TABLE compaction_checkpoint_items;
DROP TABLE compaction_details;
DROP TABLE model_call_rollups;
DROP TABLE cache_misses;
DROP TABLE model_call_reasoning_settings;
DROP TABLE turn_reasoning_settings;
DROP TABLE reasoning_setting_events;
DROP TABLE context_events;
DROP TABLE session_rollups;
DROP TABLE tool_events;
DROP TABLE call_content;
DROP TABLE model_calls;
DROP TABLE models;
DROP TABLE turn_inputs;
DROP TABLE turns;
DROP TABLE sessions;

DROP INDEX source_sessions_parent_idx;
DROP INDEX source_sessions_tree_root_idx;
ALTER TABLE source_sessions DROP COLUMN parent_id;
ALTER TABLE source_sessions DROP COLUMN tree_root_id;
ALTER TABLE source_sessions DROP COLUMN public_id;
ALTER TABLE source_sessions DROP COLUMN working_directory;
ALTER TABLE source_sessions DROP COLUMN change_hint;
ALTER TABLE source_sessions DROP COLUMN checksum;
ALTER TABLE source_sessions DROP COLUMN parser_version;
ALTER TABLE source_sessions DROP COLUMN imported_at;
ALTER TABLE source_sessions DROP COLUMN last_error;

-- migrate:down
-- This destructive cleanup is restored by database/application rollback.
