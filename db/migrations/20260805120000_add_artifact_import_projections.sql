-- migrate:up
CREATE TABLE artifact_import_projections (
  source_session_id INTEGER NOT NULL
    REFERENCES source_sessions(id) ON DELETE CASCADE,
  projection_name TEXT NOT NULL,
  parser_version TEXT,
  source_checksum TEXT,
  source_change_hint TEXT,
  dependency_digest TEXT,
  imported_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (source_session_id, projection_name)
);

INSERT INTO artifact_import_projections (
  source_session_id, projection_name, parser_version, source_checksum,
  source_change_hint, imported_at, last_error
)
SELECT id, 'legacy', parser_version, checksum, change_hint, imported_at,
  last_error
FROM source_sessions
WHERE parser_version IS NOT NULL OR checksum IS NOT NULL OR
  change_hint IS NOT NULL OR imported_at IS NOT NULL OR last_error IS NOT NULL;

-- migrate:down
DROP TABLE artifact_import_projections;
