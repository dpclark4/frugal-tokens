-- migrate:up
CREATE TABLE context_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  source_order INTEGER NOT NULL CHECK (source_order > 0),
  occurred_at INTEGER,
  affected_model_call_id INTEGER
    REFERENCES model_calls(id) ON DELETE SET NULL,
  UNIQUE (session_id, source_order)
);

CREATE INDEX context_events_affected_call_idx
  ON context_events(affected_model_call_id)
  WHERE affected_model_call_id IS NOT NULL;

-- migrate:down
DROP INDEX context_events_affected_call_idx;
DROP TABLE context_events;
