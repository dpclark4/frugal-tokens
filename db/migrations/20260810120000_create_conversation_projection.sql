-- migrate:up
CREATE TABLE artifact_import_projections (
  source_session_id INTEGER NOT NULL
    REFERENCES source_sessions(id) ON DELETE CASCADE,
  projection_name TEXT NOT NULL,
  parser_version TEXT,
  source_checksum TEXT,
  source_change_hint TEXT,
  dependency_digest TEXT,
  imported_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (source_session_id, projection_name)
);

INSERT INTO artifact_import_projections (
  source_session_id, projection_name, parser_version, source_checksum,
  source_change_hint, imported_at, last_error
)
SELECT id, 'legacy', parser_version, checksum, change_hint, imported_at,
  last_error
FROM source_sessions
WHERE parser_version IS NOT NULL OR checksum IS NOT NULL OR
  change_hint IS NOT NULL OR imported_at IS NOT NULL OR last_error IS NOT NULL;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  working_directory TEXT,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  providers_json TEXT NOT NULL CHECK (json_valid(providers_json)),
  models_json TEXT NOT NULL CHECK (json_valid(models_json)),
  agent TEXT,
  public_id TEXT,
  UNIQUE (source_id, external_id)
);

CREATE INDEX conversations_updated_idx
  ON conversations(updated_at DESC, id DESC);

CREATE TABLE conversation_turns (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_turn_id INTEGER REFERENCES conversation_turns(id) ON DELETE SET NULL,
  source_turn_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  started_at INTEGER NOT NULL,
  reasoning_setting_name TEXT,
  reasoning_setting_value TEXT,
  reasoning_source_field_path TEXT,
  reasoning_source_order INTEGER,
  reasoning_observed_at INTEGER,
  reasoning_provenance TEXT,
  UNIQUE (conversation_id, ordinal)
);

CREATE INDEX conversation_turns_parent_idx
  ON conversation_turns(parent_turn_id);

CREATE TABLE conversation_model_calls (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES conversation_turns(id) ON DELETE SET NULL,
  source_call_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  call_within_turn INTEGER CHECK (call_within_turn IS NULL OR call_within_turn > 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  reported_cost REAL CHECK (reported_cost IS NULL OR reported_cost >= 0),
  computed_cost REAL CHECK (computed_cost IS NULL OR computed_cost >= 0),
  uncached_input_tokens INTEGER NOT NULL CHECK (uncached_input_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cache_write_5m_tokens INTEGER CHECK (cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0),
  cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0),
  fresh_prompt_tokens INTEGER NOT NULL CHECK (fresh_prompt_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  processed_tokens INTEGER NOT NULL CHECK (processed_tokens >= 0),
  finish_reason TEXT,
  images INTEGER CHECK (images IS NULL OR images > 0),
  has_text INTEGER NOT NULL CHECK (has_text IN (0, 1)),
  has_reasoning INTEGER NOT NULL CHECK (has_reasoning IN (0, 1)),
  reasoning_setting_name TEXT,
  reasoning_setting_value TEXT,
  reasoning_source_field_path TEXT,
  reasoning_source_order INTEGER,
  reasoning_observed_at INTEGER,
  reasoning_provenance TEXT,
  UNIQUE (conversation_id, ordinal)
);

CREATE INDEX conversation_model_calls_started_idx
  ON conversation_model_calls(started_at);
CREATE INDEX conversation_model_calls_turn_idx
  ON conversation_model_calls(turn_id);

CREATE TABLE conversation_tool_events (
  id INTEGER PRIMARY KEY,
  model_call_id INTEGER NOT NULL REFERENCES conversation_model_calls(id) ON DELETE CASCADE,
  source_tool_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  input_preview TEXT,
  input_original_length INTEGER CHECK (input_original_length IS NULL OR input_original_length >= 0),
  input_truncated INTEGER NOT NULL DEFAULT 0 CHECK (input_truncated IN (0, 1)),
  output_preview TEXT,
  output_original_length INTEGER CHECK (output_original_length IS NULL OR output_original_length >= 0),
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
  child_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  UNIQUE (model_call_id, ordinal)
);

CREATE INDEX conversation_tool_events_child_idx
  ON conversation_tool_events(child_conversation_id);

CREATE TABLE conversation_entries (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES conversation_turns(id) ON DELETE SET NULL,
  parent_entry_id INTEGER REFERENCES conversation_entries(id) ON DELETE SET NULL,
  producer_model_call_id INTEGER REFERENCES conversation_model_calls(id) ON DELETE CASCADE,
  producer_tool_event_id INTEGER REFERENCES conversation_tool_events(id) ON DELETE CASCADE,
  output_ordinal INTEGER CHECK (output_ordinal IS NULL OR output_ordinal > 0),
  stable_source_id TEXT,
  kind TEXT NOT NULL,
  role TEXT,
  content_kind TEXT,
  occurred_at INTEGER,
  content_preview TEXT,
  original_length INTEGER CHECK (original_length IS NULL OR original_length >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  mime_type TEXT,
  content_hash TEXT,
  native_metadata_json TEXT CHECK (native_metadata_json IS NULL OR json_valid(native_metadata_json)),
  CHECK (producer_model_call_id IS NULL OR producer_tool_event_id IS NULL),
  CHECK ((producer_model_call_id IS NULL AND producer_tool_event_id IS NULL) OR output_ordinal IS NOT NULL)
);

CREATE UNIQUE INDEX conversation_entries_stable_source_idx
  ON conversation_entries(conversation_id, stable_source_id)
  WHERE stable_source_id IS NOT NULL;
CREATE UNIQUE INDEX conversation_entries_call_output_idx
  ON conversation_entries(producer_model_call_id, output_ordinal)
  WHERE producer_model_call_id IS NOT NULL;
CREATE UNIQUE INDEX conversation_entries_tool_output_idx
  ON conversation_entries(producer_tool_event_id, output_ordinal)
  WHERE producer_tool_event_id IS NOT NULL;
CREATE INDEX conversation_entries_parent_idx
  ON conversation_entries(parent_entry_id);
CREATE INDEX conversation_entries_turn_idx
  ON conversation_entries(turn_id);
CREATE INDEX conversation_entries_conversation_kind_idx
  ON conversation_entries(conversation_id, kind, id);

CREATE TABLE conversation_branches (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_session_id INTEGER REFERENCES source_sessions(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  forked_from_branch_id INTEGER REFERENCES conversation_branches(id) ON DELETE SET NULL,
  fork_point_entry_id INTEGER REFERENCES conversation_entries(id) ON DELETE SET NULL,
  head_entry_id INTEGER REFERENCES conversation_entries(id) ON DELETE SET NULL,
  fork_point_provenance TEXT NOT NULL CHECK (
    fork_point_provenance IN ('explicit', 'inferred-confirmed', 'unresolved')
  ),
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, external_id)
);

CREATE INDEX conversation_branches_source_session_idx
  ON conversation_branches(source_session_id);
CREATE INDEX conversation_branches_parent_idx
  ON conversation_branches(forked_from_branch_id);
CREATE INDEX conversation_branches_fork_entry_idx
  ON conversation_branches(fork_point_entry_id);
CREATE INDEX conversation_branches_head_entry_idx
  ON conversation_branches(head_entry_id);

CREATE TABLE artifact_entry_occurrences (
  source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES conversation_branches(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES conversation_entries(id) ON DELETE CASCADE,
  source_entry_id TEXT,
  source_order_start INTEGER,
  source_order_end INTEGER,
  occurrence_kind TEXT NOT NULL CHECK (occurrence_kind IN ('executed', 'copied', 'unknown')),
  identity_basis TEXT NOT NULL CHECK (identity_basis IN ('stable-id', 'explicit-lineage', 'unresolved')),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  PRIMARY KEY (source_session_id, entry_id)
);

CREATE INDEX artifact_entry_occurrences_branch_order_idx
  ON artifact_entry_occurrences(branch_id, source_order_start, entry_id);
CREATE INDEX artifact_entry_occurrences_entry_idx
  ON artifact_entry_occurrences(entry_id);

CREATE TABLE artifact_model_call_occurrences (
  source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES conversation_branches(id) ON DELETE CASCADE,
  model_call_id INTEGER NOT NULL REFERENCES conversation_model_calls(id) ON DELETE CASCADE,
  source_turn_id TEXT,
  source_call_id TEXT,
  source_order_start INTEGER,
  source_order_end INTEGER,
  occurrence_kind TEXT NOT NULL CHECK (occurrence_kind IN ('executed', 'copied', 'unknown')),
  identity_basis TEXT NOT NULL CHECK (identity_basis IN ('stable-id', 'explicit-lineage', 'unresolved')),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  PRIMARY KEY (source_session_id, model_call_id)
);

CREATE INDEX artifact_model_call_occurrences_branch_order_idx
  ON artifact_model_call_occurrences(branch_id, source_order_start, model_call_id);
CREATE INDEX artifact_model_call_occurrences_call_idx
  ON artifact_model_call_occurrences(model_call_id);

CREATE TABLE conversation_subagent_launches (
  id INTEGER PRIMARY KEY,
  parent_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  child_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  launch_entry_id INTEGER REFERENCES conversation_entries(id) ON DELETE SET NULL,
  model_call_id INTEGER REFERENCES conversation_model_calls(id) ON DELETE SET NULL,
  tool_event_id INTEGER REFERENCES conversation_tool_events(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL,
  UNIQUE (parent_conversation_id, child_conversation_id)
);

CREATE INDEX conversation_subagent_launches_child_idx
  ON conversation_subagent_launches(child_conversation_id);
CREATE INDEX conversation_subagent_launches_entry_idx
  ON conversation_subagent_launches(launch_entry_id);
CREATE INDEX conversation_subagent_launches_call_idx
  ON conversation_subagent_launches(model_call_id);
CREATE INDEX conversation_subagent_launches_tool_idx
  ON conversation_subagent_launches(tool_event_id);

CREATE TABLE conversation_rollups (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  rollup_version INTEGER NOT NULL CHECK (rollup_version > 0),
  user_turns INTEGER NOT NULL CHECK (user_turns >= 0),
  model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
  reported_cost REAL CHECK (reported_cost IS NULL OR reported_cost >= 0),
  computed_cost REAL CHECK (computed_cost IS NULL OR computed_cost >= 0),
  uncached_input_tokens INTEGER NOT NULL CHECK (uncached_input_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cache_write_5m_tokens INTEGER CHECK (cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0),
  cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0),
  fresh_prompt_tokens INTEGER NOT NULL CHECK (fresh_prompt_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  processed_tokens INTEGER NOT NULL CHECK (processed_tokens >= 0),
  first_activity_at INTEGER,
  last_activity_at INTEGER,
  subagent_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (subagent_model_calls >= 0),
  subagent_uncached_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (subagent_uncached_input_tokens >= 0),
  subagent_cache_read_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (subagent_cache_read_tokens >= 0),
  subagent_cache_write_tokens INTEGER
    CHECK (subagent_cache_write_tokens IS NULL OR subagent_cache_write_tokens >= 0),
  overview_json TEXT CHECK (overview_json IS NULL OR json_valid(overview_json)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json))
);

CREATE INDEX conversation_rollups_activity_idx
  ON conversation_rollups(last_activity_at, conversation_id);

CREATE TABLE source_artifact_identities (
  source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  identity_namespace TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  PRIMARY KEY (source_session_id, identity_namespace),
  UNIQUE (source_id, identity_namespace, identity_value)
);

CREATE TABLE source_artifact_lineage (
  child_source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  relationship_kind TEXT NOT NULL,
  parent_identity_namespace TEXT NOT NULL,
  parent_identity_value TEXT NOT NULL,
  parent_source_session_id INTEGER REFERENCES source_sessions(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (child_source_session_id, relationship_kind),
  CHECK (child_source_session_id <> parent_source_session_id)
);

CREATE INDEX source_artifact_lineage_parent_idx
  ON source_artifact_lineage(parent_source_session_id);

CREATE TABLE conversation_cache_misses (
  model_call_id INTEGER PRIMARY KEY
    REFERENCES conversation_model_calls(id) ON DELETE CASCADE,
  previous_model_call_id INTEGER
    REFERENCES conversation_model_calls(id) ON DELETE SET NULL,
  conversation_id INTEGER NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL
    REFERENCES conversation_turns(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  gap_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('partial-hit', 'full-miss')),
  reason TEXT,
  cause TEXT CHECK (
    cause IS NULL OR cause IN ('compaction', 'ttl', 'thinking-change')
  ),
  retained_ratio REAL CHECK (retained_ratio IS NULL OR retained_ratio >= 0),
  previous_reusable_tokens INTEGER
    CHECK (previous_reusable_tokens IS NULL OR previous_reusable_tokens > 0),
  previous_context_tokens INTEGER NOT NULL CHECK (previous_context_tokens >= 0),
  current_context_tokens INTEGER NOT NULL CHECK (current_context_tokens >= 0),
  actual_cache_read_tokens INTEGER NOT NULL CHECK (actual_cache_read_tokens >= 0),
  missed_tokens INTEGER NOT NULL CHECK (missed_tokens >= 0),
  model_call_cost REAL CHECK (model_call_cost IS NULL OR model_call_cost >= 0),
  actual_missed_cost REAL CHECK (actual_missed_cost IS NULL OR actual_missed_cost >= 0),
  expected_read_cost REAL CHECK (expected_read_cost IS NULL OR expected_read_cost >= 0),
  estimated_extra_cost REAL
);

CREATE INDEX conversation_cache_misses_started_idx
  ON conversation_cache_misses(started_at);
CREATE INDEX conversation_cache_misses_cause_started_idx
  ON conversation_cache_misses(cause, started_at);
CREATE INDEX conversation_cache_misses_conversation_started_idx
  ON conversation_cache_misses(conversation_id, started_at);
CREATE INDEX conversation_cache_misses_previous_call_idx
  ON conversation_cache_misses(previous_model_call_id);
CREATE INDEX conversation_cache_misses_turn_idx
  ON conversation_cache_misses(turn_id);

-- migrate:down
DROP TABLE conversation_cache_misses;
DROP TABLE source_artifact_lineage;
DROP TABLE source_artifact_identities;
DROP TABLE conversation_rollups;
DROP TABLE conversation_subagent_launches;
DROP TABLE artifact_model_call_occurrences;
DROP TABLE artifact_entry_occurrences;
DROP TABLE conversation_branches;
DROP TABLE conversation_entries;
DROP TABLE conversation_tool_events;
DROP TABLE conversation_model_calls;
DROP TABLE conversation_turns;
DROP TABLE conversations;
DROP TABLE artifact_import_projections;
