import { deepStrictEqual, strictEqual } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { demoContextMetadataSql } from "./demoContextMetadata.ts";

Deno.test("demo context metadata preserves compaction attribution without private content", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events (native_metadata_json TEXT)");
    const insert = db.prepare("INSERT INTO events VALUES (?)");
    insert.run(JSON.stringify({
      type: "compaction",
      sourceOrder: 42,
      affectedCall: { turn: 8, call: 1, private: "secret" },
      compaction: { summary: "private summary", files: ["/private/path"] },
      occurredAt: 123,
    }));
    insert.run(JSON.stringify({ type: "private-event", sourceOrder: 7 }));
    insert.run(JSON.stringify({
      type: "compaction",
      sourceOrder: "private",
      affectedCall: { turn: "private", call: 1 },
    }));
    db.exec(
      `UPDATE events SET native_metadata_json = ${demoContextMetadataSql}`,
    );
    const rows = db.prepare("SELECT native_metadata_json FROM events").all();
    deepStrictEqual(
      rows.map((row) => JSON.parse(String(row.native_metadata_json))),
      [
        {
          type: "compaction",
          sourceOrder: 42,
          affectedCall: { turn: 8, call: 1 },
        },
        { type: "redacted", sourceOrder: 7 },
        { type: "compaction", sourceOrder: 1 },
      ],
    );
    // The demo audit uses the same allowlist as an idempotent validation.
    strictEqual(
      db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE native_metadata_json IS NOT ${demoContextMetadataSql}`).get()
        ?.count,
      0,
    );
  } finally {
    db.close();
  }
});
