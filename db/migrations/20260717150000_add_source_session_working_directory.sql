-- migrate:up
ALTER TABLE source_sessions ADD COLUMN working_directory TEXT;

-- migrate:down
ALTER TABLE source_sessions DROP COLUMN working_directory;
