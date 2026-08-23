import { backup, DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { sqlitePath } from "../src/server/database.ts";

const DEMO_START_AT = Date.parse("2026-01-01T00:00:00Z");

const adjectives = [
  "Amber",
  "Autumn",
  "Azure",
  "Brisk",
  "Bright",
  "Cedar",
  "Clear",
  "Copper",
  "Coral",
  "Dawn",
  "Distant",
  "Drift",
  "Ember",
  "Fabled",
  "Fern",
  "Golden",
  "Granite",
  "Harbor",
  "Hidden",
  "Indigo",
  "Ivy",
  "Jade",
  "Juniper",
  "Kindle",
  "Lunar",
  "Maple",
  "Meadow",
  "Misty",
  "Moonlit",
  "Moss",
  "Northern",
  "Ocean",
  "Olive",
  "Orchard",
  "Pebble",
  "Pine",
  "Prairie",
  "Quiet",
  "River",
  "Robin",
  "Saffron",
  "Sage",
  "Sienna",
  "Silver",
  "Solstice",
  "Spring",
  "Starry",
  "Stone",
  "Summer",
  "Sunny",
  "Tidal",
  "Velvet",
  "Verdant",
  "Violet",
  "Warm",
  "Willow",
  "Windy",
  "Winter",
  "Woodland",
  "Woven",
  "Yellow",
  "Zephyr",
];

const animals = [
  "Badger",
  "Beaver",
  "Bison",
  "Crane",
  "Dolphin",
  "Falcon",
  "Finch",
  "Fox",
  "Heron",
  "Kestrel",
  "Lark",
  "Lynx",
  "Marten",
  "Narwhal",
  "Otter",
  "Panda",
  "Puffin",
  "Quail",
  "Raven",
  "Robin",
  "Sparrow",
  "Swan",
  "Tern",
  "Wren",
  "Yak",
  "Zebra",
  "Alpaca",
  "Antelope",
  "Bluebird",
  "Bobcat",
  "Caribou",
  "Cormorant",
  "Dove",
  "Egret",
  "Fawn",
  "Gecko",
  "Gull",
  "Hare",
  "Ibis",
  "Jaguar",
  "Koala",
  "Lemur",
  "Manatee",
  "Mink",
  "Newt",
  "Ocelot",
  "Oriole",
  "Pelican",
  "Plover",
  "Raccoon",
  "Seal",
  "Shrew",
  "Skylark",
  "Stoat",
  "Tapir",
  "Toucan",
  "Viper",
  "Walrus",
  "Weasel",
  "Woodpecker",
  "Wombat",
];

const places = [
  "Bay",
  "Bridge",
  "Canyon",
  "Cove",
  "Crossing",
  "Delta",
  "Field",
  "Forest",
  "Garden",
  "Grove",
  "Harbor",
  "Heath",
  "Hill",
  "Hollow",
  "Island",
  "Lagoon",
  "Lantern",
  "Marsh",
  "Meadow",
  "Orchard",
  "Pass",
  "Path",
  "Peak",
  "Pond",
  "Ridge",
  "River",
  "Shore",
  "Spring",
  "Summit",
  "Vale",
  "Vista",
  "Woods",
  "Brook",
  "Cliff",
  "Dune",
  "Falls",
  "Glade",
  "Haven",
  "Inlet",
  "Knoll",
  "Landing",
  "Lowland",
  "Mill",
  "Moor",
  "Point",
  "Prairie",
  "Reach",
  "Rookery",
  "Run",
  "Sanctuary",
  "Sands",
  "Stone",
  "Terrace",
  "Thicket",
  "Trail",
  "Village",
  "Waterfall",
  "Wetland",
  "Wilds",
  "Windmill",
  "Yard",
  "Zenith",
];

type Options = {
  output: string;
};

function usage(): never {
  throw new Error(
    "Usage: deno task demo:db:create -- --output <path-to-new-demo.sqlite>",
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

function normalizePathKey(value: string) {
  const normalized = value.replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function createPathRedactor() {
  const aliases = new Map<string, string>();
  const usedAliases = new Set<string>();
  return (value: string) => {
    const key = normalizePathKey(value);
    const existing = aliases.get(key);
    if (existing !== undefined) return existing;

    let alias: string;
    do {
      alias = `~/${adjectives[randomIndex(adjectives.length)].toLowerCase()}-${
        animals[randomIndex(animals.length)].toLowerCase()
      }`;
    } while (usedAliases.has(alias));
    usedAliases.add(alias);
    aliases.set(key, alias);
    return alias;
  };
}

function removeIfExists(path: string) {
  try {
    Deno.removeSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function tableCount(db: DatabaseSync, table: string) {
  return Number(
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count,
  );
}

function retainYearToDate(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM conversations WHERE updated_at < ?").run(
      DEMO_START_AT,
    );
    db.exec(`
      DELETE FROM source_sessions
      WHERE id NOT IN (
        SELECT source_session_id FROM conversation_branches
        WHERE source_session_id IS NOT NULL
      );
      DELETE FROM sources
      WHERE id NOT IN (SELECT source_id FROM source_sessions);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function redact(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON");
  // The copied file must not retain replaced preview bytes in SQLite free space.
  db.exec("PRAGMA secure_delete = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const redactPath = createPathRedactor();
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const sourceLocations = db.prepare(
      "SELECT id, location FROM sources",
    ).all() as Array<{ id: number; location: string }>;
    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const conversationWorkingDirectories = db.prepare(`
      SELECT id, working_directory
      FROM conversations
      WHERE working_directory IS NOT NULL
    `).all() as Array<{ id: number; working_directory: string }>;

    db.exec(`
      UPDATE sources
      SET label = 'Demo ' || harness;

      UPDATE source_sessions
      SET external_id = 'demo-artifact-' || id,
          artifact_path = NULL,
          generated_title = NULL;

      UPDATE title_generation_runs
      SET output_title = NULL,
          error = NULL;

      UPDATE artifact_import_projections
      SET source_checksum = 'demo-checksum-' || source_session_id,
          source_change_hint = NULL,
          dependency_digest = 'demo-dependency-' || source_session_id,
          last_error = NULL;

      UPDATE conversations
      SET external_id = 'demo-conversation-' || id,
          public_id = 'demo-conversation-' || id,
          agent = NULL;

      UPDATE conversation_turns
      SET source_turn_id = CASE
        WHEN source_turn_id IS NULL THEN NULL ELSE 'demo-turn-' || id
      END;

      UPDATE conversation_model_calls
      SET source_call_id = CASE
        WHEN source_call_id IS NULL THEN NULL ELSE 'demo-call-' || id
      END;

      UPDATE conversation_tool_events
      SET source_tool_id = CASE
        WHEN source_tool_id IS NULL THEN NULL ELSE 'demo-tool-' || id
      END,
          input_preview = CASE
            WHEN input_preview IS NULL THEN NULL
            ELSE printf(
              '[redacted %s input; %d characters]',
              name,
              COALESCE(input_original_length, length(input_preview))
            )
          END,
          output_preview = CASE
            WHEN output_preview IS NULL THEN NULL
            ELSE printf(
              '[redacted %s output; %d characters]',
              name,
              COALESCE(output_original_length, length(output_preview))
            )
          END;

      UPDATE conversation_entries
      SET stable_source_id = CASE
        WHEN stable_source_id IS NULL THEN NULL ELSE 'demo-entry-' || id
      END,
          content_preview = CASE
            WHEN content_preview IS NULL THEN NULL
            WHEN role = 'user' THEN printf(
              '[redacted user message; %d characters]',
              COALESCE(original_length, length(content_preview))
            )
            WHEN producer_model_call_id IS NOT NULL THEN printf(
              '[redacted model %s; %d characters]',
              CASE WHEN COALESCE(content_kind, kind) = 'reasoning'
                THEN 'reasoning' ELSE 'response' END,
              COALESCE(original_length, length(content_preview))
            )
            WHEN producer_tool_event_id IS NOT NULL THEN printf(
              '[redacted tool result; %d characters]',
              COALESCE(original_length, length(content_preview))
            )
            ELSE printf(
              '[redacted conversation content; %d characters]',
              COALESCE(original_length, length(content_preview))
            )
          END,
          content_hash = NULL,
          -- Detail hydration parses context-event metadata, so retain only a
          -- schema-valid sentinel rather than the source event payload.
          native_metadata_json = CASE
            WHEN kind = 'context-event' THEN '{"type":"redacted","sourceOrder":1}'
            ELSE NULL
          END;

      UPDATE conversation_branches
      SET external_id = 'demo-branch-' || id;

      UPDATE artifact_entry_occurrences
      SET source_entry_id = CASE
        WHEN source_entry_id IS NULL THEN NULL
        ELSE 'demo-entry-occurrence-' || source_session_id || '-' || entry_id
      END,
          evidence_json = NULL;

      UPDATE artifact_model_call_occurrences
      SET source_turn_id = CASE
        WHEN source_turn_id IS NULL THEN NULL
        ELSE 'demo-turn-occurrence-' || source_session_id || '-' || model_call_id
      END,
          source_call_id = CASE
            WHEN source_call_id IS NULL THEN NULL
            ELSE 'demo-call-occurrence-' || source_session_id || '-' || model_call_id
          END,
          evidence_json = NULL;

      -- Keep the numeric and model-setting materialization used by session
      -- lists, but remove fields that can contain source content or stale
      -- source-derived labels. Identity fields are rewritten below after the
      -- conversations themselves have been anonymized.
      UPDATE conversation_rollups
      SET summary_json = json_remove(
        summary_json,
        '$.turns', '$.subagents', '$.contextEvents', '$.agent',
        '$.sourcePath', '$.internalID', '$.subagentModelCalls',
        '$.cacheIssues'
      )
      WHERE summary_json IS NOT NULL;

      UPDATE source_artifact_identities
      SET identity_value = 'demo-identity-' || source_session_id || '-' || identity_namespace;

      UPDATE source_artifact_lineage AS lineage
      SET parent_identity_value = COALESCE((
        SELECT identity_value
        FROM source_artifact_identities AS identity
        WHERE identity.source_session_id = lineage.parent_source_session_id
          AND identity.identity_namespace = lineage.parent_identity_namespace
      ), 'demo-unresolved-identity-' || child_source_session_id || '-' || relationship_kind);
    `);

    const updateSourceLocation = db.prepare(
      "UPDATE sources SET location = ? WHERE id = ?",
    );
    for (const source of sourceLocations) {
      updateSourceLocation.run(redactPath(source.location), source.id);
    }

    const updateConversationWorkingDirectory = db.prepare(
      "UPDATE conversations SET working_directory = ? WHERE id = ?",
    );
    for (const conversation of conversationWorkingDirectories) {
      updateConversationWorkingDirectory.run(
        redactPath(conversation.working_directory),
        conversation.id,
      );
    }

    // SAFETY: The static SQL projection and migrated schema define this row contract.
    const conversationTitles = db.prepare(
      "SELECT id FROM conversations ORDER BY id",
    ).all() as Array<{ id: number }>;
    const updateConversationTitle = db.prepare(
      "UPDATE conversations SET title = ? WHERE id = ?",
    );
    const usedTitles = new Set<string>();
    for (const { id } of conversationTitles) {
      updateConversationTitle.run(`Demo ${generatedTitle(usedTitles)}`, id);
    }

    // Summary rows are disposable list projections, but they carry the
    // requested thinking level. Preserve that safe analytics data while making
    // the projection's copied identity fields agree with the redacted rows.
    db.exec(`
      UPDATE conversation_rollups AS rollup
      SET summary_json = json_set(
        summary_json,
        '$.id', (
          SELECT public_id FROM conversations
          WHERE id = rollup.conversation_id
        ),
        '$.title', (
          SELECT title FROM conversations
          WHERE id = rollup.conversation_id
        )
      )
      WHERE summary_json IS NOT NULL;

      UPDATE conversation_rollups AS rollup
      SET summary_json = CASE
        WHEN (
          SELECT working_directory FROM conversations
          WHERE id = rollup.conversation_id
        ) IS NULL THEN json_remove(summary_json, '$.workingDirectory')
        ELSE json_set(
          summary_json,
          '$.workingDirectory', (
            SELECT working_directory FROM conversations
            WHERE id = rollup.conversation_id
          )
        )
      END
      WHERE summary_json IS NOT NULL;
    `);

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
      `Could not compact demo database: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
}

function audit(db: DatabaseSync) {
  const checks = [
    ["sources", `location NOT GLOB '~/*' OR label NOT GLOB 'Demo *'`],
    [
      "source_sessions",
      `external_id NOT GLOB 'demo-artifact-*'
        OR artifact_path IS NOT NULL
        OR generated_title IS NOT NULL`,
    ],
    [
      "title_generation_runs",
      `output_title IS NOT NULL OR error IS NOT NULL`,
    ],
    [
      "artifact_import_projections",
      `source_checksum NOT GLOB 'demo-checksum-*'
        OR source_change_hint IS NOT NULL
        OR dependency_digest NOT GLOB 'demo-dependency-*'
        OR last_error IS NOT NULL`,
    ],
    [
      "conversations",
      `external_id NOT GLOB 'demo-conversation-*'
        OR public_id NOT GLOB 'demo-conversation-*'
        OR title NOT GLOB 'Demo *'
        OR agent IS NOT NULL
        OR (working_directory IS NOT NULL AND working_directory NOT GLOB '~/*')`,
    ],
    [
      "conversation_turns",
      `source_turn_id IS NOT NULL AND source_turn_id NOT GLOB 'demo-turn-*'`,
    ],
    [
      "conversation_model_calls",
      `source_call_id IS NOT NULL AND source_call_id NOT GLOB 'demo-call-*'`,
    ],
    [
      "conversation_tool_events",
      `(source_tool_id IS NOT NULL AND source_tool_id NOT GLOB 'demo-tool-*')
        OR (input_preview IS NOT NULL
          AND input_preview NOT LIKE '[redacted % input; % characters]')
        OR (output_preview IS NOT NULL
          AND output_preview NOT LIKE '[redacted % output; % characters]')`,
    ],
    [
      "conversation_entries",
      `(stable_source_id IS NOT NULL AND stable_source_id NOT GLOB 'demo-entry-*')
        OR (content_preview IS NOT NULL
          AND content_preview NOT LIKE '[redacted %; % characters]')
        OR content_hash IS NOT NULL
        OR (kind = 'context-event'
          AND native_metadata_json IS NOT '{"type":"redacted","sourceOrder":1}')
        OR (kind <> 'context-event' AND native_metadata_json IS NOT NULL)`,
    ],
    ["conversation_branches", "external_id NOT GLOB 'demo-branch-*'"],
    [
      "artifact_entry_occurrences",
      `(source_entry_id IS NOT NULL
          AND source_entry_id NOT GLOB 'demo-entry-occurrence-*')
        OR evidence_json IS NOT NULL`,
    ],
    [
      "artifact_model_call_occurrences",
      `(source_turn_id IS NOT NULL
          AND source_turn_id NOT GLOB 'demo-turn-occurrence-*')
        OR (source_call_id IS NOT NULL
          AND source_call_id NOT GLOB 'demo-call-occurrence-*')
        OR evidence_json IS NOT NULL`,
    ],
    [
      "conversation_rollups",
      `summary_json IS NOT NULL AND (
        json_type(summary_json, '$.turns') IS NOT NULL
        OR json_type(summary_json, '$.subagents') IS NOT NULL
        OR json_type(summary_json, '$.contextEvents') IS NOT NULL
        OR json_type(summary_json, '$.agent') IS NOT NULL
        OR json_type(summary_json, '$.sourcePath') IS NOT NULL
        OR json_type(summary_json, '$.internalID') IS NOT NULL
        OR json_type(summary_json, '$.subagentModelCalls') IS NOT NULL
        OR json_type(summary_json, '$.cacheIssues') IS NOT NULL
        OR json_extract(summary_json, '$.id') IS NOT (
          SELECT public_id FROM conversations
          WHERE id = conversation_rollups.conversation_id
        )
        OR json_extract(summary_json, '$.title') IS NOT (
          SELECT title FROM conversations
          WHERE id = conversation_rollups.conversation_id
        )
        OR json_extract(summary_json, '$.workingDirectory') IS NOT (
          SELECT working_directory FROM conversations
          WHERE id = conversation_rollups.conversation_id
        )
      )`,
    ],
    [
      "source_artifact_identities",
      "identity_value NOT GLOB 'demo-identity-*'",
    ],
    [
      "source_artifact_lineage",
      "parent_identity_value NOT GLOB 'demo-*'",
    ],
  ] as const;

  const failures = checks.map(([table, predicate]) => ({
    table,
    count: Number(
      // SAFETY: The static SQL projection and migrated schema define this row contract.
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
        .get() as { count: number }).count,
    ),
  })).filter(({ count }) => count > 0);
  if (failures.length > 0) {
    throw new Error(
      `Demo database redaction audit failed: ${
        failures.map(({ table, count }) => `${table} (${count})`).join(", ")
      }`,
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
    retainYearToDate(demo);
    redact(demo);
    audit(demo);
    sessions = tableCount(demo, "conversations");
    toolEvents = tableCount(demo, "conversation_tool_events");
  } finally {
    demo.close();
  }
  // Updates leave old previews in free pages. VACUUM rebuilds the file from
  // current values only, removing recoverable remnants and shrinking it.
  await compact(outputPath);

  console.log(`Created demo database: ${outputPath}`);
  console.log("Copied SQLite database snapshot.");
  console.log(
    `Compacted from ${copiedBytes.toLocaleString()} to ${
      Deno.statSync(outputPath).size.toLocaleString()
    } bytes.`,
  );
  console.log(
    `Redacted ${sessions} conversations and ${toolEvents} tool events.`,
  );
} catch (error) {
  if (outputCreated) {
    removeIfExists(outputPath);
    removeIfExists(`${outputPath}-shm`);
    removeIfExists(`${outputPath}-wal`);
  }
  throw error;
}
