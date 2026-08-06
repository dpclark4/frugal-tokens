import {
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
const conversationParserVersion = "codex-conversation-v2-linear-1";

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
      shadowProjections: [{
        name: "conversation-v2",
        parserVersion: conversationParserVersion,
        project: (observation) =>
          conversations.replaceLinearSession(
            sourceSessionImportFromFile(
              observation,
              normalizeCodexSession(observation.candidate, observation.text),
              conversationParserVersion,
            ),
          ),
      }],
    }),
  });
}
