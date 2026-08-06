import type {
  SessionContextEventImport,
  SessionRepository,
  SessionTurnImport,
  SourceArtifactMetadata,
  SourceArtifactProjectionRecord,
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

export type FileSessionFamilyShadowProjection = {
  name: string;
  parserVersion: string;
  identityNamespace: string;
  relationship: string;
  metadata: (
    observation: FileProjectionObservation,
  ) => Omit<SourceArtifactMetadata, "externalID">;
  project: (value: {
    sourceID: number;
    dependencyDigest: string;
    artifacts: Array<{
      record: SourceArtifactProjectionRecord;
      observation: FileProjectionObservation;
    }>;
  }) => void | Promise<void>;
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

function connectedArtifactFamilies(records: SourceArtifactProjectionRecord[]) {
  const byID = new Map(
    records.map((record) => [record.sourceSessionID, record]),
  );
  const neighbors = new Map<number, Set<number>>(
    records.map((record) => [record.sourceSessionID, new Set<number>()]),
  );
  for (const record of records) {
    const parentID = record.parentSourceSessionID;
    if (parentID === undefined || !byID.has(parentID)) continue;
    neighbors.get(record.sourceSessionID)!.add(parentID);
    neighbors.get(parentID)!.add(record.sourceSessionID);
  }
  const visited = new Set<number>();
  const families: SourceArtifactProjectionRecord[][] = [];
  for (const record of records) {
    if (visited.has(record.sourceSessionID)) continue;
    const family: SourceArtifactProjectionRecord[] = [];
    const pending = [record.sourceSessionID];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      family.push(byID.get(id)!);
      pending.push(...neighbors.get(id)!);
    }
    families.push(
      family.sort((a, b) => a.externalID.localeCompare(b.externalID)),
    );
  }
  return families;
}

function assertAcyclicArtifactLineage(
  family: SourceArtifactProjectionRecord[],
) {
  const familyIDs = new Set(family.map((record) => record.sourceSessionID));
  for (const start of family) {
    const path = new Set<number>();
    let current: SourceArtifactProjectionRecord | undefined = start;
    while (current !== undefined) {
      if (path.has(current.sourceSessionID)) {
        throw new Error(
          `Malformed source artifact ancestry cycle: ${start.externalID}`,
        );
      }
      path.add(current.sourceSessionID);
      const parentID: number | undefined = current.parentSourceSessionID;
      current = parentID === undefined || !familyIDs.has(parentID)
        ? undefined
        : family.find((candidate) => candidate.sourceSessionID === parentID);
    }
  }
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
  familyShadowProjections?: FileSessionFamilyShadowProjection[];
}) {
  const shadowProjections = options.shadowProjections ?? [];
  const familyShadowProjections = options.familyShadowProjections ?? [];
  const projectionNames = new Set(["legacy"]);
  for (
    const projection of [
      ...shadowProjections,
      ...familyShadowProjections,
    ]
  ) {
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
  const projectionResults: Record<string, ProjectionResult> = Object
    .fromEntries(
      [...projectionNames].map((name) => [
        name,
        { imported: 0, skipped: 0, failed: 0 },
      ]),
    );
  const legacyResult = projectionResults.legacy;
  const failureCategories: Record<string, number> = {};
  const observations = new Map<string, FileProjectionObservation>();
  const familyMetadata = new Map<string, SourceArtifactMetadata[]>();
  const familyMetadataErrors = new Map<string, Map<string, unknown>>();
  for (const projection of familyShadowProjections) {
    familyMetadata.set(projection.name, []);
    familyMetadataErrors.set(projection.name, new Map());
  }

  const observe = async (candidate: FileSessionCandidate) => {
    const existing = observations.get(candidate.id);
    if (existing !== undefined) return existing;
    const bytes = Deno.readFileSync(candidate.path);
    const afterRead = Deno.statSync(candidate.path);
    const modifiedAt = afterRead.mtime?.getTime() ?? 0;
    if (
      afterRead.size !== candidate.size || modifiedAt !== candidate.updatedAt
    ) {
      throw new Error("Source changed while it was being read");
    }
    const observation = {
      sourceID,
      observedAt,
      candidate,
      bytes,
      text: new TextDecoder().decode(bytes),
      checksum: await checksum(bytes),
    };
    observations.set(candidate.id, observation);
    return observation;
  };

  for (const candidate of candidates) {
    const definitions = [
      { name: "legacy", parserVersion: options.parserVersion },
      ...shadowProjections,
      ...familyShadowProjections,
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
        if (
          !familyShadowProjections.some((family) =>
            family.name === projection.name
          )
        ) {
          projectionResults[projection.name].skipped++;
        }
      }
      continue;
    }

    let observation: FileProjectionObservation;
    try {
      observation = await observe(candidate);
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
      for (const projection of familyShadowProjections) {
        familyMetadataErrors.get(projection.name)!.set(candidate.id, error);
      }
      continue;
    }

    for (const projection of familyShadowProjections) {
      try {
        familyMetadata.get(projection.name)!.push({
          externalID: candidate.id,
          ...projection.metadata(observation),
        });
      } catch (error) {
        familyMetadataErrors.get(projection.name)!.set(candidate.id, error);
      }
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
  const candidateByID = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  for (const projection of familyShadowProjections) {
    const result = projectionResults[projection.name];
    const metadataErrors = familyMetadataErrors.get(projection.name)!;
    try {
      options.repository.replaceSourceArtifactMetadata(
        sourceID,
        familyMetadata.get(projection.name)!,
      );
    } catch (error) {
      for (const candidate of candidates) {
        options.repository.recordProjectionError(
          sourceID,
          candidate.id,
          projection.name,
          error,
        );
        result.failed++;
      }
      continue;
    }
    for (const [externalID, error] of metadataErrors) {
      options.repository.recordProjectionError(
        sourceID,
        externalID,
        projection.name,
        error,
      );
      result.failed++;
    }

    const records = options.repository.listSourceArtifactsForProjection(
      sourceID,
      projection.name,
      projection.identityNamespace,
      projection.relationship,
    );
    for (const family of connectedArtifactFamilies(records)) {
      const available = family.filter((record) =>
        record.availability === "available" &&
        candidateByID.has(record.externalID)
      );
      if (available.some((record) => metadataErrors.has(record.externalID))) {
        continue;
      }
      try {
        assertAcyclicArtifactLineage(family);
        const digestValues = family.map((record) => ({
          externalID: record.externalID,
          checksum: observations.get(record.externalID)?.checksum ??
            record.checksum ?? null,
          parentSourceIdentity: record.parentSourceIdentity ?? null,
          availability: record.availability,
        }));
        const dependencyDigest = await checksum(
          new TextEncoder().encode(JSON.stringify({
            parserVersion: projection.parserVersion,
            artifacts: digestValues,
          })),
        );
        const current = family.every((record) =>
          record.parserVersion === projection.parserVersion &&
          record.dependencyDigest === dependencyDigest &&
          record.lastError === undefined &&
          (record.availability === "missing" ||
            record.checksum ===
              (observations.get(record.externalID)?.checksum ??
                record.checksum))
        );
        if (current) {
          result.skipped += available.length;
          continue;
        }

        // Missing artifacts retain their last successful canonical family.
        // Availability and the family dependency still advance, so a later
        // reappearance deterministically triggers a complete rebuild.
        if (family.some((record) => record.availability === "missing")) {
          for (const record of family) {
            options.repository.recordProjectionCheckpoint(
              sourceID,
              record.externalID,
              projection.name,
              {
                parserVersion: projection.parserVersion,
                checksum: observations.get(record.externalID)?.checksum ??
                  record.checksum,
                dependencyDigest,
              },
            );
          }
          result.skipped += available.length;
          continue;
        }

        const projectedArtifacts = [];
        for (const record of available) {
          projectedArtifacts.push({
            record,
            observation: await observe(candidateByID.get(record.externalID)!),
          });
        }
        await projection.project({
          sourceID,
          dependencyDigest,
          artifacts: projectedArtifacts,
        });
        for (const { record, observation } of projectedArtifacts) {
          options.repository.recordProjectionCheckpoint(
            sourceID,
            record.externalID,
            projection.name,
            {
              sourceSize: observation.candidate.size,
              sourceModifiedAt: observation.candidate.updatedAt,
              checksum: observation.checksum,
              parserVersion: projection.parserVersion,
              dependencyDigest,
            },
          );
        }
        result.imported += projectedArtifacts.length;
      } catch (error) {
        for (const record of available) {
          options.repository.recordProjectionError(
            sourceID,
            record.externalID,
            projection.name,
            error,
          );
          result.failed++;
        }
      }
    }
  }
  return {
    discovered: candidates.length,
    imported: legacyResult.imported,
    skipped: legacyResult.skipped,
    failed: legacyResult.failed,
    failureCategories,
    projectionResults,
  };
}
