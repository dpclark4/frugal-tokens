import { discoverPiSessions, normalizePiSession } from "./piRepository.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { syncFileSessions } from "./fileSessionImporter.ts";

export async function syncPiSessions(
  directory: string,
  repository: SessionRepository,
) {
  return await syncFileSessions({
    harness: "pi",
    label: "PI",
    directory,
    parserVersion: "pi-2",
    repository,
    discover: discoverPiSessions,
    normalize: normalizePiSession,
  });
}
