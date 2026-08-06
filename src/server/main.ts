import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { createMiddleware } from "hono/factory";
import { priceSessionDetail } from "./pricing.ts";
import {
  analyzeSessionCache,
  CACHE_TTL_1H_MS,
  sessionCacheIssues,
  summarizeSessionCache,
} from "./cacheAnalysis.ts";
import type {
  SessionDetail,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
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
import { aggregateSessionShape } from "./sessionShapeAnalytics.ts";
import { contextRange } from "../shared/contextMetrics.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import { expandHomePath, openArchiveDatabase, sqlitePath } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { ConversationCompatibilityRepository } from "./conversationCompatibilityRepository.ts";
import { ConversationProjectionRepository } from "./conversationProjectionRepository.ts";
import { SessionReadRepository } from "./sessionReadRepository.ts";
import { syncPiSessions } from "./piImporter.ts";
import { syncCodexSessions } from "./codexImporter.ts";
import { syncClaudeCodeSessions } from "./claudeCodeImporter.ts";
import { syncOpenCodeSessions } from "./openCodeImporter.ts";

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
];
const configuredConversationHarnesses = Deno.env.get(
  "FRUGAL_TOKENS_CONVERSATION_READ_HARNESSES",
);
const conversationReadHarnesses = new Set<SessionSummary["harness"]>(
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
const readRepository = new SessionReadRepository(
  archiveRepository,
  conversationCompatibilityRepository,
  conversationReadHarnesses,
);
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

async function runSync(
  harness: SessionSummary["harness"],
  sync: () =>
    | {
      discovered: number;
      imported: number;
      skipped: number;
      failed: number;
      timings?: Record<string, number>;
    }
    | Promise<
      {
        discovered: number;
        imported: number;
        skipped: number;
        failed: number;
        timings?: Record<string, number>;
      }
    >,
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
  console.info(
    `[sync] complete duration=${(performance.now() - startedAt).toFixed(1)}ms`,
  );
}

async function syncSourcesPeriodically(intervalSeconds: number) {
  console.info(`[sync] periodic sync enabled interval=${intervalSeconds}s`);
  while (true) {
    await new Promise((resolve) =>
      setTimeout(resolve, intervalSeconds * 1_000)
    );
    try {
      await syncSources();
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
  await syncSources();
  return context.json({ status: "ok" });
});

function repositoryForHarness(harness: SessionSummary["harness"]) {
  return {
    listSessions: (page: number, pageSize: number) =>
      readRepository.listSessions(page, pageSize, harness),
    getSession: (id: string) => readRepository.getSession(harness, id),
  };
}

type SubagentTotals = { count: number; modelCalls: number };

function sumOptional(values: (number | undefined)[]) {
  const present = values.filter((value): value is number =>
    value !== undefined
  );
  return present.length === 0
    ? undefined
    : present.reduce((total, value) => total + value, 0);
}

function sumTokens(values: TokenUsage[]): TokenUsage {
  return {
    uncachedInput: values.reduce(
      (total, tokens) => total + tokens.uncachedInput,
      0,
    ),
    cacheRead: values.reduce((total, tokens) => total + tokens.cacheRead, 0),
    cacheWrite: sumOptional(values.map((tokens) => tokens.cacheWrite)),
    cacheWrite5m: sumOptional(values.map((tokens) => tokens.cacheWrite5m)),
    cacheWrite1h: sumOptional(values.map((tokens) => tokens.cacheWrite1h)),
    freshPrompt: values.reduce(
      (total, tokens) => total + tokens.freshPrompt,
      0,
    ),
    output: values.reduce((total, tokens) => total + tokens.output, 0),
    reasoning: values.reduce((total, tokens) => total + tokens.reasoning, 0),
    processed: values.reduce((total, tokens) => total + tokens.processed, 0),
  };
}

type SessionTreeMetrics = {
  sessions: SessionDetail[];
  userTurns: number;
  modelCalls: number;
  imageInputs: number;
  tokens: TokenUsage;
  reportedCost?: number;
  computedCost?: number;
};

function imageInputCount(session: Pick<SessionDetail, "turns">) {
  return session.turns.reduce(
    (total, turn) =>
      total + turn.calls.reduce(
        (callTotal, call) => callTotal + (call.activity.images ?? 0),
        0,
      ),
    0,
  );
}

function sessionTreeMetrics(session: SessionDetail): SessionTreeMetrics {
  const sessions = [
    session,
    ...session.subagents.flatMap((subagent) =>
      sessionTreeMetrics(subagent).sessions
    ),
  ];
  const reportedCosts = sessions.map((item) => item.reportedCost);
  const computed = rollupCosts(sessions.map((item) => item.computedCost));
  return {
    sessions,
    userTurns: sessions.reduce((total, item) => total + item.userTurns, 0),
    modelCalls: sessions.reduce((total, item) => total + item.modelCalls, 0),
    imageInputs: sessions.reduce(
      (total, item) => total + imageInputCount(item),
      0,
    ),
    tokens: sumTokens(sessions.map((item) => item.tokens)),
    reportedCost: reportedCosts.every((cost) => cost !== undefined)
      ? reportedCosts.reduce((total, cost) => total + cost!, 0)
      : undefined,
    computedCost: computed.cost,
  };
}

function subagentTotals(
  subagents: SessionDetail["subagents"],
): SubagentTotals {
  return subagents.reduce<SubagentTotals>(
    (total, subagent) => {
      const nested = subagentTotals(subagent.subagents);
      return {
        count: total.count + 1 + nested.count,
        modelCalls: total.modelCalls + subagent.modelCalls + nested.modelCalls,
      };
    },
    { count: 0, modelCalls: 0 },
  );
}

function compactionCount(session: SessionDetail): number {
  return (session.contextEvents ?? []).filter((event) =>
    event.type === "compaction"
  )
    .length +
    session.turns.reduce(
      (total, turn) =>
        total + turn.calls.reduce(
          (callTotal, call) =>
            callTotal + (call.contextEventsBefore ?? []).filter((event) =>
              event.type === "compaction"
            ).length,
          0,
        ),
      0,
    ) + session.subagents.reduce(
      (total, subagent) => total + compactionCount(subagent),
      0,
    );
}

function priceSummaries(items: SessionSummary[]) {
  return items.map((item) => {
    const detail = repositoryForHarness(item.harness)?.getSession(item.id);
    if (!detail) return item;
    const priced = priceSessionDetail(detail);
    const analyzed = analyzeSessionCache(priced);
    const subagents = subagentTotals(priced.subagents);
    const inclusive = sessionTreeMetrics(priced);
    const context = contextRange(
      priced.turns.flatMap((turn) =>
        turn.calls.map((call) => ({
          startedAt: call.startedAt,
          tokens: call.tokens,
          turn: turn.number,
          call: call.callWithinTurn,
        }))
      ),
    );
    return {
      ...item,
      userTurns: priced.userTurns,
      modelCalls: priced.modelCalls,
      computedCost: priced.computedCost,
      cacheSummary: summarizeSessionCache(analyzed),
      cacheIssues: sessionCacheIssues(analyzed),
      compactionCount: compactionCount(analyzed),
      contextLatest: context.latest?.size,
      contextPeak: context.peak?.size,
      contextPeakTurn: context.peak?.call.turn,
      contextPeakCall: context.peak?.call.call,
      subagentCount: subagents.count,
      subagentModelCalls: subagents.modelCalls,
      inclusiveUserTurns: inclusive.userTurns,
      inclusiveModelCalls: inclusive.modelCalls,
      inclusiveReportedCost: inclusive.reportedCost,
      inclusiveComputedCost: inclusive.computedCost,
      inclusiveImageInputs: inclusive.imageInputs,
      inclusiveTokens: inclusive.tokens,
    };
  });
}

app.get("/api/tool-calls", (context) => {
  const harness = context.req.query("harness") ?? "all";
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  const loaded = readRepository.listOverviewRollups(start, selectedHarness);
  const loadDuration = performance.now() - loadStartedAt;
  const aggregationStartedAt = performance.now();
  const overview = aggregateActivityOverview(loaded, start, end, range);
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
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
  const items = priceSummaries(result.items);
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
  if (!["opencode", "claude-code", "pi", "codex"].includes(harness)) {
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

app.get(
  "/api/*",
  (context) => context.json({ error: "API route not found" }, 404),
);

if (serveStaticAssets) {
  app.use("/assets/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ root: "./dist", path: "index.html" }));
}

await syncSources();
if (syncIntervalSeconds !== undefined) {
  void syncSourcesPeriodically(syncIntervalSeconds);
}
const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
Deno.serve({
  port,
  onListen: ({ port }) =>
    console.log(`Frugal Tokens API listening on http://localhost:${port}`),
}, app.fetch);
