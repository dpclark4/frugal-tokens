-- migrate:up
CREATE TABLE source_artifact_identities (
  source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  identity_namespace TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  PRIMARY KEY (source_session_id, identity_namespace),
  UNIQUE (source_id, identity_namespace, identity_value)
);

CREATE TABLE source_artifact_lineage (
  child_source_session_id INTEGER NOT NULL REFERENCES source_sessions(id) ON DELETE CASCADE,
  relationship_kind TEXT NOT NULL,
  parent_identity_namespace TEXT NOT NULL,
  parent_identity_value TEXT NOT NULL,
  parent_source_session_id INTEGER REFERENCES source_sessions(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (child_source_session_id, relationship_kind),
  CHECK (child_source_session_id <> parent_source_session_id)
);

CREATE INDEX source_artifact_lineage_parent_idx
  ON source_artifact_lineage(parent_source_session_id);

-- migrate:down
DROP TABLE source_artifact_lineage;
DROP TABLE source_artifact_identities;
