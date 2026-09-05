-- migrate:up
CREATE INDEX conversation_branches_title_idx
  ON conversation_branches(conversation_id, updated_at DESC, id DESC, source_session_id);

-- migrate:down
DROP INDEX conversation_branches_title_idx;
