-- migrate:up
-- If a partially upgraded environment contains both labels, retain the newer
-- successful checkpoint before removing the duplicate label.
UPDATE artifact_import_projections AS current
SET parser_version = old.parser_version,
  source_checksum = old.source_checksum,
  source_change_hint = old.source_change_hint,
  dependency_digest = old.dependency_digest,
  imported_at = old.imported_at,
  last_error = old.last_error
FROM artifact_import_projections AS old
WHERE current.source_session_id = old.source_session_id
  AND current.projection_name = 'conversation'
  AND old.projection_name = 'conversation-v2'
  AND (
    COALESCE(old.imported_at, -1) > COALESCE(current.imported_at, -1)
    OR (current.last_error IS NOT NULL AND old.last_error IS NULL)
  );

DELETE FROM artifact_import_projections AS old
WHERE old.projection_name = 'conversation-v2'
  AND EXISTS (
    SELECT 1 FROM artifact_import_projections AS current
    WHERE current.source_session_id = old.source_session_id
      AND current.projection_name = 'conversation'
  );

UPDATE artifact_import_projections
SET projection_name = 'conversation'
WHERE projection_name = 'conversation-v2';

DELETE FROM artifact_import_projections
WHERE projection_name = 'legacy';

-- migrate:down
UPDATE artifact_import_projections
SET projection_name = 'conversation-v2'
WHERE projection_name = 'conversation';
