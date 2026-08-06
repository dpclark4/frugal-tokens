-- migrate:up
CREATE INDEX conversation_entries_conversation_kind_idx
  ON conversation_entries(conversation_id, kind, id);
CREATE INDEX conversation_subagent_launches_child_idx
  ON conversation_subagent_launches(child_conversation_id);

-- migrate:down
DROP INDEX conversation_subagent_launches_child_idx;
DROP INDEX conversation_entries_conversation_kind_idx;
