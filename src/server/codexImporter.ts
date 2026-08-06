import {
  codexSourceArtifactMetadata,
  discoverCodexSessions,
  normalizeCodexSession,
} from "./codexRepository.ts";
import {
  sourceSessionImportFromFile,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";

const legacyParserVersion = "codex-12";
const conversationParserVersion = "codex-conversation-v2-family-2";
const sourceIdentityNamespace = "session";
const forkRelationship = "fork";

export async function syncCodexSessions(
  directory: string,
  repository: SessionRepository,
  conversations?: ConversationProjectionRepository,
) {
  return await syncFileSessions({
    harness: "codex",
    label: "Codex",
    directory,
    parserVersion: legacyParserVersion,
    repository,
    discover: discoverCodexSessions,
    normalize: normalizeCodexSession,
    ...(conversations === undefined ? {} : {
      familyShadowProjections: [{
        name: "conversation-v2",
        parserVersion: conversationParserVersion,
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
          const sourceSessionIDs = new Set(
            artifacts.map(({ record }) => record.sourceSessionID),
          );
          const root = artifacts.find(({ record }) =>
            record.parentSourceSessionID === undefined ||
            !sourceSessionIDs.has(record.parentSourceSessionID)
          ) ?? artifacts[0];
          conversations.replaceArtifactFamily({
            sourceID,
            externalID: root.record.sourceIdentity ?? root.record.externalID,
            artifacts: artifacts.map(({ record, observation }) => ({
              externalID: record.externalID,
              sourceIdentity: record.sourceIdentity,
              parentSourceIdentity: record.parentSourceIdentity,
              value: sourceSessionImportFromFile(
                observation,
                normalizeCodexSession(
                  observation.candidate,
                  observation.text,
                ),
                conversationParserVersion,
              ),
            })),
          });
        },
      }],
    }),
  });
}
