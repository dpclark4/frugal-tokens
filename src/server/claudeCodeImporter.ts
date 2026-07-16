import {
  type ClaudeCodeSessionCandidate,
  discoverClaudeCodeSessions,
  normalizeClaudeCodeSessionTree,
} from "./claudeCodeRepository.ts";
import { SessionRepository } from "./sessionRepository.ts";

const parserVersion = "claude-code-2";

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
  checkpoint?: {
    sourceSize: number;
    sourceModifiedAt: number;
    checksum?: string;
    parserVersion: string;
  },
) {
  for (const dependency of candidate.dependencies) {
    if (!dependency.artifactPath.endsWith(".jsonl")) continue;
    repository.recordUnchangedSourceSession(
      sourceID,
      externalID(candidate, dependency.artifactPath),
      dependency.artifactPath,
      observedAt,
      checkpoint,
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

export async function syncClaudeCodeSessions(
  directory: string,
  repository: SessionRepository,
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

  for (const candidate of candidates) {
    const previous = repository.checkpoint(sourceID, candidate.id);
    if (
      previous?.parserVersion === parserVersion &&
      previous.sourceSize === candidate.size &&
      previous.sourceModifiedAt === candidate.changeHint
    ) {
      recordUnchangedTree(repository, sourceID, candidate, observedAt);
      skipped++;
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
      const checkpoint = {
        sourceSize: candidate.size,
        sourceModifiedAt: candidate.changeHint,
        checksum,
        parserVersion,
      };
      if (
        previous?.parserVersion === parserVersion &&
        previous.checksum === checksum
      ) {
        recordUnchangedTree(
          repository,
          sourceID,
          candidate,
          observedAt,
          checkpoint,
        );
        skipped++;
        continue;
      }
      repository.replaceSourceSessionTree(normalizeClaudeCodeSessionTree({
        candidate,
        snapshots,
        sourceID,
        observedAt,
        checkpoint,
      }));
      imported++;
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
    }
  }

  repository.markMissingSourceSessions(sourceID, observedAt);
  return {
    discovered: candidates.length,
    imported,
    skipped,
    failed,
  };
}
