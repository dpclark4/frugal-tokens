-- migrate:up
ALTER TABLE conversation_cache_misses
  ADD COLUMN root_conversation_id INTEGER REFERENCES conversations(id)
  ON DELETE CASCADE;

WITH RECURSIVE tree(conversation_id, root_id) AS (
  SELECT c.id, c.id
  FROM conversations c
  WHERE NOT EXISTS (
    SELECT 1 FROM conversation_subagent_launches launch
    WHERE launch.child_conversation_id = c.id
  )
  UNION ALL
  SELECT launch.child_conversation_id, tree.root_id
  FROM conversation_subagent_launches launch
  JOIN tree ON tree.conversation_id = launch.parent_conversation_id
)
UPDATE conversation_cache_misses AS miss
SET root_conversation_id = (
  SELECT tree.root_id
  FROM tree
  WHERE tree.conversation_id = miss.conversation_id
);

CREATE INDEX conversation_cache_misses_root_started_idx
  ON conversation_cache_misses(root_conversation_id, started_at);

-- migrate:down
DROP INDEX conversation_cache_misses_root_started_idx;
ALTER TABLE conversation_cache_misses DROP COLUMN root_conversation_id;
