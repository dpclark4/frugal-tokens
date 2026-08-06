import { strictEqual } from "node:assert/strict";
import { ConversationCompatibilityRepository } from "../src/server/conversationCompatibilityRepository.ts";
import { openArchiveDatabase, sqlitePath } from "../src/server/database.ts";
import { SessionRepository } from "../src/server/sessionRepository.ts";

type Harness = "opencode" | "claude-code" | "pi" | "codex";

const endpointNames = [
  "list",
  "detail",
  "usage-calls",
  "tools",
  "cache",
  "cost",
  "overview",
  "session-shape",
  "usage-rollups",
  "subagent-usage",
  "initial-input",
] as const;
type Endpoint = typeof endpointNames[number];

const internalKeys = new Set([
  "internalID",
  "modelCallID",
  "previousModelCallID",
  "turnRowID",
  "rootSessionID",
  "subagentSessionID",
]);

function normalized(value: unknown, ignored = internalKeys): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalized(item, ignored));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined || ignored.has(key)
          ? []
          : [[key, normalized(item, ignored)]]
      ),
    );
  }
  return value;
}

function compare(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Number.isFinite(actual) && Number.isFinite(expected)) {
      const tolerance = 1e-12 *
        Math.max(1, Math.abs(actual), Math.abs(expected));
      if (Math.abs(actual - expected) <= tolerance) return;
    }
    strictEqual(actual, expected, path);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    strictEqual(actual.length, expected.length, `${path}.length`);
    actual.forEach((item, index) =>
      compare(item, expected[index], `${path}[${index}]`)
    );
    return;
  }
  if (
    actual !== null && expected !== null && typeof actual === "object" &&
    typeof expected === "object" && !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    compare(actualKeys, expectedKeys, `${path}.keys`);
    for (const key of actualKeys) {
      compare(actualRecord[key], expectedRecord[key], `${path}.${key}`);
    }
    return;
  }
  strictEqual(actual, expected, path);
}

function semanticSort(values: unknown[]) {
  return values.toSorted((a, b) =>
    JSON.stringify(normalized(a)).localeCompare(JSON.stringify(normalized(b)))
  );
}

function assertParity(
  endpoint: Endpoint,
  actual: unknown,
  expected: unknown,
  extraIgnored: string[] = [],
) {
  const ignored = new Set([...internalKeys, ...extraIgnored]);
  compare(normalized(actual, ignored), normalized(expected, ignored), endpoint);
}

function argument(name: string) {
  const prefix = `--${name}=`;
  return Deno.args.find((value) => value.startsWith(prefix))?.slice(
    prefix.length,
  );
}

const harness = (argument("harness") ?? "opencode") as Harness;
if (!["opencode", "claude-code", "pi", "codex"].includes(harness)) {
  throw new Error(`Unknown harness: ${harness}`);
}
const requested = argument("endpoint") ?? "all";
const endpoints: Endpoint[] = requested === "all"
  ? [...endpointNames]
  : requested.split(",").map((value) => {
    if (!endpointNames.includes(value as Endpoint)) {
      throw new Error(`Unknown endpoint: ${value}`);
    }
    return value as Endpoint;
  });
const databaseURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (databaseURL === undefined) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is required");
}

const db = openArchiveDatabase(sqlitePath(databaseURL));
const legacy = new SessionRepository(db);
const conversations = new ConversationCompatibilityRepository(db);
const startedAt = 0;

try {
  for (const endpoint of endpoints) {
    const began = performance.now();
    switch (endpoint) {
      case "list": {
        assertParity(
          endpoint,
          conversations.listSessions(1, 1_000_000, harness),
          legacy.listSessions(1, 1_000_000, harness),
        );
        break;
      }
      case "detail": {
        const sessions = legacy.listSessions(1, 1_000_000, harness).items;
        for (const [index, session] of sessions.entries()) {
          try {
            assertParity(
              endpoint,
              conversations.getSession(harness, session.id),
              legacy.getSession(harness, session.id),
            );
          } catch (error) {
            throw new Error(
              `${endpoint} failed for ${harness}:${session.id} (${
                index + 1
              }/${sessions.length})`,
              { cause: error },
            );
          }
        }
        break;
      }
      case "usage-calls":
        assertParity(
          endpoint,
          conversations.listUsageCalls(undefined, harness),
          legacy.listUsageCalls(undefined, harness),
          ["computedCost"],
        );
        break;
      case "tools":
        assertParity(
          endpoint,
          semanticSort(
            conversations.listToolCalls(0, Number.MAX_SAFE_INTEGER, harness),
          ),
          semanticSort(
            legacy.listToolCalls(0, Number.MAX_SAFE_INTEGER, harness),
          ),
        );
        break;
      case "cache":
        assertParity(
          endpoint,
          conversations.listCacheMisses(undefined, harness),
          legacy.listCacheMisses(undefined, harness),
          ["turnID"],
        );
        break;
      case "cost":
        assertParity(
          endpoint,
          conversations.summarizeModelCallCosts(startedAt, harness),
          legacy.summarizeModelCallCosts(startedAt, harness),
        );
        break;
      case "overview":
        assertParity(
          endpoint,
          conversations.listOverviewRollups(startedAt, harness),
          legacy.listOverviewRollups(startedAt, harness),
        );
        break;
      case "session-shape":
        assertParity(
          endpoint,
          conversations.listSessionShapeRollups(startedAt, harness),
          legacy.listSessionShapeRollups(startedAt, harness),
        );
        break;
      case "usage-rollups":
        assertParity(
          endpoint,
          conversations.listUsageRollups(undefined, harness),
          legacy.listUsageRollups(undefined, harness),
        );
        break;
      case "subagent-usage":
        assertParity(
          endpoint,
          conversations.listSubagentUsage(undefined, harness),
          legacy.listSubagentUsage(undefined, harness),
        );
        break;
      case "initial-input":
        assertParity(
          endpoint,
          {
            samples: conversations.listInitialInputSamples(undefined, harness),
            distribution: conversations.initialInputDistribution(
              startedAt,
              harness,
            ),
          },
          {
            samples: legacy.listInitialInputSamples(undefined, harness),
            distribution: legacy.initialInputDistribution(startedAt, harness),
          },
        );
        break;
    }
    console.log(
      `[parity] harness=${harness} endpoint=${endpoint} status=pass duration_ms=${
        (performance.now() - began).toFixed(1)
      }`,
    );
  }
} finally {
  db.close();
}
