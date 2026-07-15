-- migrate:up
ALTER TABLE source_sessions ADD COLUMN change_hint TEXT;

-- migrate:down
ALTER TABLE source_sessions DROP COLUMN change_hint;
