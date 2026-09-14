import { openArchiveDatabase, sqlitePath } from "../src/server/database.ts";
import { displayModelName } from "../src/shared/modelNames.ts";

const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const db = openArchiveDatabase(sqlitePath(databaseURL));
try {
  // SAFETY: The static SQL projection and migrated schema define this row contract.
  const rows = db.prepare(`
    SELECT conversation_id, summary_json
    FROM conversation_rollups
    WHERE summary_json IS NOT NULL
  `).all() as Array<{ conversation_id: number; summary_json: string }>;

  const update = db.prepare(`
    UPDATE conversation_rollups SET summary_json = json_set(summary_json, '$.displayModel', ?)
    WHERE conversation_id = ?
  `);

  let updated = 0;
  for (const row of rows) {
    // SAFETY: summary_json is only ever written by #materializeSummary,
    // which always serializes a sessionListItemSchema-shaped object.
    const summary = JSON.parse(row.summary_json) as { models?: string[] };
    const model = summary.models?.at(-1);
    if (model === undefined) continue;
    update.run(displayModelName(model), row.conversation_id);
    updated++;
  }

  console.log(
    `[backfill-display-model] rows=${rows.length} updated=${updated}`,
  );
} finally {
  db.close();
}
