import { discoverPiSessions, normalizePiSession } from "./piRepository.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import {
  linearConversationImportFromFile,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";

const parserVersion = "pi-conversation-8";

export async function syncPiSessions(
  directory: string,
  repository: SourceArtifactRepository,
  conversations: ConversationWriteRepository,
) {
  return await syncFileSessions({
    harness: "pi",
    label: "PI",
    directory,
    repository,
    discover: discoverPiSessions,
    normalize: normalizePiSession,
    projection: {
      parserVersion,
      project: (observation) =>
        conversations.replaceLinearConversation(
          linearConversationImportFromFile(
            observation,
            observation.normalize(),
            parserVersion,
          ),
        ),
    },
  });
}
