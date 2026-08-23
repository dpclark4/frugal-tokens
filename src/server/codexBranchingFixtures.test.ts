import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  discoverCodexSessions,
  normalizeCodexSession,
} from "./codexRepository.ts";

type FixtureRecord = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    turn_id?: string;
    started_at?: number;
    forked_from_id?: string;
    call_id?: string;
    info?: { last_token_usage?: unknown };
    replacement_history?: Array<{ id?: string }>;
  };
};

type FixtureArtifact = {
  name: string;
  id: string;
  parentID?: string;
  records: FixtureRecord[];
  turns: string[];
};

function fixturePath(name: string) {
  return decodeURIComponent(
    new URL(`./fixtures/codex-branching/${name}/`, import.meta.url).pathname,
  );
}

function artifacts(name: string): FixtureArtifact[] {
  return [...Deno.readDirSync(fixturePath(name))]
    .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      // SAFETY: These checked-in JSONL fixtures follow the FixtureRecord event contract.
      const records = Deno.readTextFileSync(`${fixturePath(name)}${entry.name}`)
        .trim().split("\n").map((line) => JSON.parse(line) as FixtureRecord);
      const metadata = records.find((record) => record.type === "session_meta")
        ?.payload;
      if (!metadata?.id) throw new Error(`Missing fixture ID: ${entry.name}`);
      const fixture: FixtureArtifact = {
        name: entry.name,
        id: metadata.id,
        records,
        turns: records.filter((record) =>
          record.type === "event_msg" &&
          record.payload?.type === "task_started"
        ).map((record) => record.payload!.turn_id!),
      };
      if (metadata.forked_from_id) fixture.parentID = metadata.forked_from_id;
      return fixture;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function turnEvidence(artifact: FixtureArtifact, turnID: string) {
  const start = artifact.records.findIndex((record) =>
    record.payload?.type === "task_started" &&
    record.payload.turn_id === turnID
  );
  const end = artifact.records.findIndex((record, index) =>
    index > start && record.payload?.type === "task_started"
  );
  const records = artifact.records.slice(
    start,
    end === -1 ? artifact.records.length : end,
  );
  return {
    outerTimestamp: records[0].timestamp,
    startedAt: records[0].payload?.started_at,
    responseID: records.find((record) =>
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload.id?.startsWith("response-")
    )?.payload?.id,
    usage: records.find((record) =>
      record.payload?.type === "token_count" &&
      record.payload.info?.last_token_usage
    )?.payload?.info?.last_token_usage,
  };
}

Deno.test("sanitized Codex sibling forks encode the branching contract", () => {
  const fixture = artifacts("sibling-forks");
  strictEqual(fixture.length, 3);
  strictEqual(fixture.filter((artifact) => !artifact.parentID).length, 1);
  strictEqual(fixture.filter((artifact) => artifact.parentID).length, 2);
  strictEqual(new Set(fixture.map((artifact) => artifact.id)).size, 3);

  const occurrences = fixture.flatMap((artifact) => artifact.turns);
  strictEqual(occurrences.length, 13);
  strictEqual(new Set(occurrences).size, 7);
  deepStrictEqual(
    fixture.map((artifact) => artifact.turns.length).sort(),
    [4, 4, 5],
  );

  for (const turnID of ["turn-shared-1", "turn-shared-2"]) {
    const evidence = fixture.map((artifact) => turnEvidence(artifact, turnID));
    strictEqual(new Set(evidence.map((item) => item.outerTimestamp)).size, 3);
    strictEqual(new Set(evidence.map((item) => item.startedAt)).size, 1);
    strictEqual(new Set(evidence.map((item) => item.responseID)).size, 1);
    strictEqual(
      new Set(evidence.map((item) => JSON.stringify(item.usage))).size,
      1,
    );
  }

  strictEqual(
    fixture.flatMap((artifact) => artifact.records).filter((record) =>
      record.payload?.call_id === "tool-original-3"
    ).length,
    4,
  );
  strictEqual(
    fixture.flatMap((artifact) => artifact.records).filter((record) =>
      record.payload?.replacement_history?.some((item) =>
        item.id === "checkpoint-original-1"
      )
    ).length,
    2,
  );
});

Deno.test("Codex artifacts normalize independently before family materialization", () => {
  const candidates = discoverCodexSessions(fixturePath("sibling-forks"));
  const sessions = candidates.map((candidate) =>
    normalizeCodexSession(
      candidate,
      Deno.readTextFileSync(candidate.path),
    ).summary
  );
  strictEqual(sessions.length, 3);
  strictEqual(
    sessions.reduce((total, session) => total + session.userTurns, 0),
    13,
  );
  strictEqual(
    sessions.reduce((total, session) => total + session.modelCalls, 0),
    13,
  );
});

Deno.test("sanitized Codex nested forks preserve recursive ancestry", () => {
  const fixture = artifacts("nested-fork");
  strictEqual(fixture.length, 3);
  const byID = new Map(fixture.map((artifact) => [artifact.id, artifact]));
  const root = fixture.find((artifact) => !artifact.parentID)!;
  const child = fixture.find((artifact) => artifact.parentID === root.id)!;
  const grandchild = fixture.find((artifact) =>
    artifact.parentID === child.id
  )!;

  strictEqual(byID.size, 3);
  deepStrictEqual(root.turns, ["turn-nested-root-1"]);
  deepStrictEqual(child.turns, [
    "turn-nested-root-1",
    "turn-nested-child-2",
  ]);
  deepStrictEqual(grandchild.turns, [
    "turn-nested-root-1",
    "turn-nested-child-2",
    "turn-nested-grandchild-3",
  ]);
  strictEqual(fixture.flatMap((artifact) => artifact.turns).length, 6);
  strictEqual(
    new Set(fixture.flatMap((artifact) => artifact.turns)).size,
    3,
  );
});
