import type { DatabaseSync } from "node:sqlite";
import type { SessionSummary } from "../shared/sessionSchemas.ts";

type Harness = SessionSummary["harness"];

export type ProjectionCheckpoint = {
  changeHint?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  checksum?: string;
  parserVersion?: string;
  dependencyDigest?: string;
  importedAt?: number;
  lastError?: string;
};

export type SourceArtifactMetadata = {
  externalID: string;
  identities: Array<{ namespace: string; value: string }>;
  lineage: Array<{
    relationship: string;
    parentIdentityNamespace: string;
    parentIdentityValue: string;
    provenance: string;
  }>;
};

export type SourceArtifactProjectionRecord = {
  sourceArtifactID: number;
  externalID: string;
  artifactPath?: string;
  availability: "available" | "missing";
  sourceIdentity?: string;
  parentSourceIdentity?: string;
  parentSourceArtifactID?: number;
  sourceSize?: number;
  sourceModifiedAt?: number;
  checksum?: string;
  parserVersion?: string;
  dependencyDigest?: string;
  lastError?: string;
};

export type ArtifactImportFailure = {
  name?: string;
  message: string;
};

export function artifactImportFailure(cause: unknown): ArtifactImportFailure {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { message: String(cause) };
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export class SourceArtifactRepository {
  #statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(private db: DatabaseSync) {}

  #prepare(sql: string) {
    const existing = this.#statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  ensureSource(
    harness: Harness,
    kind: string,
    label: string,
    location: string,
  ) {
    return Number(
      (this.#prepare(`
      INSERT INTO sources (harness, kind, label, location, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (harness, location) DO UPDATE SET
        kind = excluded.kind, label = excluded.label, enabled = 1
      RETURNING id
    `).get(harness, kind, label, location, Date.now()) as { id: number }).id,
    );
  }

  projectionCheckpoint(
    sourceID: number,
    externalID: string,
    projectionName = "conversation",
  ): ProjectionCheckpoint | undefined {
    const row = this.#prepare(`
      SELECT ss.source_size, ss.source_modified_at, aip.source_checksum,
        aip.source_change_hint, aip.parser_version, aip.dependency_digest,
        aip.imported_at, aip.last_error
      FROM source_sessions ss
      LEFT JOIN artifact_import_projections aip
        ON aip.source_session_id = ss.id AND aip.projection_name = ?
      WHERE ss.source_id = ? AND ss.external_id = ?
    `).get(projectionName, sourceID, externalID) as {
      source_size: number | null;
      source_modified_at: number | null;
      source_checksum: string | null;
      source_change_hint: string | null;
      parser_version: string | null;
      dependency_digest: string | null;
      imported_at: number | null;
      last_error: string | null;
    } | undefined;
    return row && {
      changeHint: optional(row.source_change_hint),
      sourceSize: optional(row.source_size),
      sourceModifiedAt: optional(row.source_modified_at),
      checksum: optional(row.source_checksum),
      parserVersion: optional(row.parser_version),
      dependencyDigest: optional(row.dependency_digest),
      importedAt: optional(row.imported_at),
      lastError: optional(row.last_error),
    };
  }

  recordProjectionCheckpoint(
    sourceID: number,
    externalID: string,
    projectionName: string,
    checkpoint: ProjectionCheckpoint,
  ) {
    this.#upsertProjectionCheckpoint(
      this.#sourceArtifactID(sourceID, externalID),
      projectionName,
      checkpoint,
      true,
    );
  }

  recordProjectionError(
    sourceID: number,
    externalID: string,
    projectionName: string,
    failure: ArtifactImportFailure,
  ) {
    this.#prepare(`
      INSERT INTO artifact_import_projections (
        source_session_id, projection_name, last_error
      ) VALUES (?, ?, ?)
      ON CONFLICT (source_session_id, projection_name) DO UPDATE SET
        last_error = excluded.last_error
    `).run(
      this.#sourceArtifactID(sourceID, externalID),
      projectionName,
      failure.message,
    );
  }

  recordUnchangedArtifact(
    sourceID: number,
    externalID: string,
    artifactPath: string,
    observedAt: number,
    checkpoint?: ProjectionCheckpoint,
    projectionName = "conversation",
  ) {
    this.#prepare(`
      INSERT INTO source_sessions (
        source_id, external_id, artifact_path, availability,
        source_size, source_modified_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, 'available', ?, ?, ?, ?)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        artifact_path = excluded.artifact_path,
        availability = 'available',
        source_size = COALESCE(excluded.source_size, source_sessions.source_size),
        source_modified_at = COALESCE(
          excluded.source_modified_at, source_sessions.source_modified_at
        ),
        last_seen_at = excluded.last_seen_at
    `).run(
      sourceID,
      externalID,
      artifactPath,
      checkpoint?.sourceSize ?? null,
      checkpoint?.sourceModifiedAt ?? null,
      observedAt,
      observedAt,
    );
    if (checkpoint !== undefined) {
      this.#upsertProjectionCheckpoint(
        this.#sourceArtifactID(sourceID, externalID),
        projectionName,
        checkpoint,
        false,
      );
    }
  }

  recordArtifactError(
    sourceID: number,
    externalID: string,
    artifactPath: string,
    observedAt: number,
    failure: ArtifactImportFailure,
    projectionName = "conversation",
  ) {
    this.recordUnchangedArtifact(
      sourceID,
      externalID,
      artifactPath,
      observedAt,
    );
    this.recordProjectionError(sourceID, externalID, projectionName, failure);
  }

  markArtifactsSeen(
    sourceID: number,
    externalIDs: string[],
    observedAt: number,
  ) {
    if (externalIDs.length === 0) return;
    this.#prepare(`
      UPDATE source_sessions SET availability = 'available', last_seen_at = ?
      WHERE source_id = ? AND external_id IN (${
      externalIDs.map(() => "?").join(", ")
    })
    `).run(observedAt, sourceID, ...externalIDs);
  }

  markMissingArtifacts(sourceID: number, observedAt: number) {
    this.#prepare(`
      UPDATE source_sessions SET availability = 'missing'
      WHERE source_id = ? AND last_seen_at <> ?
    `).run(sourceID, observedAt);
  }

  replaceSourceArtifactMetadata(
    sourceID: number,
    values: SourceArtifactMetadata[],
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const value of values) {
        const sourceArtifactID = this.#sourceArtifactID(
          sourceID,
          value.externalID,
        );
        this.#prepare(
          "DELETE FROM source_artifact_lineage WHERE child_source_session_id = ?",
        ).run(sourceArtifactID);
        this.#prepare(
          "DELETE FROM source_artifact_identities WHERE source_session_id = ?",
        ).run(sourceArtifactID);
        for (const identity of value.identities) {
          this.#prepare(`
            INSERT INTO source_artifact_identities (
              source_session_id, source_id, identity_namespace, identity_value
            ) VALUES (?, ?, ?, ?)
          `).run(
            sourceArtifactID,
            sourceID,
            identity.namespace,
            identity.value,
          );
        }
        for (const lineage of value.lineage) {
          this.#prepare(`
            INSERT INTO source_artifact_lineage (
              child_source_session_id, relationship_kind,
              parent_identity_namespace, parent_identity_value, provenance
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            sourceArtifactID,
            lineage.relationship,
            lineage.parentIdentityNamespace,
            lineage.parentIdentityValue,
            lineage.provenance,
          );
        }
      }
      this.#prepare(`
        UPDATE source_artifact_lineage AS lineage
        SET parent_source_session_id = (
          SELECT identity.source_session_id
          FROM source_artifact_identities AS identity
          JOIN source_sessions AS parent ON parent.id = identity.source_session_id
          JOIN source_sessions AS child ON child.id = lineage.child_source_session_id
          WHERE identity.source_id = ?
            AND identity.identity_namespace = lineage.parent_identity_namespace
            AND identity.identity_value = lineage.parent_identity_value
            AND parent.source_id = child.source_id
        )
        WHERE lineage.child_source_session_id IN (
          SELECT id FROM source_sessions WHERE source_id = ?
        )
      `).run(sourceID, sourceID);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSourceArtifactsForProjection(
    sourceID: number,
    projectionName: string,
    identityNamespace: string,
    relationship: string,
  ): SourceArtifactProjectionRecord[] {
    const rows = this.#prepare(`
      SELECT ss.id AS source_session_id, ss.external_id, ss.artifact_path,
        ss.availability, ss.source_size, ss.source_modified_at,
        identity.identity_value AS source_identity,
        lineage.parent_identity_value AS parent_source_identity,
        lineage.parent_source_session_id, aip.source_checksum,
        aip.parser_version, aip.dependency_digest, aip.last_error
      FROM source_sessions AS ss
      LEFT JOIN source_artifact_identities AS identity
        ON identity.source_session_id = ss.id AND identity.identity_namespace = ?
      LEFT JOIN source_artifact_lineage AS lineage
        ON lineage.child_source_session_id = ss.id
        AND lineage.relationship_kind = ?
        AND lineage.parent_identity_namespace = ?
      LEFT JOIN artifact_import_projections AS aip
        ON aip.source_session_id = ss.id AND aip.projection_name = ?
      WHERE ss.source_id = ?
      ORDER BY ss.external_id
    `).all(
      identityNamespace,
      relationship,
      identityNamespace,
      projectionName,
      sourceID,
    ) as Array<{
      source_session_id: number;
      external_id: string;
      artifact_path: string | null;
      availability: "available" | "missing";
      source_size: number | null;
      source_modified_at: number | null;
      source_identity: string | null;
      parent_source_identity: string | null;
      parent_source_session_id: number | null;
      source_checksum: string | null;
      parser_version: string | null;
      dependency_digest: string | null;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      sourceArtifactID: Number(row.source_session_id),
      externalID: row.external_id,
      artifactPath: optional(row.artifact_path),
      availability: row.availability,
      sourceIdentity: optional(row.source_identity),
      parentSourceIdentity: optional(row.parent_source_identity),
      parentSourceArtifactID: optional(row.parent_source_session_id),
      sourceSize: optional(row.source_size),
      sourceModifiedAt: optional(row.source_modified_at),
      checksum: optional(row.source_checksum),
      parserVersion: optional(row.parser_version),
      dependencyDigest: optional(row.dependency_digest),
      lastError: optional(row.last_error),
    }));
  }

  #upsertProjectionCheckpoint(
    sourceArtifactID: number,
    projectionName: string,
    checkpoint: ProjectionCheckpoint,
    markImported: boolean,
  ) {
    this.#prepare(`
      INSERT INTO artifact_import_projections (
        source_session_id, projection_name, parser_version, source_checksum,
        source_change_hint, dependency_digest, imported_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (source_session_id, projection_name) DO UPDATE SET
        parser_version = excluded.parser_version,
        source_checksum = excluded.source_checksum,
        source_change_hint = excluded.source_change_hint,
        dependency_digest = excluded.dependency_digest,
        imported_at = CASE WHEN ? THEN excluded.imported_at
          ELSE artifact_import_projections.imported_at END,
        last_error = NULL
    `).run(
      sourceArtifactID,
      projectionName,
      checkpoint.parserVersion ?? null,
      checkpoint.checksum ?? null,
      checkpoint.changeHint ?? null,
      checkpoint.dependencyDigest ?? null,
      checkpoint.importedAt ?? (markImported ? Date.now() : null),
      Number(markImported),
    );
  }

  #sourceArtifactID(sourceID: number, externalID: string) {
    const row = this.#prepare(`
      SELECT id FROM source_sessions WHERE source_id = ? AND external_id = ?
    `).get(sourceID, externalID) as { id: number } | undefined;
    if (row === undefined) {
      throw new Error(`Unknown source artifact: ${externalID}`);
    }
    return Number(row.id);
  }
}
