import {
  discoverCodexSessions,
  normalizeCodexSession,
} from "./codexRepository.ts";
import { syncFileSessions } from "./fileSessionImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";

export async function syncCodexSessions(
  directory: string,
  repository: SessionRepository,
) {
  return await syncFileSessions({
    harness: "codex",
    label: "Codex",
    directory,
    parserVersion: "codex-6",
    repository,
    discover: discoverCodexSessions,
    normalize: normalizeCodexSession,
  });
}
