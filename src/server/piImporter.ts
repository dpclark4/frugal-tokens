import { discoverPiSessions, normalizePiSession } from "./piRepository.ts";
import { SessionRepository } from "./sessionRepository.ts";
import {
  sourceSessionImportFromFile,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";

const legacyParserVersion = "pi-6";
const conversationParserVersion = "pi-conversation-v2-3";

export async function syncPiSessions(
  directory: string,
  repository: SessionRepository,
  conversations?: ConversationProjectionRepository,
) {
  return await syncFileSessions({
    harness: "pi",
    label: "PI",
    directory,
    parserVersion: legacyParserVersion,
    repository,
    discover: discoverPiSessions,
    normalize: normalizePiSession,
    ...(conversations === undefined ? {} : {
      shadowProjections: [{
        name: "conversation-v2",
        parserVersion: conversationParserVersion,
        project: (observation) =>
          conversations.replaceLinearSession(
            sourceSessionImportFromFile(
              observation,
              normalizePiSession(observation.candidate, observation.text),
              conversationParserVersion,
            ),
          ),
      }],
    }),
  });
}
