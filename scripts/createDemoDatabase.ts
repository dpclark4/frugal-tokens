import { backup, DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { sqlitePath } from "../src/server/database.ts";

const REDACTED = "[redacted]";
const DEMO_EPOCH = Date.UTC(2024, 0, 1);

const adjectives = [
  "Amber", "Autumn", "Azure", "Brisk", "Bright", "Cedar", "Clear",
  "Copper", "Coral", "Dawn", "Distant", "Drift", "Ember", "Fabled",
  "Fern", "Golden", "Granite", "Harbor", "Hidden", "Indigo", "Ivy",
  "Jade", "Juniper", "Kindle", "Lunar", "Maple", "Meadow", "Misty",
  "Moonlit", "Moss", "Northern", "Ocean", "Olive", "Orchard", "Pebble",
  "Pine", "Prairie", "Quiet", "River", "Robin", "Saffron", "Sage",
  "Sienna", "Silver", "Solstice", "Spring", "Starry", "Stone", "Summer",
  "Sunny", "Tidal", "Velvet", "Verdant", "Violet", "Warm", "Willow",
  "Windy", "Winter", "Woodland", "Woven", "Yellow", "Zephyr",
];

const animals = [
  "Badger", "Beaver", "Bison", "Crane", "Dolphin", "Falcon", "Finch",
  "Fox", "Heron", "Kestrel", "Lark", "Lynx", "Marten", "Narwhal",
  "Otter", "Panda", "Puffin", "Quail", "Raven", "Robin", "Sparrow",
  "Swan", "Tern", "Wren", "Yak", "Zebra", "Alpaca", "Antelope",
  "Bluebird", "Bobcat", "Caribou", "Cormorant", "Dove", "Egret", "Fawn",
  "Gecko", "Gull", "Hare", "Ibis", "Jaguar", "Koala", "Lemur", "Manatee",
  "Mink", "Newt", "Ocelot", "Oriole", "Pelican", "Plover", "Raccoon",
  "Seal", "Shrew", "Skylark", "Stoat", "Tapir", "Toucan", "Viper",
  "Walrus", "Weasel", "Woodpecker", "Wombat",
];

const places = [
  "Bay", "Bridge", "Canyon", "Cove", "Crossing", "Delta", "Field",
  "Forest", "Garden", "Grove", "Harbor", "Heath", "Hill", "Hollow",
  "Island", "Lagoon", "Lantern", "Marsh", "Meadow", "Orchard", "Pass",
  "Path", "Peak", "Pond", "Ridge", "River", "Shore", "Spring", "Summit",
  "Vale", "Vista", "Woods", "Brook", "Cliff", "Dune", "Falls", "Glade",
  "Haven", "Inlet", "Knoll", "Landing", "Lowland", "Mill", "Moor",
  "Point", "Prairie", "Reach", "Rookery", "Run", "Sanctuary", "Sands",
  "Stone", "Terrace", "Thicket", "Trail", "Village", "Waterfall", "Wetland",
  "Wilds", "Windmill", "Yard", "Zenith",
];

type Options = {
  output: string;
};

function usage(): never {
  throw new Error(
    "Usage: deno task demo:database -- --output <path-to-new-demo.db>",
  );
}

function parseOptions(args: string[]): Options {
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--output") {
      output = args[++index];
      if (!output) usage();
      continue;
    }
    usage();
  }
  if (!output) usage();
  return { output };
}

function randomIndex(length: number) {
  const upperBound = Math.floor(0x1_0000_0000 / length) * length;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= upperBound);
  return value[0] % length;
}

function generatedTitle(used: Set<string>) {
  while (true) {
    const title = [
      adjectives[randomIndex(adjectives.length)],
      animals[randomIndex(animals.length)],
      places[randomIndex(places.length)],
    ].join(" ");
    if (!used.has(title)) {
      used.add(title);
      return title;
    }
  }
}

function removeIfExists(path: string) {
  try {
    Deno.removeSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function tableCount(db: DatabaseSync, table: string) {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}

function shiftTimestamps(db: DatabaseSync) {
  const timestampColumns = [
    ["sources", "created_at"],
    ["source_sessions", "first_seen_at"],
    ["source_sessions", "last_seen_at"],
    ["source_sessions", "imported_at"],
    ["source_sessions", "source_modified_at"],
    ["sessions", "updated_at"],
    ["sessions", "started_at"],
    ["sessions", "ended_at"],
    ["turns", "started_at"],
    ["model_calls", "started_at"],
    ["model_calls", "completed_at"],
    ["tool_events", "started_at"],
    ["tool_events", "completed_at"],
    ["context_events", "occurred_at"],
  ] as const;
  const minimumQuery = timestampColumns.map(([table, column]) =>
    `SELECT ${column} AS value FROM ${table}`
  ).join(" UNION ALL ");
  const row = db.prepare(`SELECT MIN(value) AS value FROM (${minimumQuery})`)
    .get() as { value: number | null };
  if (row.value === null) return;

  const offset = DEMO_EPOCH - row.value;
  for (const [table, column] of timestampColumns) {
    db.prepare(`
      UPDATE ${table}
      SET ${column} = CASE
        WHEN ${column} IS NULL THEN NULL
        ELSE ${column} + ?
      END
    `).run(offset);
  }
}

function redact(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON");
  // The copied file must not retain replaced preview bytes in SQLite free space.
  db.exec("PRAGMA secure_delete = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      UPDATE sources
      SET label = 'Demo ' || harness,
          location = 'demo-source-' || id;

      UPDATE source_sessions
      SET external_id = 'demo-session-' || id,
          public_id = 'demo-session-' || id,
          artifact_path = NULL,
          checksum = NULL,
          change_hint = NULL,
          last_error = NULL;

      UPDATE sessions SET agent = NULL;

      UPDATE turn_inputs
      SET preview = CASE WHEN preview IS NULL THEN NULL ELSE '${REDACTED}' END,
          content_hash = NULL;

      UPDATE call_content
      SET preview = CASE WHEN preview IS NULL THEN NULL ELSE '${REDACTED}' END,
          content_hash = NULL;

      UPDATE model_calls SET source_call_id = NULL;

      UPDATE tool_events
      SET source_tool_id = NULL,
          input_preview = CASE
            WHEN input_preview IS NULL THEN NULL ELSE '${REDACTED}'
          END,
          output_preview = CASE
            WHEN output_preview IS NULL THEN NULL ELSE '${REDACTED}'
          END;
    `);

    const titles = db.prepare(
      "SELECT source_session_id FROM sessions ORDER BY source_session_id",
    ).all() as Array<{ source_session_id: number }>;
    const updateTitle = db.prepare(
      "UPDATE sessions SET title = ? WHERE source_session_id = ?",
    );
    const usedTitles = new Set<string>();
    for (const { source_session_id: id } of titles) {
      updateTitle.run(generatedTitle(usedTitles), id);
    }

    shiftTimestamps(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function compact(path: string) {
  // Deno's node:sqlite build disables SQLite ATTACH, which VACUUM uses
  // internally. Run the locally installed SQLite CLI after closing the copy.
  const result = await new Deno.Command("sqlite3", {
    args: [path, "PRAGMA journal_mode = DELETE; VACUUM; PRAGMA optimize;"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Could not compact demo database: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

function audit(db: DatabaseSync) {
  const checks = [
    ["sources", `location NOT GLOB 'demo-source-*' OR label NOT GLOB 'Demo *'`],
    [
      "source_sessions",
      `external_id NOT GLOB 'demo-session-*'
        OR public_id NOT GLOB 'demo-session-*'
        OR artifact_path IS NOT NULL
        OR checksum IS NOT NULL
        OR change_hint IS NOT NULL
        OR last_error IS NOT NULL`,
    ],
    ["sessions", "title IS NULL OR title = '' OR agent IS NOT NULL"],
    [
      "turn_inputs",
      `content_hash IS NOT NULL
        OR (preview IS NOT NULL AND preview <> '${REDACTED}')`,
    ],
    [
      "call_content",
      `content_hash IS NOT NULL
        OR (preview IS NOT NULL AND preview <> '${REDACTED}')`,
    ],
    ["model_calls", "source_call_id IS NOT NULL"],
    [
      "tool_events",
      `source_tool_id IS NOT NULL
        OR (input_preview IS NOT NULL AND input_preview <> '${REDACTED}')
        OR (output_preview IS NOT NULL AND output_preview <> '${REDACTED}')`,
    ],
  ] as const;

  const failures = checks.map(([table, predicate]) => ({
    table,
    count: Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
      .get() as { count: number }).count),
  })).filter(({ count }) => count > 0);
  if (failures.length > 0) {
    throw new Error(
      `Demo database redaction audit failed: ${failures.map(({ table, count }) =>
        `${table} (${count})`
      ).join(", ")}`,
    );
  }
}

const options = parseOptions(Deno.args);
const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!databaseURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is not set");
}

const sourcePath = resolve(sqlitePath(databaseURL));
const outputPath = resolve(options.output);
if (sourcePath === outputPath) {
  throw new Error("The demo output must not replace the source archive");
}
try {
  Deno.statSync(outputPath);
  throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

Deno.mkdirSync(dirname(outputPath), { recursive: true });
let outputCreated = false;
try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    outputCreated = true;
    await backup(source, outputPath);
  } finally {
    source.close();
  }

  const copiedBytes = Deno.statSync(outputPath).size;
  const demo = new DatabaseSync(outputPath);
  let sessions = 0;
  let toolEvents = 0;
  try {
    redact(demo);
    audit(demo);
    sessions = tableCount(demo, "sessions");
    toolEvents = tableCount(demo, "tool_events");
  } finally {
    demo.close();
  }
  // Updates leave old previews in free pages. VACUUM rebuilds the file from
  // current values only, removing recoverable remnants and shrinking it.
  await compact(outputPath);

  console.log(`Created demo database: ${outputPath}`);
  console.log("Copied SQLite database snapshot.");
  console.log(
    `Compacted from ${copiedBytes.toLocaleString()} to ${Deno.statSync(outputPath).size.toLocaleString()} bytes.`,
  );
  console.log(`Redacted ${sessions} sessions and ${toolEvents} tool events.`);
} catch (error) {
  if (outputCreated) {
    removeIfExists(outputPath);
    removeIfExists(`${outputPath}-shm`);
    removeIfExists(`${outputPath}-wal`);
  }
  throw error;
}
