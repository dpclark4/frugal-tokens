import { type Context, Hono } from "hono";
import { join, relative, resolve } from "node:path";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { createMiddleware } from "hono/factory";
import { createResponseCache } from "./responseCache.ts";
import { priceSessionDetail } from "./pricing.ts";
import { analyzeSessionCache, CACHE_TTL_1H_MS } from "./cacheAnalysis.ts";
import type { SessionSummary } from "../shared/sessionSchemas.ts";
import {
  parseSessionMissFilters,
  sessionMissFilterSchema,
} from "../shared/sessionSchemas.ts";
import { aggregateUsageRollups } from "./usageAnalytics.ts";
import { aggregateTtlMisses } from "./ttlMissAnalytics.ts";
import { aggregateToolCalls } from "./toolCallAnalytics.ts";
import {
  aggregatePerformance,
  PERFORMANCE_MODELS,
  PERFORMANCE_RANGE_DAYS,
} from "./performanceAnalytics.ts";
import {
  aggregateOverviewRollups,
  ROTATION_INACTIVITY_MINUTES,
} from "./overviewAnalytics.ts";
import { aggregateActivityOverview } from "./activityOverview.ts";
import { workRhythmRange } from "./workRhythm.ts";
import { aggregateSessionShape } from "./sessionShapeAnalytics.ts";
import { expandHomePath, openArchiveDatabase, sqlitePath } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { ConversationCompatibilityRepository } from "./conversationCompatibilityRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";
import { SessionReadRepository } from "./sessionReadRepository.ts";
import { syncPiSessions } from "./piImporter.ts";
import { syncCodexSessions } from "./codexImporter.ts";
import { syncClaudeCodeSessions } from "./claudeCodeImporter.ts";
import { syncOpenCodeSessions } from "./openCodeImporter.ts";
import { enrichSessionSummary } from "./sessionSummaryEnrichment.ts";
import { syncCursorAgentSessions } from "./cursorAgentRepository.ts";
import {
  generateMissingSessionTitles,
  setTitleGenerationEnabled,
  titleGenerationEnabled,
} from "./titleGeneration.ts";

function configuredPath<T>(
  harness: string,
  variable: string,
  type: "file" | "directory",
  create: (path: string) => T,
): T | undefined {
  const configured = Deno.env.get(variable);
  if (!configured) {
    console.warn(`[config] ${harness} disabled: ${variable} is not set`);
    return undefined;
  }
  const path = expandHomePath(configured);
  try {
    const stat = Deno.statSync(path);
    if (type === "file" ? !stat.isFile : !stat.isDirectory) {
      console.warn(`[config] ${harness} disabled: ${path} is not a ${type}`);
      return undefined;
    }
  } catch (error) {
    console.warn(
      `[config] ${harness} disabled: cannot access ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return undefined;
  }
  return create(path);
}
const openCodePath = configuredPath(
  "opencode",
  "OPENCODE_DB_PATH",
  "file",
  (path) => path,
);
const claudeDirectory = configuredPath(
  "claude-code",
  "CLAUDE_CODE_PROJECT_PATH",
  "directory",
  (path) => path,
);
const piDirectory = configuredPath(
  "pi",
  "PI_SESSION_DIR",
  "directory",
  (path) => path,
);
const codexDirectory = configuredPath(
  "codex",
  "CODEX_SESSION_DIR",
  "directory",
  (path) => path,
);
const cursorDirectory = configuredPath(
  "cursor",
  "CURSOR_CHATS_PATH",
  "directory",
  (path) => path,
);
const cursorCapturePath = (() => {
  const explicit = Deno.env.get("CURSOR_SSE_CAPTURE_PATH");
  if (explicit) return expandHomePath(explicit);
  const configuredDirectory = Deno.env.get("CURSOR_SSE_CAPTURE_DIR");
  if (configuredDirectory) {
    return join(expandHomePath(configuredDirectory), "events.jsonl");
  }
  const persistent = expandHomePath(
    "~/.local/share/frugal-tokens/cursor-capture/events.jsonl",
  );
  try {
    if (Deno.statSync(persistent).isFile) return persistent;
  } catch {
    // Fall back to the capture addon's historical location.
  }
  return "/tmp/frugal-tokens-cursor-sse/events.jsonl";
})();
const archiveURL = Deno.env.get("FRUGAL_TOKENS_DATABASE_URL");
if (!archiveURL) {
  throw new Error("FRUGAL_TOKENS_DATABASE_URL is required");
}
const archiveDatabase = openArchiveDatabase(sqlitePath(archiveURL));
const archiveRepository = new SessionRepository(archiveDatabase);
const conversationProjectionRepository = new ConversationProjectionRepository(
  archiveDatabase,
);
const conversationCompatibilityRepository =
  new ConversationCompatibilityRepository(archiveDatabase);
const supportedHarnesses: SessionSummary["harness"][] = [
  "opencode",
  "claude-code",
  "pi",
  "codex",
  "cursor",
];
const configuredConversationHarnesses = Deno.env.get(
  "FRUGAL_TOKENS_CONVERSATION_READ_HARNESSES",
);
const desiredConversationReadHarnesses = new Set<SessionSummary["harness"]>(
  configuredConversationHarnesses === undefined
    ? supportedHarnesses
    : configuredConversationHarnesses.trim() === ""
    ? []
    : configuredConversationHarnesses.split(",").map((value) => value.trim())
      .filter((value): value is SessionSummary["harness"] => {
        if (!supportedHarnesses.includes(value as SessionSummary["harness"])) {
          throw new Error(
            `Invalid conversation read harness: ${value}`,
          );
        }
        return true;
      }),
);
const activeConversationReadHarnesses = new Set<SessionSummary["harness"]>();
const readRepository = new SessionReadRepository(
  archiveRepository,
  conversationCompatibilityRepository,
  activeConversationReadHarnesses,
);
const harnesses = ["opencode", "claude-code", "pi", "codex", "cursor"] as const;

function isHarness(value: string): value is SessionSummary["harness"] {
  return (harnesses as readonly string[]).includes(value);
}

function isHarnessFilter(value: string) {
  return value === "all" || isHarness(value);
}

const syncIntervalSeconds = (() => {
  const value = Deno.env.get("FRUGAL_TOKENS_SYNC_INTERVAL_SECONDS");
  if (value === undefined || value === "0") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      "FRUGAL_TOKENS_SYNC_INTERVAL_SECONDS must be a positive integer or 0",
    );
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > 2_147_483) {
    throw new Error(
      "FRUGAL_TOKENS_SYNC_INTERVAL_SECONDS is too large",
    );
  }
  return seconds;
})();

const apiResponseCache = createResponseCache();

type SyncResult = {
  discovered: number;
  imported: number;
  skipped: number;
  failed: number;
  timings?: Record<string, number>;
  projectionResults?: Record<string, {
    imported: number;
    skipped: number;
    failed: number;
  }>;
};

async function runSync(
  harness: SessionSummary["harness"],
  sync: () => SyncResult | Promise<SyncResult>,
) {
  const startedAt = performance.now();
  const result = await sync();
  const phases = result.timings
    ? ` ${
      Object.entries(result.timings).map(([name, duration]) =>
        `${name}=${duration.toFixed(1)}ms`
      ).join(" ")
    }`
    : "";
  console.info(
    `[sync] harness=${harness} discovered=${result.discovered} imported=${result.imported} skipped=${result.skipped} failed=${result.failed} duration=${
      (performance.now() - startedAt).toFixed(1)
    }ms${phases}`,
  );
  if (desiredConversationReadHarnesses.has(harness)) {
    const projection = result.projectionResults?.["conversation-v2"];
    if (projection !== undefined && projection.failed === 0) {
      activeConversationReadHarnesses.add(harness);
      console.info(`[reads] harness=${harness} provider=conversation-v2`);
    } else {
      activeConversationReadHarnesses.delete(harness);
      console.warn(
        `[reads] harness=${harness} provider=legacy reason=conversation-v2-sync-failed`,
      );
    }
  }
  return result;
}

async function syncSources() {
  const startedAt = performance.now();
  if (openCodePath) {
    await runSync(
      "opencode",
      () =>
        syncOpenCodeSessions(
          openCodePath,
          archiveRepository,
          conversationProjectionRepository,
        ),
    );
  }
  if (claudeDirectory) {
    await runSync(
      "claude-code",
      () =>
        syncClaudeCodeSessions(
          claudeDirectory,
          archiveRepository,
          conversationProjectionRepository,
        ),
    );
  }
  if (piDirectory) {
    await runSync(
      "pi",
      () =>
        syncPiSessions(
          piDirectory,
          archiveRepository,
          conversationProjectionRepository,
        ),
    );
  }
  if (codexDirectory) {
    await runSync(
      "codex",
      () =>
        syncCodexSessions(
          codexDirectory,
          archiveRepository,
          conversationProjectionRepository,
        ),
    );
  }
  if (cursorDirectory) {
    await runSync(
      "cursor",
      () =>
        syncCursorAgentSessions(
          cursorDirectory,
          cursorCapturePath,
          archiveRepository,
          conversationProjectionRepository,
        ),
    );
  }
  await generateMissingSessionTitles(archiveDatabase);
  console.info(
    `[sync] complete duration=${(performance.now() - startedAt).toFixed(1)}ms`,
  );
}

let activeSourceSync: Promise<void> | undefined;
function syncSourcesOnce() {
  if (activeSourceSync !== undefined) return activeSourceSync;
  const running = syncSources().then(() => {
    apiResponseCache.clear();
  }).finally(() => {
    if (activeSourceSync === running) activeSourceSync = undefined;
  });
  activeSourceSync = running;
  return running;
}

async function syncSourcesPeriodically(intervalSeconds: number) {
  console.info(`[sync] periodic sync enabled interval=${intervalSeconds}s`);
  while (true) {
    await new Promise((resolve) =>
      setTimeout(resolve, intervalSeconds * 1_000)
    );
    try {
      await syncSourcesOnce();
    } catch (error) {
      console.error(
        `[sync] periodic sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
const serveStaticAssets = Deno.env.get("SERVE_STATIC") === "true";
const app = new Hono();
app.use("/api/*", cors());
const logApiRequest = createMiddleware(async (context, next) => {
  const startedAt = performance.now();
  await next();
  const url = new URL(context.req.url);
  console.info(
    `[request] method=${context.req.method} endpoint=${url.pathname}${url.search} status=${context.res.status} duration=${
      (performance.now() - startedAt).toFixed(1)
    }ms`,
  );
});
app.use("/api/*", logApiRequest);

app.get("/health", (context) => context.json({ status: "ok" }));

app.post("/api/sync", async (context) => {
  await syncSourcesOnce();
  return context.json({ status: "ok" });
});

app.get(
  "/api/settings/title-generation",
  (context) =>
    context.json({ enabled: titleGenerationEnabled(archiveDatabase) }),
);

app.put("/api/settings/title-generation", async (context) => {
  const body = await context.req.json().catch(() => undefined) as
    | { enabled?: unknown }
    | undefined;
  if (typeof body?.enabled !== "boolean") {
    return context.json({ error: "enabled must be a boolean" }, 400);
  }
  setTitleGenerationEnabled(archiveDatabase, body.enabled);
  return context.json({ enabled: body.enabled });
});

// Settings and sync routes stay uncached; data reads below are invalidated by
// every successful manual, periodic, or startup sync.
app.use("/api/*", apiResponseCache.middleware);

function repositoryForHarness(harness: SessionSummary["harness"]) {
  return {
    listSessions: (page: number, pageSize: number) =>
      readRepository.listSessions(page, pageSize, harness),
    getSession: (id: string) => readRepository.getSession(harness, id),
  };
}

function priceSummaries(items: SessionSummary[]) {
  return items.map((item) => {
    if (
      item.cacheSummary !== undefined && item.compactionCount !== undefined &&
      item.inclusiveTokens !== undefined
    ) return item;
    const detail = repositoryForHarness(item.harness)?.getSession(item.id);
    if (!detail) return item;
    return enrichSessionSummary(detail);
  });
}

app.get("/api/tool-calls", (context) => {
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "30";
  if (!["7", "30", "90"].includes(rangeParam)) {
    return context.json({ error: "Invalid range; expected 7, 30, or 90" }, 400);
  }
  const expandParam = context.req.query("expand") ?? "false";
  if (!["true", "false"].includes(expandParam)) {
    return context.json({ error: "Invalid expand value" }, 400);
  }
  const range = Number(rangeParam) as 7 | 30 | 90;
  const end = Date.now();
  const start = new Date(
    new Date(end).setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
  ).getTime();
  const calls = readRepository.listToolCalls(
    start,
    end,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  return context.json(
    aggregateToolCalls(calls, range, start, end, expandParam === "true"),
  );
});

app.get("/api/performance", (context) => {
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const openaiModel = context.req.query("openai") ?? "all";
  const anthropicModel = context.req.query("anthropic") ?? "all";
  if (
    openaiModel !== "all" &&
    !PERFORMANCE_MODELS.openai.includes(
      openaiModel as (typeof PERFORMANCE_MODELS.openai)[number],
    )
  ) return context.json({ error: "Invalid OpenAI model" }, 400);
  if (
    anthropicModel !== "all" &&
    !PERFORMANCE_MODELS.anthropic.includes(
      anthropicModel as (typeof PERFORMANCE_MODELS.anthropic)[number],
    )
  ) return context.json({ error: "Invalid Anthropic model" }, 400);

  const end = Date.now();
  const start = new Date(
    new Date(end).setHours(0, 0, 0, 0) -
      (PERFORMANCE_RANGE_DAYS - 1) * 86_400_000,
  ).getTime();
  // Include the preceding cache TTL so requests at the range boundary can be
  // compared with their immediately preceding context.
  const cacheStart = start - CACHE_TTL_1H_MS;
  const calls = readRepository.listUsageCalls(
    cacheStart,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  return context.json(
    aggregatePerformance(calls, start, end, openaiModel, anthropicModel),
  );
});

const cacheMissOverview = (context: Context) => {
  const requestStartedAt = performance.now();
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "90";
  const range = rangeParam === "all"
    ? Math.ceil(Date.now() / 86_400_000)
    : Math.min(365, Math.max(1, Number.parseInt(rangeParam, 10) || 90));
  const start = rangeParam === "all" ? 0 : new Date(
    new Date().setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
  ).getTime();
  const sourceDurations = new Map<string, number>();
  const sourceStartedAt = performance.now();
  const storedMisses = readRepository.listCacheMisses(
    start,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  const storedCosts = readRepository.summarizeModelCallCosts(
    start,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  sourceDurations.set("database", performance.now() - sourceStartedAt);
  const sourceDuration = [...sourceDurations.values()].reduce(
    (total, duration) => total + duration,
    0,
  );
  const aggregationStartedAt = performance.now();
  const metrics = aggregateTtlMisses(
    [],
    start,
    range,
    storedMisses,
    storedCosts,
  );
  const aggregationDuration = performance.now() - aggregationStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  const sourceTimings = [...sourceDurations.entries()].map(
    ([name, duration]) => `${name}=${duration.toFixed(1)}ms`,
  ).join(" ");
  context.header(
    "Server-Timing",
    `sources;dur=${sourceDuration.toFixed(1)}, aggregate;dur=${
      aggregationDuration.toFixed(1)
    }, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[cache-miss-overview] harness=${harness} range=${rangeParam} calls=0 storedMisses=${storedMisses.length} sources=${
      sourceDuration.toFixed(1)
    }ms ${sourceTimings} aggregate=${aggregationDuration.toFixed(1)}ms total=${
      totalDuration.toFixed(1)
    }ms`,
  );
  return context.json(metrics);
};

app.get("/api/cache-misses/overview", cacheMissOverview);
// Keep the old route for existing clients and bookmarks.
app.get("/api/ttl-misses", cacheMissOverview);

app.get("/api/session-shape", (context) => {
  const requestStartedAt = performance.now();
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "30";
  if (rangeParam !== "30" && rangeParam !== "90") {
    return context.json({ error: "Invalid range; expected 30 or 90" }, 400);
  }
  const range = Number(rangeParam) as 30 | 90;
  const end = Date.now();
  const start = new Date(
    new Date(end).setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
  ).getTime();
  const selectedHarness = harness === "all"
    ? undefined
    : harness as SessionSummary["harness"];
  const loadStartedAt = performance.now();
  const loaded = readRepository.listSessionShapeRollups(
    start,
    selectedHarness,
  );
  const loadDuration = performance.now() - loadStartedAt;
  const aggregationStartedAt = performance.now();
  const shape = aggregateSessionShape(loaded, start, end, range);
  const aggregationDuration = performance.now() - aggregationStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  context.header(
    "Server-Timing",
    `database;dur=${loadDuration.toFixed(1)}, aggregate;dur=${
      aggregationDuration.toFixed(1)
    }, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[session-shape] harness=${harness} range=${range} roots=${loaded.length} samples=${shape.sampleSize} database=${
      loadDuration.toFixed(1)
    }ms aggregate=${aggregationDuration.toFixed(1)}ms total=${
      totalDuration.toFixed(1)
    }ms`,
  );
  return context.json(shape);
});

app.get("/api/activity-overview", (context) => {
  const requestStartedAt = performance.now();
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "30";
  if (rangeParam !== "30" && rangeParam !== "90") {
    return context.json({ error: "Invalid range; expected 30 or 90" }, 400);
  }
  const range = Number(rangeParam) as 30 | 90;
  const timeZone = context.req.query("timeZone") ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  let boundaries: { start: number; end: number };
  try {
    boundaries = workRhythmRange(range, timeZone);
  } catch {
    return context.json({ error: "Invalid IANA timezone" }, 400);
  }
  const { start, end } = boundaries;
  const selectedHarness = harness === "all"
    ? undefined
    : harness as SessionSummary["harness"];
  const loadStartedAt = performance.now();
  const loaded = readRepository.listOverviewRollups(
    start - 5 * 60_000,
    selectedHarness,
  );
  const loadDuration = performance.now() - loadStartedAt;
  const aggregationStartedAt = performance.now();
  const spendAtMissCalls = readRepository.listCacheMisses(
    start,
    selectedHarness,
  ).reduce((sum, miss) => sum + (miss.modelCallCost ?? 0), 0);
  const overview = aggregateActivityOverview(
    loaded,
    start,
    end,
    range,
    timeZone,
    spendAtMissCalls,
  );
  const aggregationDuration = performance.now() - aggregationStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  context.header(
    "Server-Timing",
    `sources;dur=${loadDuration.toFixed(1)}, aggregate;dur=${
      aggregationDuration.toFixed(1)
    }, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[activity-overview] harness=${harness} range=${range} roots=${loaded.length} days=${overview.days.length} load=${
      loadDuration.toFixed(1)
    }ms aggregate=${aggregationDuration.toFixed(1)}ms total=${
      totalDuration.toFixed(1)
    }ms`,
  );
  return context.json(overview);
});

app.get("/api/overview", (context) => {
  const requestStartedAt = performance.now();
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "90";
  const range = rangeParam === "all"
    ? Math.ceil(Date.now() / 86_400_000)
    : Math.min(365, Math.max(1, Number.parseInt(rangeParam, 10) || 90));
  const start = rangeParam === "all" ? 0 : new Date(
    new Date().setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
  ).getTime();
  const end = Date.now();
  const coverage = harness === "pi" || harness === "codex"
    ? "none"
    : harness === "all"
    ? "partial"
    : "full";
  const initialInputStartedAt = performance.now();
  const initialInput = readRepository.initialInputDistribution(
    start,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  const initialInputDuration = performance.now() - initialInputStartedAt;
  const loadStartedAt = performance.now();
  const loaded = readRepository.listOverviewRollups(
    start - ROTATION_INACTIVITY_MINUTES * 60_000,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
  );
  const loadDuration = performance.now() - loadStartedAt;
  const aggregationStartedAt = performance.now();
  const aggregated = aggregateOverviewRollups(
    loaded,
    start,
    end,
    range,
    coverage,
  );
  const overview = {
    ...aggregated,
    sessionProfile: { ...aggregated.sessionProfile, initialInput },
  };
  const aggregationDuration = performance.now() - aggregationStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  context.header(
    "Server-Timing",
    `sources;dur=${loadDuration.toFixed(1)}, initial-input;dur=${
      initialInputDuration.toFixed(1)
    }, aggregate;dur=${aggregationDuration.toFixed(1)}, total;dur=${
      totalDuration.toFixed(1)
    }`,
  );
  console.info(
    `[overview] harness=${harness} range=${rangeParam} roots=${loaded.length} load=${
      loadDuration.toFixed(1)
    }ms initial-input=${initialInputDuration.toFixed(1)}ms aggregate=${
      aggregationDuration.toFixed(1)
    }ms total=${totalDuration.toFixed(1)}ms`,
  );
  return context.json(overview);
});

app.get("/api/usage", (context) => {
  const requestStartedAt = performance.now();
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "30";
  const range = rangeParam === "all"
    ? undefined
    : Math.min(365, Math.max(1, Number.parseInt(rangeParam, 10) || 30));
  const start = range === undefined
    ? undefined
    : new Date(new Date().setHours(0, 0, 0, 0) - (range - 1) * 86_400_000)
      .getTime();
  const sourceDurations = new Map<string, number>();
  const sourceStartedAt = performance.now();
  const selectedHarness = harness === "all"
    ? undefined
    : harness as SessionSummary["harness"];
  const rollups = readRepository.listUsageRollups(start, selectedHarness);
  const subagentUsage = rollups.some((rollup) => rollup.subagentModelCalls > 0)
    ? readRepository.listSubagentUsage(start, selectedHarness)
    : [];
  const initialInputSamples = readRepository.listInitialInputSamples(
    start,
    selectedHarness,
  );
  sourceDurations.set("database", performance.now() - sourceStartedAt);

  const subagentCoverage = harness === "pi" || harness === "codex"
    ? "none"
    : harness === "all"
    ? "partial"
    : "full";
  const aggregationStartedAt = performance.now();
  const aggregated = aggregateUsageRollups(
    rollups,
    subagentUsage,
    start,
    subagentCoverage,
    initialInputSamples,
  );
  const aggregationDuration = performance.now() - aggregationStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  const sourceDuration = [...sourceDurations.values()].reduce(
    (total, duration) => total + duration,
    0,
  );
  const sourceTimings = [...sourceDurations.entries()].map(
    ([name, duration]) => `${name}=${duration.toFixed(1)}ms`,
  ).join(" ");
  context.header(
    "Server-Timing",
    `sources;dur=${sourceDuration.toFixed(1)}, aggregate;dur=${
      aggregationDuration.toFixed(1)
    }, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[usage] harness=${harness} range=${rangeParam} roots=${aggregated.rootCount} subagentGroups=${subagentUsage.length} days=${aggregated.dayCount} sources=${
      sourceDuration.toFixed(1)
    }ms ${sourceTimings} aggregate=${aggregationDuration.toFixed(1)}ms total=${
      totalDuration.toFixed(1)
    }ms`,
  );
  return context.json(aggregated.response);
});

app.get("/api/sessions", (context) => {
  const requestStartedAt = performance.now();
  const page = Math.max(
    1,
    Number.parseInt(context.req.query("page") ?? "1", 10) || 1,
  );
  const requestedPageSize =
    Number.parseInt(context.req.query("pageSize") ?? "10", 10) || 10;
  const pageSize = Math.min(100, Math.max(1, requestedPageSize));
  const harness = context.req.query("harness") ?? "all";
  if (!isHarnessFilter(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const misses = context.req.query("misses");
  const missFilters = parseSessionMissFilters(misses);
  if (
    misses !== undefined && misses !== "" && misses !== "all" &&
    misses !== "none" && missFilters === undefined
  ) {
    return context.json({
      error: `Invalid miss filter; expected ${
        sessionMissFilterSchema.options.join(", ")
      }`,
    }, 400);
  }
  const queryStartedAt = performance.now();
  const result = readRepository.listSessions(
    page,
    pageSize,
    harness === "all" ? undefined : harness as SessionSummary["harness"],
    missFilters,
  );
  const queryDuration = performance.now() - queryStartedAt;
  const enrichmentStartedAt = performance.now();
  const items = priceSummaries(
    readRepository.enrichSessionSummaries(result.items),
  );
  const enrichmentDuration = performance.now() - enrichmentStartedAt;
  const totalDuration = performance.now() - requestStartedAt;
  context.header(
    "Server-Timing",
    `database;dur=${queryDuration.toFixed(1)}, enrichment;dur=${
      enrichmentDuration.toFixed(1)
    }, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[sessions] harness=${harness} page=${page} items=${items.length} database=${
      queryDuration.toFixed(1)
    }ms enrichment=${enrichmentDuration.toFixed(1)}ms total=${
      totalDuration.toFixed(1)
    }ms`,
  );
  return context.json({ ...result, items });
});

app.get("/api/sessions/:id", (context) => {
  const harness = context.req.query("harness") ?? "opencode";
  if (!isHarness(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const session = readRepository.getSession(
    harness as SessionSummary["harness"],
    context.req.param("id"),
  );
  return session
    ? context.json(analyzeSessionCache(priceSessionDetail(session)))
    : context.json({ error: "Session not found" }, 404);
});

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]" || hostname === "::1";
}

app.post("/api/sessions/:id/open-in-ghostty", async (context) => {
  const requestHostname = new URL(context.req.url).hostname;
  const origin = context.req.header("origin");
  if (
    !isLoopbackHostname(requestHostname) ||
    (origin !== undefined && !isLoopbackHostname(new URL(origin).hostname))
  ) {
    return context.json({ error: "Ghostty can only be opened locally" }, 403);
  }
  if (Deno.build.os !== "darwin") {
    return context.json(
      { error: "Opening Ghostty is only supported on macOS" },
      501,
    );
  }
  const harness = context.req.query("harness");
  if (
    harness !== "pi" && harness !== "opencode" &&
    harness !== "claude-code" && harness !== "codex"
  ) {
    return context.json({ error: "Harness cannot be opened in Ghostty" }, 400);
  }
  const session = readRepository.getSession(harness, context.req.param("id"));
  if (!session?.workingDirectory) {
    return context.json(
      { error: "Session working directory is unavailable" },
      404,
    );
  }

  try {
    const workingDirectory = await Deno.realPath(
      expandHomePath(session.workingDirectory),
    );
    if (!(await Deno.stat(workingDirectory)).isDirectory) {
      return context.json(
        { error: "Session working directory is unavailable" },
        409,
      );
    }

    let sessionCommand: string[];
    if (harness === "opencode") {
      sessionCommand = ["opencode", "--session", session.id];
    } else if (harness === "claude-code") {
      const claudeSessionID = session.sourcePath?.split("/").at(-1)?.replace(
        /\.jsonl$/,
        "",
      ) ?? session.id.split("/").at(-1);
      if (!claudeSessionID) {
        return context.json({ error: "Claude session ID is unavailable" }, 404);
      }
      sessionCommand = ["claude", "--resume", claudeSessionID];
    } else if (harness === "codex") {
      const codexSessionID = [session.id, session.sourcePath ?? ""].flatMap(
        (value) =>
          value.match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          ) ?? [],
      ).at(-1);
      if (!codexSessionID) {
        return context.json({ error: "Codex session ID is unavailable" }, 404);
      }
      sessionCommand = ["codex", "resume", codexSessionID];
    } else {
      if (piDirectory === undefined || !session.sourcePath) {
        return context.json({ error: "Pi session files are unavailable" }, 404);
      }
      const sessionRoot = await Deno.realPath(piDirectory);
      const sessionPath = await Deno.realPath(
        resolve(sessionRoot, session.sourcePath),
      );
      const pathFromRoot = relative(sessionRoot, sessionPath);
      if (
        pathFromRoot.startsWith("..") ||
        resolve(sessionRoot, pathFromRoot) !== sessionPath
      ) {
        return context.json({ error: "Invalid Pi session path" }, 400);
      }
      if (!(await Deno.stat(sessionPath)).isFile) {
        return context.json({ error: "Pi session file is unavailable" }, 404);
      }
      sessionCommand = ["pi", "--session", sessionPath];
    }

    const command = new Deno.Command("open", {
      args: [
        "-na",
        "Ghostty.app",
        "--args",
        `--working-directory=${workingDirectory}`,
        "--window-save-state=never",
        "--quit-after-last-window-closed=true",
        "-e",
        ...sessionCommand,
      ],
      stdout: "null",
      stderr: "piped",
    });
    const result = await command.output();
    if (!result.success) {
      const detail = new TextDecoder().decode(result.stderr).trim();
      throw new Error(detail || "Ghostty could not be opened");
    }
    return context.json({ status: "opened" });
  } catch (error) {
    const message = error instanceof Deno.errors.NotFound
      ? "Session file, working directory, or Ghostty is unavailable"
      : error instanceof Deno.errors.PermissionDenied
      ? "The server is not allowed to launch Ghostty"
      : error instanceof Error
      ? error.message
      : "Ghostty could not be opened";
    return context.json({ error: message }, 500);
  }
});

app.get(
  "/api/*",
  (context) => context.json({ error: "API route not found" }, 404),
);

if (serveStaticAssets) {
  app.use("*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ root: "./dist", path: "index.html" }));
}

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
Deno.serve({
  port,
  onListen: ({ port }) =>
    console.log(`Frugal Tokens API listening on http://localhost:${port}`),
}, app.fetch);
await syncSourcesOnce();
if (syncIntervalSeconds !== undefined) {
  void syncSourcesPeriodically(syncIntervalSeconds);
}
