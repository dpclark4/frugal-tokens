import {
  codexSourceArtifactMetadata,
  discoverCodexSessions,
  normalizeCodexSession,
} from "./codexRepository.ts";
import {
  linearConversationImportFromFile,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

const parserVersion = "codex-conversation-family-7";
const sourceIdentityNamespace = "session";
const forkRelationship = "fork";

export async function syncCodexSessions(
  directory: string,
  repository: SourceArtifactRepository,
  conversations: ConversationWriteRepository,
) {
  return await syncFileSessions({
    harness: "codex",
    label: "Codex",
    directory,
    repository,
    discover: discoverCodexSessions,
    normalize: normalizeCodexSession,
    familyProjection: {
      parserVersion,
      identityNamespace: sourceIdentityNamespace,
      relationship: forkRelationship,
      metadata: (observation) => {
        const metadata = codexSourceArtifactMetadata(observation.text);
        return {
          identities: metadata.sourceIdentity === undefined ? [] : [{
            namespace: sourceIdentityNamespace,
            value: metadata.sourceIdentity,
          }],
          lineage: metadata.parentSourceIdentity === undefined ? [] : [{
            relationship: forkRelationship,
            parentIdentityNamespace: sourceIdentityNamespace,
            parentIdentityValue: metadata.parentSourceIdentity,
            provenance: "explicit-source-metadata",
          }],
        };
      },
      project: ({ sourceID, artifacts }) => {
        const sourceArtifactIDs = new Set(
          artifacts.map(({ record }) => record.sourceArtifactID),
        );
        const root = artifacts.find(({ record }) =>
          record.parentSourceArtifactID === undefined ||
          !sourceArtifactIDs.has(record.parentSourceArtifactID)
        ) ?? artifacts[0];
        conversations.replaceConversationFamily({
          sourceID,
          externalID: root.record.sourceIdentity ?? root.record.externalID,
          artifacts: artifacts.map(({ record, observation }) => ({
            externalID: record.externalID,
            sourceIdentity: record.sourceIdentity,
            parentSourceIdentity: record.parentSourceIdentity,
            value: linearConversationImportFromFile(
              observation,
              observation.normalize(),
              parserVersion,
            ),
          })),
        });
      },
    },
  });
}
