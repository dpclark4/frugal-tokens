import type {
  SessionRepository,
  SessionTurnImport,
} from "./sessionRepository.ts";
import type { SessionSummary } from "../shared/sessionSchemas.ts";

export type FileSessionCandidate = {
  id: string;
  path: string;
  artifactPath: string;
  updatedAt: number;
  size: number;
};

type NormalizedFileSession = {
  summary: SessionSummary;
  turns: SessionTurnImport[];
};

function checksum(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.digest("SHA-256", buffer).then((digest) =>
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

function failureCategory(error: unknown) {
  if (error instanceof SyntaxError) return "invalid-json";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("changed while it was being read")) {
    return "changed-during-read";
  }
  if (message.toLowerCase().includes("constraint")) {
    return "database-constraint";
  }
  return "import-error";
}

export async function syncFileSessions(options: {
  harness: SessionSummary["harness"];
  label: string;
  directory: string;
  parserVersion: string;
  repository: SessionRepository;
  discover: (directory: string) => FileSessionCandidate[];
  normalize: (
    candidate: FileSessionCandidate,
    text: string,
  ) => NormalizedFileSession;
}) {
  const observedAt = Date.now();
  const sourceID = options.repository.ensureSource(
    options.harness,
    "directory",
    options.label,
    options.directory,
  );
  const candidates = options.discover(options.directory);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failureCategories: Record<string, number> = {};

  for (const candidate of candidates) {
    const previous = options.repository.checkpoint(sourceID, candidate.id);
    if (
      previous?.parserVersion === options.parserVersion &&
      previous.sourceSize === candidate.size &&
      previous.sourceModifiedAt === candidate.updatedAt
    ) {
      options.repository.recordUnchangedSourceSession(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
      );
      skipped++;
      continue;
    }

    try {
      const bytes = Deno.readFileSync(candidate.path);
      const afterRead = Deno.statSync(candidate.path);
      const modifiedAt = afterRead.mtime?.getTime() ?? 0;
      if (
        afterRead.size !== candidate.size || modifiedAt !== candidate.updatedAt
      ) {
        throw new Error("Source changed while it was being read");
      }
      const fingerprint = await checksum(bytes);
      if (
        previous?.parserVersion === options.parserVersion &&
        previous.checksum === fingerprint
      ) {
        options.repository.recordUnchangedSourceSession(
          sourceID,
          candidate.id,
          candidate.artifactPath,
          observedAt,
          {
            sourceSize: candidate.size,
            sourceModifiedAt: candidate.updatedAt,
            checksum: fingerprint,
            parserVersion: options.parserVersion,
          },
        );
        skipped++;
        continue;
      }

      const normalized = options.normalize(
        candidate,
        new TextDecoder().decode(bytes),
      );
      options.repository.replaceSourceSession({
        sourceID,
        externalID: candidate.id,
        artifactPath: candidate.artifactPath,
        observedAt,
        checkpoint: {
          sourceSize: candidate.size,
          sourceModifiedAt: candidate.updatedAt,
          checksum: fingerprint,
          parserVersion: options.parserVersion,
        },
        session: {
          title: normalized.summary.title,
          updatedAt: normalized.summary.updatedAt,
          startedAt: normalized.summary.startedAt,
          endedAt: normalized.summary.endedAt,
          providers: normalized.summary.providers,
          models: normalized.summary.models,
          userTurns: normalized.summary.userTurns,
          modelCalls: normalized.summary.modelCalls,
          reportedCost: normalized.summary.reportedCost,
          tokens: normalized.summary.tokens,
          turns: normalized.turns,
        },
      });
      imported++;
    } catch (error) {
      const category = failureCategory(error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      console.warn(
        `[sync] harness=${options.harness} source=${candidate.path} failed category=${category}`,
        error,
      );
      options.repository.recordSourceSessionError(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        error,
      );
      failed++;
    }
  }

  options.repository.markMissingSourceSessions(sourceID, observedAt);
  return {
    discovered: candidates.length,
    imported,
    skipped,
    failed,
    failureCategories,
  };
}
