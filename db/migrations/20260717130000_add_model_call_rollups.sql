-- migrate:up
CREATE TABLE model_call_rollups (
  model_call_id INTEGER PRIMARY KEY
    REFERENCES model_calls(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  root_session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  cost REAL,
  cost_source TEXT CHECK (
    cost_source IS NULL OR cost_source IN ('computed', 'inferred')
  )
);

CREATE INDEX model_call_rollups_started_idx
  ON model_call_rollups(started_at);
CREATE INDEX model_call_rollups_root_started_idx
  ON model_call_rollups(root_session_id, started_at);
CREATE INDEX model_call_rollups_session_started_idx
  ON model_call_rollups(session_id, started_at);

-- migrate:down
DROP INDEX model_call_rollups_session_started_idx;
DROP INDEX model_call_rollups_root_started_idx;
DROP INDEX model_call_rollups_started_idx;
DROP TABLE model_call_rollups;
