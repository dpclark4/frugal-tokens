-- migrate:up
ALTER TABLE source_sessions ADD COLUMN public_id TEXT;
UPDATE source_sessions SET public_id = external_id;

ALTER TABLE source_sessions ADD COLUMN tree_root_id INTEGER
  REFERENCES source_sessions(id) ON DELETE CASCADE;

WITH RECURSIVE source_session_trees(id, root_id) AS (
  SELECT id, id FROM source_sessions WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, source_session_trees.root_id
  FROM source_sessions child
  JOIN source_session_trees ON child.parent_id = source_session_trees.id
)
UPDATE source_sessions
SET tree_root_id = (
  SELECT root_id FROM source_session_trees WHERE source_session_trees.id = source_sessions.id
);

CREATE INDEX source_sessions_tree_root_idx ON source_sessions(tree_root_id);

-- migrate:down
DROP INDEX source_sessions_tree_root_idx;
ALTER TABLE source_sessions DROP COLUMN tree_root_id;
ALTER TABLE source_sessions DROP COLUMN public_id;
