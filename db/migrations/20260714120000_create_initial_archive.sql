-- migrate:up
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  location TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (harness, location)
);

CREATE TABLE source_sessions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  parent_id INTEGER REFERENCES source_sessions(id) ON DELETE SET NULL,
  artifact_path TEXT,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (
    availability IN ('available', 'missing')
  ),
  source_size INTEGER CHECK (source_size IS NULL OR source_size >= 0),
  source_modified_at INTEGER,
  checksum TEXT,
  parser_version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  imported_at INTEGER,
  last_error TEXT,
  UNIQUE (source_id, external_id)
);

CREATE INDEX source_sessions_source_availability_idx
  ON source_sessions(source_id, availability);
CREATE INDEX source_sessions_parent_idx ON source_sessions(parent_id);

CREATE TABLE sessions (
  source_session_id INTEGER PRIMARY KEY
    REFERENCES source_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  agent TEXT,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  providers_json TEXT NOT NULL CHECK (json_valid(providers_json)),
  models_json TEXT NOT NULL CHECK (json_valid(models_json)),
  user_turns INTEGER NOT NULL CHECK (user_turns >= 0),
  model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
  reported_cost REAL CHECK (reported_cost IS NULL OR reported_cost >= 0),
  uncached_input_tokens INTEGER NOT NULL CHECK (uncached_input_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (
    cache_write_tokens IS NULL OR cache_write_tokens > 0
  ),
  cache_write_5m_tokens INTEGER CHECK (
    cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0
  ),
  cache_write_1h_tokens INTEGER CHECK (
    cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0
  ),
  fresh_prompt_tokens INTEGER NOT NULL CHECK (fresh_prompt_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  processed_tokens INTEGER NOT NULL CHECK (processed_tokens >= 0)
);

CREATE INDEX sessions_updated_idx
  ON sessions(updated_at DESC, source_session_id DESC);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  started_at INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);

CREATE TABLE turn_inputs (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL,
  preview TEXT,
  original_length INTEGER CHECK (
    original_length IS NULL OR original_length >= 0
  ),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  mime_type TEXT,
  content_hash TEXT,
  UNIQUE (turn_id, ordinal)
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (provider, name)
);

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  source_call_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  reported_cost REAL CHECK (reported_cost IS NULL OR reported_cost >= 0),
  uncached_input_tokens INTEGER NOT NULL CHECK (uncached_input_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (
    cache_write_tokens IS NULL OR cache_write_tokens > 0
  ),
  cache_write_5m_tokens INTEGER CHECK (
    cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0
  ),
  cache_write_1h_tokens INTEGER CHECK (
    cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0
  ),
  fresh_prompt_tokens INTEGER NOT NULL CHECK (fresh_prompt_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  processed_tokens INTEGER NOT NULL CHECK (processed_tokens >= 0),
  finish_reason TEXT,
  images INTEGER CHECK (images IS NULL OR images > 0),
  has_text INTEGER NOT NULL CHECK (has_text IN (0, 1)),
  has_reasoning INTEGER NOT NULL CHECK (has_reasoning IN (0, 1)),
  UNIQUE (turn_id, ordinal)
);

CREATE INDEX model_calls_started_idx ON model_calls(started_at);

CREATE TABLE call_content (
  id INTEGER PRIMARY KEY,
  model_call_id INTEGER NOT NULL
    REFERENCES model_calls(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL,
  preview TEXT,
  original_length INTEGER CHECK (
    original_length IS NULL OR original_length >= 0
  ),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  mime_type TEXT,
  content_hash TEXT,
  UNIQUE (model_call_id, ordinal)
);

CREATE TABLE tool_events (
  id INTEGER PRIMARY KEY,
  model_call_id INTEGER NOT NULL
    REFERENCES model_calls(id) ON DELETE CASCADE,
  source_tool_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  child_source_session_id INTEGER
    REFERENCES source_sessions(id) ON DELETE SET NULL,
  input_preview TEXT,
  input_original_length INTEGER CHECK (
    input_original_length IS NULL OR input_original_length >= 0
  ),
  input_truncated INTEGER NOT NULL DEFAULT 0 CHECK (
    input_truncated IN (0, 1)
  ),
  output_preview TEXT,
  output_original_length INTEGER CHECK (
    output_original_length IS NULL OR output_original_length >= 0
  ),
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (
    output_truncated IN (0, 1)
  ),
  UNIQUE (model_call_id, ordinal)
);

-- migrate:down
DROP TABLE tool_events;
DROP TABLE call_content;
DROP TABLE model_calls;
DROP TABLE models;
DROP TABLE turn_inputs;
DROP TABLE turns;
DROP TABLE sessions;
DROP TABLE source_sessions;
DROP TABLE sources;
