-- migrate:up
ALTER TABLE conversation_entries
  ADD COLUMN turn_id INTEGER REFERENCES conversation_turns(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN agent TEXT;
ALTER TABLE conversations ADD COLUMN public_id TEXT;
ALTER TABLE conversation_entries ADD COLUMN content_kind TEXT;

CREATE INDEX conversation_entries_turn_idx ON conversation_entries(turn_id);

-- migrate:down
DROP INDEX conversation_entries_turn_idx;
ALTER TABLE conversation_entries DROP COLUMN turn_id;
ALTER TABLE conversations DROP COLUMN agent;
ALTER TABLE conversations DROP COLUMN public_id;
ALTER TABLE conversation_entries DROP COLUMN content_kind;
