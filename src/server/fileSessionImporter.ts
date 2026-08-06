import type {
  SessionContextEventImport,
  SessionRepository,
  SessionTurnImport,
  SourceSessionCheckpoint,
} from "./sessionRepository.ts";
import type { SessionSummary } from "../shared/sessionSchemas.ts";

export type FileSessionCandidate = {
  id: string;
  path: string;
  artifactPath: string;
  updatedAt: number;
  size: number;
};

export type NormalizedFileSession = {
  summary: SessionSummary;
  workingDirectory?: string;
  turns: SessionTurnImport[];
  contextEvents?: SessionContextEventImport[];
};

export type FileProjectionObservation = {
  sourceID: number;
  observedAt: number;
  candidate: FileSessionCandidate;
  bytes: Uint8Array;
  text: string;
  checksum: string;
};

export type FileSessionShadowProjection = {
  name: string;
  parserVersion: string;
  project: (observation: FileProjectionObservation) => void | Promise<void>;
};

type ProjectionResult = {
  imported: number;
  skipped: number;
  failed: number;
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

export function sourceSessionImportFromFile(
  observation: FileProjectionObservation,
  normalized: NormalizedFileSession,
  parserVersion: string,
) {
  return {
    sourceID: observation.sourceID,
    externalID: observation.candidate.id,
    artifactPath: observation.candidate.artifactPath,
    workingDirectory: normalized.workingDirectory,
    observedAt: observation.observedAt,
    checkpoint: {
      sourceSize: observation.candidate.size,
      sourceModifiedAt: observation.candidate.updatedAt,
      checksum: observation.checksum,
      parserVersion,
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
      contextEvents: normalized.contextEvents,
    },
  };
}

function currentProjection(
  checkpoint: SourceSessionCheckpoint | undefined,
  parserVersion: string,
  sourceChecksum: string,
) {
  return checkpoint?.parserVersion === parserVersion &&
    checkpoint.checksum === sourceChecksum &&
    checkpoint.lastError === undefined;
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
  shadowProjections?: FileSessionShadowProjection[];
}) {
  const shadowProjections = options.shadowProjections ?? [];
  const projectionNames = new Set(["legacy"]);
  for (const projection of shadowProjections) {
    if (!projection.name || projectionNames.has(projection.name)) {
      throw new Error(`Duplicate file projection: ${projection.name}`);
    }
    projectionNames.add(projection.name);
  }

  const observedAt = Date.now();
  const sourceID = options.repository.ensureSource(
    options.harness,
    "directory",
    options.label,
    options.directory,
  );
  const candidates = options.discover(options.directory);
  const projectionResults: Record<string, ProjectionResult> = Object.fromEntries(
    [...projectionNames].map((name) => [
      name,
      { imported: 0, skipped: 0, failed: 0 },
    ]),
  );
  const legacyResult = projectionResults.legacy;
  const failureCategories: Record<string, number> = {};

  for (const candidate of candidates) {
    const definitions = [
      { name: "legacy", parserVersion: options.parserVersion },
      ...shadowProjections,
    ];
    const checkpoints = new Map(
      definitions.map((projection) => [
        projection.name,
        options.repository.checkpoint(
          sourceID,
          candidate.id,
          projection.name,
        ),
      ]),
    );
    const physicalUnchanged = definitions.every((projection) => {
      const previous = checkpoints.get(projection.name);
      return previous?.parserVersion === projection.parserVersion &&
        previous.sourceSize === candidate.size &&
        previous.sourceModifiedAt === candidate.updatedAt &&
        previous.lastError === undefined;
    });
    if (physicalUnchanged) {
      options.repository.recordUnchangedSourceSession(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
      );
      for (const projection of definitions) {
        projectionResults[projection.name].skipped++;
      }
      continue;
    }

    let observation: FileProjectionObservation;
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
      observation = {
        sourceID,
        observedAt,
        candidate,
        bytes,
        text: new TextDecoder().decode(bytes),
        checksum: fingerprint,
      };
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
      legacyResult.failed++;
      for (const projection of shadowProjections) {
        options.repository.recordProjectionError(
          sourceID,
          candidate.id,
          projection.name,
          error,
        );
        projectionResults[projection.name].failed++;
      }
      continue;
    }

    const legacyCheckpoint = checkpoints.get("legacy");
    if (
      currentProjection(
        legacyCheckpoint,
        options.parserVersion,
        observation.checksum,
      )
    ) {
      options.repository.recordUnchangedSourceSession(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        {
          sourceSize: candidate.size,
          sourceModifiedAt: candidate.updatedAt,
          checksum: observation.checksum,
          parserVersion: options.parserVersion,
        },
      );
      legacyResult.skipped++;
    } else {
      try {
        const normalized = options.normalize(candidate, observation.text);
        options.repository.replaceSourceSession(
          sourceSessionImportFromFile(
            observation,
            normalized,
            options.parserVersion,
          ),
        );
        legacyResult.imported++;
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
        legacyResult.failed++;
      }
    }

    for (const projection of shadowProjections) {
      const result = projectionResults[projection.name];
      if (
        currentProjection(
          checkpoints.get(projection.name),
          projection.parserVersion,
          observation.checksum,
        )
      ) {
        result.skipped++;
        continue;
      }
      try {
        await projection.project(observation);
        options.repository.recordProjectionCheckpoint(
          sourceID,
          candidate.id,
          projection.name,
          {
            sourceSize: candidate.size,
            sourceModifiedAt: candidate.updatedAt,
            checksum: observation.checksum,
            parserVersion: projection.parserVersion,
          },
        );
        result.imported++;
      } catch (error) {
        console.warn(
          `[sync] harness=${options.harness} source=${candidate.path} projection=${projection.name} failed`,
          error,
        );
        options.repository.recordProjectionError(
          sourceID,
          candidate.id,
          projection.name,
          error,
        );
        result.failed++;
      }
    }
  }

  options.repository.markMissingSourceSessions(sourceID, observedAt);
  return {
    discovered: candidates.length,
    imported: legacyResult.imported,
    skipped: legacyResult.skipped,
    failed: legacyResult.failed,
    failureCategories,
    projectionResults,
  };
}
