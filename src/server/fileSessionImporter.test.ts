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

Deno.test("file projections share observations and isolate parser state and failures", async () => {
  const directory = Deno.makeTempDirSync();
  const sourceDirectory = `${directory}/sessions`;
  const sourcePath = `${sourceDirectory}/session.json`;
  Deno.mkdirSync(sourceDirectory);
  let modifiedAtSeconds = 1_810_000_000;
  let legacyNormalizations = 0;
  let v2Version = "conversation-v2-1";
  let failV2 = false;
  const v2Observations: unknown[] = [];
  const auditObservations: unknown[] = [];

  const writeSource = (title: string, updatedAt: number) => {
    Deno.writeTextFileSync(sourcePath, JSON.stringify({ title, updatedAt }));
    modifiedAtSeconds++;
    Deno.utimeSync(sourcePath, modifiedAtSeconds, modifiedAtSeconds);
  };
  const discover = (): FileSessionCandidate[] => {
    const stat = Deno.statSync(sourcePath);
    return [{
      id: "session",
      path: sourcePath,
      artifactPath: "session.json",
      updatedAt: stat.mtime?.getTime() ?? 0,
      size: stat.size,
    }];
  };

  const db = openArchiveDatabase(`${directory}/archive.sqlite`);
  migrateTestDatabase(db);
  const repository = new SessionRepository(db);
  const sync = () =>
    syncFileSessions({
      harness: "pi",
      label: "Projection fixture",
      directory: sourceDirectory,
      parserVersion: "legacy-1",
      repository,
      discover: () => discover(),
      normalize: (candidate, text) => {
        legacyNormalizations++;
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
      shadowProjections: [
        {
          name: "conversation-v2",
          parserVersion: v2Version,
          project: (observation) => {
            v2Observations.push(observation);
            if (failV2) throw new Error("V2 fixture failure");
          },
        },
        {
          name: "audit-fixture",
          parserVersion: "audit-1",
          project: (observation) => auditObservations.push(observation),
        },
      ],
    });

  try {
    writeSource("First", 1);
    const first = await sync();
    strictEqual(first.imported, 1);
    strictEqual(first.projectionResults["conversation-v2"].imported, 1);
    strictEqual(first.projectionResults["audit-fixture"].imported, 1);
    strictEqual(v2Observations[0], auditObservations[0]);
    strictEqual(legacyNormalizations, 1);

    const unchanged = await sync();
    strictEqual(unchanged.skipped, 1);
    strictEqual(unchanged.projectionResults["conversation-v2"].skipped, 1);

    v2Version = "conversation-v2-2";
    const parserBump = await sync();
    strictEqual(parserBump.skipped, 1);
    strictEqual(parserBump.projectionResults["conversation-v2"].imported, 1);
    strictEqual(parserBump.projectionResults["audit-fixture"].skipped, 1);
    strictEqual(legacyNormalizations, 1);
    strictEqual(
      repository.checkpoint(1, "session", "legacy")?.parserVersion,
      "legacy-1",
    );
    strictEqual(
      repository.checkpoint(1, "session", "conversation-v2")?.parserVersion,
      "conversation-v2-2",
    );

    const lastGoodV2 = repository.checkpoint(
      1,
      "session",
      "conversation-v2",
    )!;
    failV2 = true;
    writeSource("Legacy survives V2 failure", 2);
    const failed = await sync();
    strictEqual(failed.imported, 1);
    strictEqual(failed.projectionResults["conversation-v2"].failed, 1);
    strictEqual(
      repository.getSession("pi", "session")?.title,
      "Legacy survives V2 failure",
    );
    strictEqual(
      repository.checkpoint(1, "session", "legacy")?.parserVersion,
      "legacy-1",
    );
    const failedV2 = repository.checkpoint(
      1,
      "session",
      "conversation-v2",
    )!;
    strictEqual(failedV2.checksum, lastGoodV2.checksum);
    strictEqual(failedV2.parserVersion, lastGoodV2.parserVersion);
    strictEqual(failedV2.lastError, "V2 fixture failure");

    failV2 = false;
    const recovered = await sync();
    strictEqual(recovered.skipped, 1);
    strictEqual(recovered.projectionResults["conversation-v2"].imported, 1);
    strictEqual(
      repository.checkpoint(1, "session", "conversation-v2")?.lastError,
      undefined,
    );
  } finally {
    db.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
