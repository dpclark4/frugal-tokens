-- migrate:up
CREATE TABLE cache_misses (
  model_call_id INTEGER PRIMARY KEY
    REFERENCES model_calls(id) ON DELETE CASCADE,
  previous_model_call_id INTEGER
    REFERENCES model_calls(id) ON DELETE SET NULL,
  session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  gap_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('partial-hit', 'full-miss')),
  reason TEXT,
  cause TEXT CHECK (
    cause IS NULL OR cause IN ('compaction', 'ttl', 'thinking-change')
  ),
  retained_ratio REAL CHECK (
    retained_ratio IS NULL OR retained_ratio >= 0
  ),
  previous_reusable_tokens INTEGER CHECK (
    previous_reusable_tokens IS NULL OR previous_reusable_tokens > 0
  ),
  previous_context_tokens INTEGER NOT NULL CHECK (previous_context_tokens >= 0),
  current_context_tokens INTEGER NOT NULL CHECK (current_context_tokens >= 0),
  actual_cache_read_tokens INTEGER NOT NULL CHECK (actual_cache_read_tokens >= 0),
  missed_tokens INTEGER NOT NULL CHECK (missed_tokens >= 0),
  model_call_cost REAL CHECK (model_call_cost IS NULL OR model_call_cost >= 0),
  actual_missed_cost REAL CHECK (
    actual_missed_cost IS NULL OR actual_missed_cost >= 0
  ),
  expected_read_cost REAL CHECK (
    expected_read_cost IS NULL OR expected_read_cost >= 0
  ),
  estimated_extra_cost REAL
);

CREATE INDEX cache_misses_started_idx ON cache_misses(started_at);
CREATE INDEX cache_misses_cause_started_idx
  ON cache_misses(cause, started_at);
CREATE INDEX cache_misses_session_started_idx
  ON cache_misses(session_id, started_at);

-- Force the existing source sessions through the importer once so the new
-- derived cache-miss rows are materialized without a separate backfill job.
UPDATE source_sessions SET parser_version = NULL;

-- migrate:down
DROP INDEX cache_misses_session_started_idx;
DROP INDEX cache_misses_cause_started_idx;
DROP INDEX cache_misses_started_idx;
DROP TABLE cache_misses;
