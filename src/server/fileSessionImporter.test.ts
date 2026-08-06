import { strictEqual } from "node:assert/strict";
import { openArchiveDatabase } from "./database.ts";
import { migrateTestDatabase } from "./databaseTestUtils.ts";
import {
  type FileSessionCandidate,
  syncFileSessions,
} from "./fileSessionImporter.ts";
import { SessionRepository } from "./sessionRepository.ts";

const emptyTokens = {
  uncachedInput: 0,
  cacheRead: 0,
  freshPrompt: 0,
  output: 0,
  reasoning: 0,
  processed: 0,
};

Deno.test("file import lifecycle preserves checkpoints and the last good projection", async () => {
  const directory = Deno.makeTempDirSync();
  const sourceDirectory = `${directory}/sessions`;
  const sourcePath = `${sourceDirectory}/session.json`;
  Deno.mkdirSync(sourceDirectory);
  let modifiedAtSeconds = 1_800_000_000;

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
  const repository = new SessionRepository(db);
  const sync = (parserVersion: string) =>
    syncFileSessions({
      harness: "pi",
      label: "Lifecycle fixture",
      directory: sourceDirectory,
      parserVersion,
      repository,
      discover: () => discover(),
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
    });

  try {
    writeSource('{"title":"First","updatedAt":1}');
    strictEqual((await sync("fixture-1")).imported, 1);
    strictEqual(repository.getSession("pi", "session")?.title, "First");

    strictEqual((await sync("fixture-1")).skipped, 1);

    writeSource('{"title":"Changed content","updatedAt":2}');
    strictEqual((await sync("fixture-1")).imported, 1);
    strictEqual(
      repository.getSession("pi", "session")?.title,
      "Changed content",
    );

    modifiedAtSeconds++;
    Deno.utimeSync(sourcePath, modifiedAtSeconds, modifiedAtSeconds);
    strictEqual((await sync("fixture-1")).skipped, 1);
    strictEqual(
      repository.getSession("pi", "session")?.title,
      "Changed content",
    );

    strictEqual((await sync("fixture-2")).imported, 1);
    const goodCheckpoint = db.prepare(`
      SELECT checksum, parser_version FROM source_sessions
      WHERE external_id = 'session'
    `).get() as { checksum: string; parser_version: string };
    strictEqual(goodCheckpoint.parser_version, "fixture-2");

    writeSource("{");
    const failed = await sync("fixture-2");
    strictEqual(failed.failed, 1);
    strictEqual(failed.failureCategories["invalid-json"], 1);
    strictEqual(
      repository.getSession("pi", "session")?.title,
      "Changed content",
    );
    const failedCheckpoint = db.prepare(`
      SELECT checksum, parser_version, last_error FROM source_sessions
      WHERE external_id = 'session'
    `).get() as {
      checksum: string;
      parser_version: string;
      last_error: string;
    };
    strictEqual(failedCheckpoint.checksum, goodCheckpoint.checksum);
    strictEqual(failedCheckpoint.parser_version, "fixture-2");
    strictEqual(failedCheckpoint.last_error.length > 0, true);

    Deno.removeSync(sourcePath);
    strictEqual((await sync("fixture-2")).discovered, 0);
    strictEqual(
      db.prepare(`
        SELECT availability FROM source_sessions WHERE external_id = 'session'
      `).get()!.availability,
      "missing",
    );

    writeSource('{"title":"Reappeared","updatedAt":3}');
    strictEqual((await sync("fixture-2")).imported, 1);
    strictEqual(repository.getSession("pi", "session")?.title, "Reappeared");
    const reappeared = db.prepare(`
      SELECT availability, last_error FROM source_sessions
      WHERE external_id = 'session'
    `).get() as { availability: string; last_error: string | null };
    strictEqual(reappeared.availability, "available");
    strictEqual(reappeared.last_error, null);
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
