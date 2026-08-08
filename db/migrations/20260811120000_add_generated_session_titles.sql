-- migrate:up
ALTER TABLE source_sessions ADD COLUMN generated_title TEXT;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE title_generation_runs (
  id INTEGER PRIMARY KEY,
  source_session_id INTEGER NOT NULL
    REFERENCES source_sessions(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  input_characters INTEGER NOT NULL CHECK (input_characters >= 0),
  output_title TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  exit_code INTEGER,
  error TEXT
);

CREATE INDEX title_generation_runs_source_idx
  ON title_generation_runs(source_session_id, started_at DESC);

-- migrate:down
DROP INDEX title_generation_runs_source_idx;
DROP TABLE title_generation_runs;
DROP TABLE app_settings;
ALTER TABLE source_sessions DROP COLUMN generated_title;
