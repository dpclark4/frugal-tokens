import {
  type ClaudeCodeSessionCandidate,
  discoverClaudeCodeSessions,
  normalizeClaudeCodeSessionTree,
} from "./claudeCodeRepository.ts";
import {
  SessionRepository,
  type SourceSessionCheckpoint,
  type SourceSessionImport,
} from "./sessionRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";

const legacyParserVersion = "claude-code-5";
const conversationParserVersion = "claude-code-conversation-v2-4";
const conversationProjectionName = "conversation-v2";

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
      if (conversations !== undefined) v2.skipped++;
      continue;
    }

    try {
      const snapshots = new Map<string, Uint8Array>();
      for (const dependency of candidate.dependencies) {
        const bytes = Deno.readFileSync(dependency.path);
        const stat = Deno.statSync(dependency.path);
        if (
          stat.size !== dependency.size ||
          (stat.mtime?.getTime() ?? 0) !== dependency.updatedAt
        ) {
          throw new Error(
            "Claude Code dependency changed while it was being read",
          );
        }
        snapshots.set(dependency.path, bytes);
      }
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
          v2.skipped++;
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
            v2.imported++;
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
