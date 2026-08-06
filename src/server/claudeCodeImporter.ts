import {
  claudeCodeSourceArtifactMetadata,
  type ClaudeCodeSessionCandidate,
  discoverClaudeCodeSessions,
  normalizeClaudeCodeSessionTree,
} from "./claudeCodeRepository.ts";
import {
  SessionRepository,
  type SourceArtifactMetadata,
  type SourceArtifactProjectionRecord,
  type SourceSessionCheckpoint,
  type SourceSessionImport,
} from "./sessionRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";

const legacyParserVersion = "claude-code-5";
const conversationParserVersion = "claude-code-conversation-v2-family-1";
const conversationProjectionName = "conversation-v2";
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
  repository: SessionRepository,
  sourceID: number,
  candidate: ClaudeCodeSessionCandidate,
  observedAt: number,
  checkpoint?: SourceSessionCheckpoint,
  projectionName = "legacy",
) {
  for (const dependency of candidate.dependencies) {
    if (!dependency.artifactPath.endsWith(".jsonl")) continue;
    repository.recordUnchangedSourceSession(
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

async function fingerprint(
  candidate: ClaudeCodeSessionCandidate,
  snapshots: Map<string, Uint8Array>,
) {
  const encoder = new TextEncoder();
  const chunks = candidate.dependencies.flatMap((dependency) => [
    encoder.encode(`${dependency.artifactPath}\0${dependency.size}\0`),
    snapshots.get(dependency.path)!,
    new Uint8Array([0]),
  ]);
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const value = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function currentProjection(
  checkpoint: SourceSessionCheckpoint | undefined,
  parserVersion: string,
  checksum: string,
) {
  return checkpoint?.parserVersion === parserVersion &&
    checkpoint.checksum === checksum && checkpoint.lastError === undefined;
}

function connectedArtifactFamilies(records: SourceArtifactProjectionRecord[]) {
  const byID = new Map(records.map((record) => [record.sourceSessionID, record]));
  const neighbors = new Map<number, Set<number>>(
    records.map((record) => [record.sourceSessionID, new Set<number>()]),
  );
  for (const record of records) {
    if (record.parentSourceSessionID === undefined ||
      !byID.has(record.parentSourceSessionID)) continue;
    neighbors.get(record.sourceSessionID)!.add(record.parentSourceSessionID);
    neighbors.get(record.parentSourceSessionID)!.add(record.sourceSessionID);
  }
  const visited = new Set<number>();
  return records.flatMap((record) => {
    if (visited.has(record.sourceSessionID)) return [];
    const family: SourceArtifactProjectionRecord[] = [];
    const pending = [record.sourceSessionID];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      family.push(byID.get(id)!);
      pending.push(...neighbors.get(id)!);
    }
    return [family.sort((a, b) => a.externalID.localeCompare(b.externalID))];
  });
}

function assertAcyclicArtifactLineage(family: SourceArtifactProjectionRecord[]) {
  const byID = new Map(family.map((record) => [record.sourceSessionID, record]));
  for (const start of family) {
    const path = new Set<number>();
    let current: SourceArtifactProjectionRecord | undefined = start;
    while (current !== undefined) {
      if (path.has(current.sourceSessionID)) {
        throw new Error(`Malformed source artifact ancestry cycle: ${start.externalID}`);
      }
      path.add(current.sourceSessionID);
      current = current.parentSourceSessionID === undefined
        ? undefined
        : byID.get(current.parentSourceSessionID);
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
  repository: SessionRepository,
  conversations?: ConversationProjectionRepository,
) {
  const observedAt = Date.now();
  const sourceID = repository.ensureSource(
    "claude-code",
    "directory",
    "Claude Code",
    directory,
  );
  const candidates = discoverClaudeCodeSessions(directory);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const v2 = { imported: 0, skipped: 0, failed: 0 };
  const v2Metadata: SourceArtifactMetadata[] = [];

  for (const candidate of candidates) {
    const previous = repository.checkpoint(sourceID, candidate.id);
    const previousV2 = conversations === undefined
      ? undefined
      : repository.checkpoint(
        sourceID,
        candidate.id,
        conversationProjectionName,
      );
    const physicalUnchanged = previous?.parserVersion === legacyParserVersion &&
      previous.sourceSize === candidate.size &&
      previous.sourceModifiedAt === candidate.changeHint &&
      previous.lastError === undefined &&
      (conversations === undefined ||
        (previousV2?.parserVersion === conversationParserVersion &&
          previousV2.sourceSize === candidate.size &&
          previousV2.sourceModifiedAt === candidate.changeHint &&
          previousV2.lastError === undefined));
    if (physicalUnchanged) {
      recordUnchangedTree(repository, sourceID, candidate, observedAt);
      skipped++;
      continue;
    }

    try {
      const snapshots = readCandidateSnapshots(candidate);
      const afterRead = discoverClaudeCodeSessions(directory).find((item) =>
        item.id === candidate.id
      );
      if (
        !afterRead || dependencyHint(afterRead) !== dependencyHint(candidate)
      ) {
        throw new Error(
          "Claude Code dependency tree changed while it was being read",
        );
      }
      const checksum = await fingerprint(candidate, snapshots);
      const legacyCheckpoint: SourceSessionCheckpoint = {
        sourceSize: candidate.size,
        sourceModifiedAt: candidate.changeHint,
        checksum,
        parserVersion: legacyParserVersion,
      };
      let normalized: SourceSessionImport[] | undefined;
      const normalize = (checkpoint: SourceSessionCheckpoint) =>
        normalized ??= normalizeClaudeCodeSessionTree({
          candidate,
          snapshots,
          sourceID,
          observedAt,
          checkpoint,
        });

      if (currentProjection(previous, legacyParserVersion, checksum)) {
        recordUnchangedTree(
          repository,
          sourceID,
          candidate,
          observedAt,
          legacyCheckpoint,
        );
        skipped++;
      } else {
        try {
          repository.replaceSourceSessionTree(normalize(legacyCheckpoint));
          imported++;
        } catch (error) {
          console.warn(
            `[sync] harness=claude-code source=${candidate.path} projection=legacy failed`,
            error,
          );
          repository.recordSourceSessionError(
            sourceID,
            candidate.id,
            candidate.artifactPath,
            observedAt,
            error,
          );
          failed++;
        }
      }

      if (conversations !== undefined) {
        if (
          currentProjection(previousV2, conversationParserVersion, checksum)
        ) {
          // Family checkpoints are counted after all source lineage is known.
        } else {
          const v2Checkpoint: SourceSessionCheckpoint = {
            sourceSize: candidate.size,
            sourceModifiedAt: candidate.changeHint,
            checksum,
            parserVersion: conversationParserVersion,
          };
          try {
            conversations.replaceLinearSessionTree(normalize(v2Checkpoint));
            recordUnchangedTree(
              repository,
              sourceID,
              candidate,
              observedAt,
              v2Checkpoint,
              conversationProjectionName,
            );
          } catch (error) {
            console.warn(
              `[sync] harness=claude-code source=${candidate.path} projection=${conversationProjectionName} failed`,
              error,
            );
            repository.recordProjectionError(
              sourceID,
              candidate.id,
              conversationProjectionName,
              error,
            );
            v2.failed++;
          }
        }
        try {
          const metadata = claudeCodeSourceArtifactMetadata(
            new TextDecoder().decode(snapshots.get(candidate.path)!),
          );
          const sourceIdentity = metadata.sourceIdentity ?? candidate.id;
          v2Metadata.push({
            externalID: candidate.id,
            identities: [{
              namespace: sourceIdentityNamespace,
              value: sourceIdentity,
            }],
            lineage: metadata.parentSourceIdentity === undefined ? [] : [{
              relationship: forkRelationship,
              parentIdentityNamespace: sourceIdentityNamespace,
              parentIdentityValue: metadata.parentSourceIdentity,
              provenance: "preserved-source-session-id",
            }],
          });
        } catch (error) {
          repository.recordProjectionError(
            sourceID,
            candidate.id,
            conversationProjectionName,
            error,
          );
          v2.failed++;
        }
      }
    } catch (error) {
      console.warn(
        `[sync] harness=claude-code source=${candidate.path} failed`,
        error,
      );
      repository.recordSourceSessionError(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        error,
      );
      failed++;
      if (conversations !== undefined) {
        repository.recordProjectionError(
          sourceID,
          candidate.id,
          conversationProjectionName,
          error,
        );
        v2.failed++;
      }
    }
  }

  repository.markMissingSourceSessions(sourceID, observedAt);
  if (conversations !== undefined) {
    try {
      if (v2Metadata.length > 0) {
        repository.replaceSourceArtifactMetadata(sourceID, v2Metadata);
      }
      const candidateByID = new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
      );
      const records = repository.listSourceArtifactsForProjection(
        sourceID,
        conversationProjectionName,
        sourceIdentityNamespace,
        forkRelationship,
      ).filter((record) => record.sourceIdentity !== undefined);
      for (const family of connectedArtifactFamilies(records)) {
        const available = family.filter((record) =>
          record.availability === "available" && candidateByID.has(record.externalID)
        );
        try {
          assertAcyclicArtifactLineage(family);
          const dependencyDigest = await familyDigest(
            family,
            conversationParserVersion,
          );
          const current = family.every((record) =>
            record.parserVersion === conversationParserVersion &&
            record.dependencyDigest === dependencyDigest &&
            record.lastError === undefined
          );
          if (current) {
            v2.skipped += available.length;
            continue;
          }
          if (family.some((record) => record.availability === "missing")) {
            for (const record of family) {
              repository.recordProjectionCheckpoint(
                sourceID,
                record.externalID,
                conversationProjectionName,
                {
                  parserVersion: conversationParserVersion,
                  checksum: record.checksum,
                  dependencyDigest,
                },
              );
            }
            v2.skipped += available.length;
            continue;
          }

          const artifacts = [];
          const subagents: SourceSessionImport[] = [];
          for (const record of available) {
            const candidate = candidateByID.get(record.externalID)!;
            const snapshots = readCandidateSnapshots(candidate);
            const checksum = await fingerprint(candidate, snapshots);
            const checkpoint: SourceSessionCheckpoint = {
              sourceSize: candidate.size,
              sourceModifiedAt: candidate.changeHint,
              checksum,
              parserVersion: conversationParserVersion,
            };
            const values = normalizeClaudeCodeSessionTree({
              candidate,
              snapshots,
              sourceID,
              observedAt,
              checkpoint,
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
              checkpoint,
            });
          }
          const root = artifacts.find((artifact) =>
            artifact.parentSourceIdentity === undefined ||
            !family.some((record) =>
              record.sourceIdentity === artifact.parentSourceIdentity
            )
          ) ?? artifacts[0];
          conversations.replaceArtifactFamily({
            sourceID,
            externalID: root.sourceIdentity ?? root.externalID,
            artifacts,
            subagents,
          });
          for (const artifact of artifacts) {
            repository.recordProjectionCheckpoint(
              sourceID,
              artifact.externalID,
              conversationProjectionName,
              {
                ...artifact.checkpoint,
                dependencyDigest,
              },
            );
          }
          v2.imported += available.length;
        } catch (error) {
          console.warn(
            `[sync] harness=claude-code projection=${conversationProjectionName} family failed`,
            error,
          );
          for (const record of available) {
            repository.recordProjectionError(
              sourceID,
              record.externalID,
              conversationProjectionName,
              error,
            );
          }
          v2.failed += available.length;
        }
      }
    } catch (error) {
      console.warn(
        `[sync] harness=claude-code projection=${conversationProjectionName} metadata failed`,
        error,
      );
      for (const candidate of candidates) {
        repository.recordProjectionError(
          sourceID,
          candidate.id,
          conversationProjectionName,
          error,
        );
      }
      v2.failed += candidates.length;
    }
  }
  return {
    discovered: candidates.length,
    imported,
    skipped,
    failed,
    projectionResults: {
      legacy: { imported, skipped, failed },
      ...(conversations === undefined
        ? {}
        : { [conversationProjectionName]: v2 }),
    },
  };
}
