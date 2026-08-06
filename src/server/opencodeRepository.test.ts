import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeRepository } from "./opencodeRepository.ts";

Deno.test("removes empty turns without dropping reported cost", () => {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      model TEXT,
      agent TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO session VALUES (?, NULL, ?, NULL, NULL, ?, ?)",
  ).run("session", "Session", 1, 4);
  const insertMessage = database.prepare(
    "INSERT INTO message VALUES (?, 'session', ?, ?)",
  );
  insertMessage.run(
    "orphan-assistant",
    0,
    JSON.stringify({
      role: "assistant",
      providerID: "test",
      modelID: "orphan-model",
      cost: 0.5,
      tokens: {
        input: 100,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  insertMessage.run("aborted-user", 1, JSON.stringify({ role: "user" }));
  insertMessage.run(
    "aborted-assistant",
    2,
    JSON.stringify({
      role: "assistant",
      cost: 0,
      error: { name: "MessageAbortedError" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  insertMessage.run("priced-user", 3, JSON.stringify({ role: "user" }));
  insertMessage.run(
    "priced-assistant",
    4,
    JSON.stringify({
      role: "assistant",
      providerID: "test",
      modelID: "test-model",
      cost: 0.25,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  database.prepare(
    "INSERT INTO part VALUES (?, 'session', ?, ?, ?)",
  ).run(
    "image-part",
    "priced-user",
    3,
    JSON.stringify({ type: "file", mime: "image/png" }),
  );
  database.close();

  const repository = new OpenCodeRepository(path);
  try {
    const session = repository.getSession("session")!;
    strictEqual(session.userTurns, 1);
    strictEqual(session.turns[0].number, 1);
    strictEqual(session.turns[0].calls.length, 1);
    strictEqual(session.turns[0].calls[0].reportedCost, 0.25);
    strictEqual(session.turns[0].calls[0].activity.images, 1);
    const detailCalls = session.turns.flatMap((turn) => turn.calls).map(
      ({ provider, model, startedAt, reportedCost, tokens }) => ({
        harness: "opencode",
        session: {
          id: "session",
          rootID: "session",
          parentID: undefined,
        },
        cacheChainID: "session",
        turnID: "session:priced-user",
        turnOrdinal: 2,
        images: 1,
        sessionStartedAt: 1,
        provider,
        model,
        startedAt,
        reportedCost,
        tokens,
      }),
    );
    deepStrictEqual(repository.listUsageCalls(), detailCalls);
    deepStrictEqual(repository.listUsageCalls(4), detailCalls);
  } finally {
    repository.close();
    Deno.removeSync(path);
  }
});

Deno.test("excludes OpenCode synthetic tool traces from message content", () => {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, model TEXT,
      agent TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO session VALUES (?, NULL, ?, NULL, NULL, 1, 2)")
    .run("session", "Session");
  const insertMessage = database.prepare(
    "INSERT INTO message VALUES (?, 'session', ?, ?)",
  );
  insertMessage.run("user", 1, JSON.stringify({ role: "user" }));
  insertMessage.run("assistant", 2, JSON.stringify({
    role: "assistant",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }));
  const insertPart = database.prepare(
    "INSERT INTO part VALUES (?, 'session', ?, ?, ?)",
  );
  insertPart.run("prompt", "user", 1, JSON.stringify({
    type: "text", text: "Read these files.", synthetic: false,
  }));
  insertPart.run("tool-input", "user", 1, JSON.stringify({
    type: "text", text: "Called the Read tool", synthetic: true,
  }));
  insertPart.run("tool-output", "user", 1, JSON.stringify({
    type: "text", text: "<file>tool output</file>", synthetic: true,
  }));
  database.close();

  const repository = new OpenCodeRepository(path);
  try {
    const turn = repository.getSession("session")!.turns[0];
    deepStrictEqual(turn.inputs, [{
      kind: "text",
      preview: "Read these files.",
      originalLength: 17,
      truncated: false,
    }]);
  } finally {
    repository.close();
    Deno.removeSync(path);
  }
});
