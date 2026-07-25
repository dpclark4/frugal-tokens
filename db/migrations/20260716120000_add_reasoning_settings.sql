-- migrate:up
CREATE TABLE reasoning_setting_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL
    REFERENCES sessions(source_session_id) ON DELETE CASCADE,
  setting_name TEXT NOT NULL CHECK (length(setting_name) > 0),
  setting_value TEXT NOT NULL,
  source_field_path TEXT,
  source_order INTEGER CHECK (source_order IS NULL OR source_order > 0),
  observed_at INTEGER
);

CREATE INDEX reasoning_setting_events_session_idx
  ON reasoning_setting_events(session_id, source_order);

CREATE INDEX reasoning_setting_events_value_idx
  ON reasoning_setting_events(setting_name, setting_value);

CREATE TABLE turn_reasoning_settings (
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  setting_event_id INTEGER NOT NULL
    REFERENCES reasoning_setting_events(id) ON DELETE CASCADE,
  provenance TEXT NOT NULL CHECK (
    provenance IN ('explicit', 'inherited', 'session_fallback')
  )
);

CREATE INDEX turn_reasoning_settings_event_idx
  ON turn_reasoning_settings(setting_event_id);

CREATE TABLE model_call_reasoning_settings (
  model_call_id INTEGER PRIMARY KEY
    REFERENCES model_calls(id) ON DELETE CASCADE,
  setting_event_id INTEGER NOT NULL
    REFERENCES reasoning_setting_events(id) ON DELETE CASCADE,
  provenance TEXT NOT NULL CHECK (
    provenance IN ('explicit', 'inherited', 'session_fallback')
  )
);

CREATE INDEX model_call_reasoning_settings_event_idx
  ON model_call_reasoning_settings(setting_event_id);

-- migrate:down
DROP INDEX model_call_reasoning_settings_event_idx;
DROP TABLE model_call_reasoning_settings;
DROP INDEX turn_reasoning_settings_event_idx;
DROP TABLE turn_reasoning_settings;
DROP INDEX reasoning_setting_events_value_idx;
DROP INDEX reasoning_setting_events_session_idx;
DROP TABLE reasoning_setting_events;
