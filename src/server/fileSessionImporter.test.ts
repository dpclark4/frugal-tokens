import { strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import {
  type FileSessionCandidate,
  linearConversationImportFromFile,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { SourceArtifactRepository } from "./sourceArtifactRepository.ts";
import { ConversationWriteRepository } from "./conversationWriteRepository.ts";
import { ConversationRepository } from "./conversationRepository.ts";

const emptyTokens = {
  uncachedInput: 0,
  cacheRead: 0,
  freshPrompt: 0,
  output: 0,
  reasoning: 0,
  processed: 0,
};

Deno.test("canonical file import skips unchanged artifacts and preserves last-good data", async () => {
  const directory = Deno.makeTempDirSync();
  const sourceDirectory = `${directory}/sessions`;
  const sourcePath = `${sourceDirectory}/session.json`;
  Deno.mkdirSync(sourceDirectory);
  let modifiedAtSeconds = 1_800_000_000;
  let parserVersion = "fixture-1";
  let failWrite = false;

  const writeSource = (content: string) => {
    Deno.writeTextFileSync(sourcePath, content);
    modifiedAtSeconds++;
    Deno.utimeSync(sourcePath, modifiedAtSeconds, modifiedAtSeconds);
  };
  const discover = (): FileSessionCandidate[] => {
    try {
      const stat = Deno.statSync(sourcePath);
      return [{
        id: "session",
        path: sourcePath,
        artifactPath: "session.json",
        updatedAt: stat.mtime?.getTime() ?? 0,
        size: stat.size,
      }];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  };

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const sources = new SourceArtifactRepository(db);
  const writer = new ConversationWriteRepository(db);
  const reads = new ConversationRepository(db);
  const sync = () =>
    syncFileSessions({
      harness: "pi",
      label: "Lifecycle fixture",
      directory: sourceDirectory,
      repository: sources,
      discover,
      normalize: (candidate, text) => {
        const value = JSON.parse(text) as { title: string; updatedAt: number };
        return {
          summary: {
            id: candidate.id,
            harness: "pi",
            title: value.title,
            updatedAt: value.updatedAt,
            providers: [],
            models: [],
            userTurns: 0,
            modelCalls: 0,
            tokens: emptyTokens,
          },
          turns: [],
        };
      },
      projection: {
        parserVersion,
        project: (observation) => {
          if (failWrite) throw new Error("forced conversation failure");
          writer.replaceLinearConversation(
            linearConversationImportFromFile(
              observation,
              observation.normalize(),
              parserVersion,
            ),
          );
        },
      },
    });

  try {
    writeSource('{"title":"First","updatedAt":1}');
    strictEqual((await sync()).imported, 1);
    strictEqual(reads.getSession("pi", "session")?.title, "First");
    strictEqual((await sync()).skipped, 1);

    parserVersion = "fixture-2";
    strictEqual((await sync()).imported, 1);
    strictEqual(
      sources.projectionCheckpoint(1, "session")?.parserVersion,
      "fixture-2",
    );

    failWrite = true;
    writeSource('{"title":"Must not replace last good","updatedAt":2}');
    strictEqual((await sync()).failed, 1);
    strictEqual(reads.getSession("pi", "session")?.title, "First");
    strictEqual(
      sources.projectionCheckpoint(1, "session")?.lastError,
      "forced conversation failure",
    );

    failWrite = false;
    strictEqual((await sync()).imported, 1);
    strictEqual(
      reads.getSession("pi", "session")?.title,
      "Must not replace last good",
    );

    Deno.removeSync(sourcePath);
    strictEqual((await sync()).discovered, 0);
    strictEqual(
      db.prepare(
        "SELECT availability FROM source_sessions WHERE external_id = 'session'",
      ).get()!
        .availability,
      "missing",
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
