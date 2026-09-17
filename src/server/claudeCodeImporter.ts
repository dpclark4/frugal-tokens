import { createHash } from "node:crypto";
import {
  type ClaudeCodeSessionCandidate,
  claudeCodeSourceArtifactMetadata,
  discoverClaudeCodeSessions,
  normalizeClaudeCodeSessionTree,
} from "./claudeCodeRepository.ts";
import {
  artifactImportFailure,
  type ProjectionCheckpoint,
  type SourceArtifactMetadata,
  type SourceArtifactProjectionRecord,
  SourceArtifactRepository,
  SourceIdentityConflictError,
} from "./sourceArtifactRepository.ts";
import type { LinearConversationImport } from "./conversationImportTypes.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

const parserVersion = "claude-code-conversation-family-4";
const projectionName = "conversation";
const sourceIdentityNamespace = "session";
const forkRelationship = "fork";

function externalID(
  candidate: ClaudeCodeSessionCandidate,
  artifactPath: string,
) {
  return artifactPath === candidate.artifactPath
    ? candidate.id
    : `${candidate.id}::${artifactPath}`;
}

function recordUnchangedTree(
  repository: SourceArtifactRepository,
  sourceID: number,
  candidate: ClaudeCodeSessionCandidate,
  observedAt: number,
  checkpoint?: ProjectionCheckpoint,
  projectionName = "conversation",
) {
  for (const dependency of candidate.dependencies) {
    if (!dependency.artifactPath.endsWith(".jsonl")) continue;
    repository.recordUnchangedArtifact(
      sourceID,
      externalID(candidate, dependency.artifactPath),
      dependency.artifactPath,
      observedAt,
      checkpoint,
      projectionName,
    );
  }
}

function dependencyHint(candidate: ClaudeCodeSessionCandidate) {
  return candidate.dependencies.map((dependency) =>
    `${dependency.artifactPath}\0${dependency.size}\0${dependency.updatedAt}`
  ).join("\n");
}

function fingerprint(
  candidate: ClaudeCodeSessionCandidate,
  snapshots: Map<string, Uint8Array>,
) {
  const hash = createHash("sha256");
  for (const dependency of candidate.dependencies) {
    hash.update(`${dependency.artifactPath}\0${dependency.size}\0`);
    hash.update(snapshots.get(dependency.path)!);
    hash.update(new Uint8Array([0]));
  }
  return hash.digest("hex");
}

function collectConnected<T>(seeds: T[], neighbors: Map<T, Set<T>>) {
  const visited = new Set<T>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    pending.push(...(neighbors.get(node) ?? []));
  }
  return visited;
}

function connectedArtifactFamilies(records: SourceArtifactProjectionRecord[]) {
  const byID = new Map(
    records.map((record) => [record.sourceArtifactID, record]),
  );
  const neighbors = new Map<number, Set<number>>(
    records.map((record) => [record.sourceArtifactID, new Set<number>()]),
  );
  for (const record of records) {
    if (
      record.parentSourceArtifactID === undefined ||
      !byID.has(record.parentSourceArtifactID)
    ) continue;
    neighbors.get(record.sourceArtifactID)!.add(record.parentSourceArtifactID);
    neighbors.get(record.parentSourceArtifactID)!.add(record.sourceArtifactID);
  }
  const visited = new Set<number>();
  return records.flatMap((record) => {
    if (visited.has(record.sourceArtifactID)) return [];
    const connected = collectConnected([record.sourceArtifactID], neighbors);
    for (const id of connected) visited.add(id);
    const family = [...connected].map((id) => byID.get(id)!);
    return [family.sort((a, b) => a.externalID.localeCompare(b.externalID))];
  });
}

function quarantineIdentityFamily(
  records: SourceArtifactProjectionRecord[],
  proposed: SourceArtifactMetadata[],
  conflict: SourceIdentityConflictError,
) {
  const neighbors = new Map<string, Set<string>>();
  const artifactNode = (id: string) => JSON.stringify(["artifact", id]);
  const identityNode = (namespace: string, value: string) =>
    JSON.stringify(["identity", namespace, value]);
  const link = (left: string, right: string) => {
    if (!neighbors.has(left)) neighbors.set(left, new Set());
    if (!neighbors.has(right)) neighbors.set(right, new Set());
    neighbors.get(left)!.add(right);
    neighbors.get(right)!.add(left);
  };
  // Include both stored and proposed edges: quarantined metadata remains stored,
  // and neither old nor new family members may project against ambiguous owners.
  for (const record of records) {
    const node = artifactNode(record.externalID);
    for (
      const identity of [record.sourceIdentity, record.parentSourceIdentity]
    ) {
      if (identity !== undefined) {
        link(node, identityNode(sourceIdentityNamespace, identity));
      }
    }
  }
  for (const value of proposed) {
    const node = artifactNode(value.externalID);
    for (const identity of value.identities) {
      link(node, identityNode(identity.namespace, identity.value));
    }
    for (const lineage of value.lineage) {
      link(
        node,
        identityNode(
          lineage.parentIdentityNamespace,
          lineage.parentIdentityValue,
        ),
      );
    }
  }
  const visited = collectConnected(
    conflict.artifacts.map((artifact) => artifactNode(artifact.externalID)),
    neighbors,
  );
  const quarantined = new Set<string>();
  for (
    const id of new Set([
      ...records.map((record) => record.externalID),
      ...proposed.map((value) => value.externalID),
    ])
  ) {
    if (visited.has(artifactNode(id))) quarantined.add(id);
  }
  return quarantined;
}

function storeMetadataWithQuarantine(
  repository: SourceArtifactRepository,
  sourceID: number,
  metadata: SourceArtifactMetadata[],
) {
  const quarantined = new Set<string>();
  const conflicts = new Map<string, SourceIdentityConflictError>();
  let pendingMetadata = metadata;
  let storedRecords: SourceArtifactProjectionRecord[] | undefined;
  while (pendingMetadata.length > 0) {
    try {
      repository.replaceSourceArtifactMetadata(sourceID, pendingMetadata);
      break;
    } catch (error) {
      if (!(error instanceof SourceIdentityConflictError)) throw error;
      storedRecords ??= repository.listSourceArtifactsForProjection(
        sourceID,
        projectionName,
        sourceIdentityNamespace,
        forkRelationship,
      );
      const previousSize = quarantined.size;
      const affected = quarantineIdentityFamily(storedRecords, metadata, error);
      for (const id of affected) {
        quarantined.add(id);
        conflicts.set(id, error);
      }
      if (quarantined.size === previousSize) throw error;
      pendingMetadata = metadata.filter((value) =>
        !quarantined.has(value.externalID)
      );
      console.warn(
        `[sync] harness=claude-code identity conflict; quarantined=${
          JSON.stringify([...affected])
        }`,
        error.message,
      );
    }
  }
  return { quarantined, conflicts };
}

function assertAcyclicArtifactLineage(
  family: SourceArtifactProjectionRecord[],
) {
  const byID = new Map(
    family.map((record) => [record.sourceArtifactID, record]),
  );
  for (const start of family) {
    const path = new Set<number>();
    let current: SourceArtifactProjectionRecord | undefined = start;
    while (current !== undefined) {
      if (path.has(current.sourceArtifactID)) {
        throw new Error(
          `Malformed source artifact ancestry cycle: ${start.externalID}`,
        );
      }
      path.add(current.sourceArtifactID);
      current = current.parentSourceArtifactID === undefined
        ? undefined
        : byID.get(current.parentSourceArtifactID);
    }
  }
}

async function familyDigest(
  family: SourceArtifactProjectionRecord[],
  parserVersion: string,
) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    parserVersion,
    artifacts: family.map((record) => ({
      externalID: record.externalID,
      checksum: record.checksum ?? null,
      parentSourceIdentity: record.parentSourceIdentity ?? null,
      availability: record.availability,
    })),
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readCandidateSnapshots(candidate: ClaudeCodeSessionCandidate) {
  const snapshots = new Map<string, Uint8Array>();
  for (const dependency of candidate.dependencies) {
    const bytes = Deno.readFileSync(dependency.path);
    const stat = Deno.statSync(dependency.path);
    if (
      stat.size !== dependency.size ||
      (stat.mtime?.getTime() ?? 0) !== dependency.updatedAt
    ) {
      throw new Error("Claude Code dependency changed while it was being read");
    }
    snapshots.set(dependency.path, bytes);
  }
  return snapshots;
}

export async function syncClaudeCodeSessions(
  directory: string,
  repository: SourceArtifactRepository,
  conversations: ConversationWriteRepository,
) {
  const observedAt = Date.now();
  const sourceID = repository.ensureSource(
    "claude-code",
    "directory",
    "Claude Code",
    directory,
  );
  const candidates = discoverClaudeCodeSessions(directory);
  const candidateByID = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  // The scan retains only checksums and lineage metadata. Transcript snapshots
  // and normalized values are reloaded for one affected family at a time.
  const observedChecksums = new Map<string, string>();
  const metadata: SourceArtifactMetadata[] = [];
  let imported = 0;
  let skipped = 0;
  const failedIDs = new Set<string>();

  const snapshot = (candidate: ClaudeCodeSessionCandidate) => {
    const snapshots = readCandidateSnapshots(candidate);
    const afterRead = discoverClaudeCodeSessions(directory).find((item) =>
      item.id === candidate.id
    );
    if (!afterRead || dependencyHint(afterRead) !== dependencyHint(candidate)) {
      throw new Error(
        "Claude Code dependency tree changed while it was being read",
      );
    }
    const checksum = fingerprint(candidate, snapshots);
    const checkpoint: ProjectionCheckpoint = {
      sourceSize: candidate.size,
      sourceModifiedAt: candidate.changeHint,
      checksum,
      parserVersion,
    };
    return { snapshots, checksum, checkpoint };
  };

  for (const candidate of candidates) {
    const previous = repository.projectionCheckpoint(
      sourceID,
      candidate.id,
      projectionName,
    );
    const physicalUnchanged = previous?.parserVersion === parserVersion &&
      previous.sourceSize === candidate.size &&
      previous.sourceModifiedAt === candidate.changeHint &&
      previous.lastError === undefined;
    if (physicalUnchanged) {
      recordUnchangedTree(repository, sourceID, candidate, observedAt);
      continue;
    }
    try {
      const captured = snapshot(candidate);
      observedChecksums.set(candidate.id, captured.checksum);
      for (const dependency of candidate.dependencies) {
        if (!dependency.artifactPath.endsWith(".jsonl")) continue;
        repository.recordUnchangedArtifact(
          sourceID,
          externalID(candidate, dependency.artifactPath),
          dependency.artifactPath,
          observedAt,
        );
      }
      const rootBytes = captured.snapshots.get(candidate.path)!;
      const sourceMetadata = claudeCodeSourceArtifactMetadata(
        new TextDecoder().decode(rootBytes),
      );
      const sourceIdentity = sourceMetadata.sourceIdentity ?? candidate.id;
      metadata.push({
        externalID: candidate.id,
        identities: [{
          namespace: sourceIdentityNamespace,
          value: sourceIdentity,
        }],
        lineage: sourceMetadata.parentSourceIdentity === undefined ? [] : [{
          relationship: forkRelationship,
          parentIdentityNamespace: sourceIdentityNamespace,
          parentIdentityValue: sourceMetadata.parentSourceIdentity,
          provenance: "preserved-source-session-id",
        }],
      });
      recordUnchangedTree(
        repository,
        sourceID,
        candidate,
        observedAt,
        captured.checkpoint,
        projectionName,
      );
    } catch (error) {
      const failure = artifactImportFailure(error);
      console.warn(
        `[sync] harness=claude-code source=${candidate.path} failed`,
        error,
      );
      repository.recordArtifactError(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        failure,
        projectionName,
      );
      failedIDs.add(candidate.id);
    }
  }

  repository.markMissingArtifacts(sourceID, observedAt);
  try {
    const { quarantined, conflicts } = storeMetadataWithQuarantine(
      repository,
      sourceID,
      metadata,
    );
    for (const [id, conflict] of conflicts) {
      repository.recordProjectionError(
        sourceID,
        id,
        projectionName,
        artifactImportFailure(conflict),
      );
      if (candidateByID.has(id)) failedIDs.add(id);
    }
    const records = repository.listSourceArtifactsForProjection(
      sourceID,
      projectionName,
      sourceIdentityNamespace,
      forkRelationship,
    ).filter((record) =>
      record.sourceIdentity !== undefined &&
      !quarantined.has(record.externalID) &&
      !failedIDs.has(record.externalID)
    );
    for (const family of connectedArtifactFamilies(records)) {
      const available = family.filter((record) =>
        record.availability === "available" &&
        candidateByID.has(record.externalID)
      );
      try {
        assertAcyclicArtifactLineage(family);
        const dependencyDigest = await familyDigest(family, parserVersion);
        const current = family.every((record) =>
          record.parserVersion === parserVersion &&
          record.dependencyDigest === dependencyDigest &&
          record.lastError === undefined
        );
        if (current) {
          skipped += available.length;
          continue;
        }
        if (family.some((record) => record.availability === "missing")) {
          for (const record of family) {
            repository.recordProjectionCheckpoint(
              sourceID,
              record.externalID,
              projectionName,
              { parserVersion, checksum: record.checksum, dependencyDigest },
            );
          }
          skipped += available.length;
          continue;
        }

        const artifacts = [];
        const subagents: LinearConversationImport[] = [];
        for (const record of available) {
          const candidate = candidateByID.get(record.externalID)!;
          const captured = snapshot(candidate);
          const expectedChecksum = observedChecksums.get(record.externalID) ??
            record.checksum;
          if (
            expectedChecksum !== undefined &&
            captured.checksum !== expectedChecksum
          ) {
            throw new Error(
              "Claude Code dependency tree changed while it was being read",
            );
          }
          const values = normalizeClaudeCodeSessionTree({
            candidate,
            snapshots: captured.snapshots,
            sourceID,
            observedAt,
            checkpoint: captured.checkpoint,
          });
          const value = values.find((item) => item.externalID === candidate.id);
          if (value === undefined) {
            throw new Error(`Missing Claude Code root import: ${candidate.id}`);
          }
          subagents.push(
            ...values.filter((item) => item.externalID !== candidate.id),
          );
          artifacts.push({
            externalID: candidate.id,
            sourceIdentity: record.sourceIdentity,
            parentSourceIdentity: record.parentSourceIdentity,
            value,
            checkpoint: captured.checkpoint,
          });
        }
        const root = artifacts.find((artifact) =>
          artifact.parentSourceIdentity === undefined ||
          !family.some((record) =>
            record.sourceIdentity === artifact.parentSourceIdentity
          )
        ) ?? artifacts[0];
        conversations.replaceConversationFamily({
          sourceID,
          externalID: root.sourceIdentity ?? root.externalID,
          artifacts,
          subagents,
        });
        for (const artifact of artifacts) {
          repository.recordProjectionCheckpoint(
            sourceID,
            artifact.externalID,
            projectionName,
            { ...artifact.checkpoint, dependencyDigest },
          );
        }
        imported += available.length;
      } catch (error) {
        const failure = artifactImportFailure(error);
        console.warn(
          `[sync] harness=claude-code projection=${projectionName} family failed`,
          error,
        );
        for (const record of available) {
          repository.recordProjectionError(
            sourceID,
            record.externalID,
            projectionName,
            failure,
          );
        }
        for (const record of available) failedIDs.add(record.externalID);
      }
    }
  } catch (error) {
    const failure = artifactImportFailure(error);
    console.warn(
      `[sync] harness=claude-code projection=${projectionName} metadata failed`,
      error,
    );
    for (const candidate of candidates) {
      repository.recordProjectionError(
        sourceID,
        candidate.id,
        projectionName,
        failure,
      );
    }
    for (const candidate of candidates) failedIDs.add(candidate.id);
  }
  return {
    discovered: candidates.length,
    imported,
    skipped,
    failed: failedIDs.size,
  };
}
