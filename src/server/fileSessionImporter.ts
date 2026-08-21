import type {
  ConversationContextEventImport,
  ConversationTurnImport,
} from "./conversationImportTypes.ts";
import type {
  ProjectionCheckpoint,
  SourceArtifactMetadata,
  SourceArtifactProjectionRecord,
} from "./sourceArtifactRepository.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
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
  turns: ConversationTurnImport[];
  contextEvents?: ConversationContextEventImport[];
};

export type FileProjectionObservation = {
  sourceID: number;
  observedAt: number;
  candidate: FileSessionCandidate;
  text: string;
  checksum: string;
  normalize: () => NormalizedFileSession;
};

export type FileConversationProjection = {
  parserVersion: string;
  project: (observation: FileProjectionObservation) => void | Promise<void>;
};

export type FileConversationFamilyProjection = {
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
    records.map((record) => [record.sourceArtifactID, record]),
  );
  const neighbors = new Map<number, Set<number>>(
    records.map((record) => [record.sourceArtifactID, new Set<number>()]),
  );
  for (const record of records) {
    const parentID = record.parentSourceArtifactID;
    if (parentID === undefined || !byID.has(parentID)) continue;
    neighbors.get(record.sourceArtifactID)!.add(parentID);
    neighbors.get(parentID)!.add(record.sourceArtifactID);
  }
  const visited = new Set<number>();
  const families: SourceArtifactProjectionRecord[][] = [];
  for (const record of records) {
    if (visited.has(record.sourceArtifactID)) continue;
    const family: SourceArtifactProjectionRecord[] = [];
    const pending = [record.sourceArtifactID];
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
  const familyIDs = new Set(family.map((record) => record.sourceArtifactID));
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
      const parentID: number | undefined = current.parentSourceArtifactID;
      current = parentID === undefined || !familyIDs.has(parentID)
        ? undefined
        : family.find((candidate) => candidate.sourceArtifactID === parentID);
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

export function linearConversationImportFromFile(
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
  checkpoint: ProjectionCheckpoint | undefined,
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
  repository: SourceArtifactRepository;
  discover: (directory: string) => FileSessionCandidate[];
  normalize: (
    candidate: FileSessionCandidate,
    text: string,
  ) => NormalizedFileSession;
  projection?: FileConversationProjection;
  familyProjection?: FileConversationFamilyProjection;
}) {
  if (
    (options.projection === undefined) ===
      (options.familyProjection === undefined)
  ) {
    throw new Error("Exactly one conversation projection is required");
  }
  const projection = options.projection ?? options.familyProjection!;
  const projectionName = "conversation";
  const observedAt = Date.now();
  const sourceID = options.repository.ensureSource(
    options.harness,
    "directory",
    options.label,
    options.directory,
  );
  const candidates = options.discover(options.directory);
  const result: ProjectionResult = { imported: 0, skipped: 0, failed: 0 };
  const failureCategories: Record<string, number> = {};
  // Family projections retain only checksums from this scan and reload one
  // connected family at a time after lineage has been resolved.
  const observedChecksums = new Map<string, string>();
  const metadata: SourceArtifactMetadata[] = [];
  const metadataErrors = new Map<string, unknown>();

  const readObservation = async (candidate: FileSessionCandidate) => {
    const bytes = Deno.readFileSync(candidate.path);
    const afterRead = Deno.statSync(candidate.path);
    const modifiedAt = afterRead.mtime?.getTime() ?? 0;
    if (
      afterRead.size !== candidate.size || modifiedAt !== candidate.updatedAt
    ) {
      throw new Error("Source changed while it was being read");
    }
    const text = new TextDecoder().decode(bytes);
    let normalized: NormalizedFileSession | undefined;
    return {
      sourceID,
      observedAt,
      candidate,
      text,
      checksum: await checksum(bytes),
      normalize: () => normalized ??= options.normalize(candidate, text),
    } satisfies FileProjectionObservation;
  };

  for (const candidate of candidates) {
    const previous = options.repository.projectionCheckpoint(
      sourceID,
      candidate.id,
      projectionName,
    );
    const physicalUnchanged =
      previous?.parserVersion === projection.parserVersion &&
      previous.sourceSize === candidate.size &&
      previous.sourceModifiedAt === candidate.updatedAt &&
      previous.lastError === undefined;
    if (physicalUnchanged) {
      options.repository.recordUnchangedArtifact(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
      );
      if (options.projection !== undefined) result.skipped++;
      continue;
    }

    let observation: FileProjectionObservation;
    try {
      observation = await readObservation(candidate);
      if (options.familyProjection !== undefined) {
        observedChecksums.set(candidate.id, observation.checksum);
      }
      options.repository.recordUnchangedArtifact(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
      );
    } catch (error) {
      const category = failureCategory(error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      console.warn(
        `[sync] harness=${options.harness} source=${candidate.path} failed category=${category}`,
        error,
      );
      options.repository.recordArtifactError(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        error,
      );
      result.failed++;
      continue;
    }

    if (options.familyProjection !== undefined) {
      try {
        metadata.push({
          externalID: candidate.id,
          ...options.familyProjection.metadata(observation),
        });
      } catch (error) {
        metadataErrors.set(candidate.id, error);
      }
      continue;
    }

    const checkpoint: ProjectionCheckpoint = {
      sourceSize: candidate.size,
      sourceModifiedAt: candidate.updatedAt,
      checksum: observation.checksum,
      parserVersion: projection.parserVersion,
    };
    if (
      currentProjection(
        previous,
        projection.parserVersion,
        observation.checksum,
      )
    ) {
      options.repository.recordUnchangedArtifact(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        checkpoint,
      );
      result.skipped++;
      continue;
    }
    try {
      await options.projection!.project(observation);
      options.repository.recordUnchangedArtifact(
        sourceID,
        candidate.id,
        candidate.artifactPath,
        observedAt,
        checkpoint,
      );
      options.repository.recordProjectionCheckpoint(
        sourceID,
        candidate.id,
        projectionName,
        checkpoint,
      );
      result.imported++;
    } catch (error) {
      console.warn(
        `[sync] harness=${options.harness} source=${candidate.path} projection=${projectionName} failed`,
        error,
      );
      options.repository.recordProjectionError(
        sourceID,
        candidate.id,
        projectionName,
        error,
      );
      result.failed++;
    }
  }

  options.repository.markMissingArtifacts(sourceID, observedAt);
  if (options.familyProjection !== undefined) {
    try {
      if (metadata.length > 0) {
        options.repository.replaceSourceArtifactMetadata(sourceID, metadata);
      }
    } catch (error) {
      for (const candidate of candidates) {
        options.repository.recordProjectionError(
          sourceID,
          candidate.id,
          projectionName,
          error,
        );
        result.failed++;
      }
      return { discovered: candidates.length, ...result, failureCategories };
    }
    for (const [externalID, error] of metadataErrors) {
      options.repository.recordProjectionError(
        sourceID,
        externalID,
        projectionName,
        error,
      );
      result.failed++;
    }

    const candidateByID = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    const records = options.repository.listSourceArtifactsForProjection(
      sourceID,
      projectionName,
      options.familyProjection.identityNamespace,
      options.familyProjection.relationship,
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
          checksum: observedChecksums.get(record.externalID) ??
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
              (observedChecksums.get(record.externalID) ?? record.checksum))
        );
        if (current) {
          result.skipped += available.length;
          continue;
        }
        if (family.some((record) => record.availability === "missing")) {
          for (const record of family) {
            options.repository.recordProjectionCheckpoint(
              sourceID,
              record.externalID,
              projectionName,
              {
                parserVersion: projection.parserVersion,
                checksum: observedChecksums.get(record.externalID) ??
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
          const observation = await readObservation(
            candidateByID.get(record.externalID)!,
          );
          const expectedChecksum = observedChecksums.get(record.externalID) ??
            record.checksum;
          if (
            expectedChecksum !== undefined &&
            observation.checksum !== expectedChecksum
          ) {
            throw new Error("Source changed while it was being read");
          }
          projectedArtifacts.push({ record, observation });
        }
        await options.familyProjection.project({
          sourceID,
          dependencyDigest,
          artifacts: projectedArtifacts,
        });
        for (const { record, observation } of projectedArtifacts) {
          const checkpoint = {
            sourceSize: observation.candidate.size,
            sourceModifiedAt: observation.candidate.updatedAt,
            checksum: observation.checksum,
            parserVersion: projection.parserVersion,
            dependencyDigest,
          };
          options.repository.recordUnchangedArtifact(
            sourceID,
            record.externalID,
            observation.candidate.artifactPath,
            observedAt,
            checkpoint,
          );
          options.repository.recordProjectionCheckpoint(
            sourceID,
            record.externalID,
            projectionName,
            checkpoint,
          );
        }
        result.imported += projectedArtifacts.length;
      } catch (error) {
        for (const record of available) {
          options.repository.recordProjectionError(
            sourceID,
            record.externalID,
            projectionName,
            error,
          );
          result.failed++;
        }
      }
    }
  }

  return { discovered: candidates.length, ...result, failureCategories };
}
