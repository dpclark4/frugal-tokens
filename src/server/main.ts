import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { createMiddleware } from "hono/factory";
import { OpenCodeRepository } from "./opencodeRepository.ts";
import { ClaudeCodeRepository } from "./claudeCodeRepository.ts";
import { PiRepository } from "./piRepository.ts";
import { CodexRepository } from "./codexRepository.ts";
import { computeModelCallCost, priceSessionDetail } from "./pricing.ts";
import {
  analyzeSessionCache,
  CACHE_TTL_1H_MS,
  sessionCacheIssues,
  summarizeSessionCache,
} from "./cacheAnalysis.ts";
import type {
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import type { UsageCall } from "./usage.ts";
import { aggregateUsage } from "./usageAnalytics.ts";
import { aggregateTtlMisses } from "./ttlMissAnalytics.ts";
import {
  aggregatePerformance,
  PERFORMANCE_MODELS,
  PERFORMANCE_RANGE_DAYS,
} from "./performanceAnalytics.ts";
import {
  aggregateOverview,
  ROTATION_INACTIVITY_MINUTES,
} from "./overviewAnalytics.ts";
import { contextRange } from "../shared/contextMetrics.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import { openArchiveDatabase, sqlitePath } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";
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
  const path = Deno.env.get(variable);
  if (!path) {
    console.warn(`[config] ${harness} disabled: ${variable} is not set`);
    return undefined;
  }
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
const archiveDatabase = archiveURL
  ? openArchiveDatabase(sqlitePath(archiveURL))
  : undefined;
const archiveRepository = archiveDatabase
  ? new SessionRepository(archiveDatabase)
  : undefined;
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
  if (!archiveRepository) return;
  const startedAt = performance.now();
  if (openCodePath) {
    await runSync(
      "opencode",
      () => syncOpenCodeSessions(openCodePath, archiveRepository),
    );
  }
  if (claudeDirectory) {
    await runSync(
      "claude-code",
      () => syncClaudeCodeSessions(claudeDirectory, archiveRepository),
    );
  }
  if (piDirectory) {
    await runSync("pi", () => syncPiSessions(piDirectory, archiveRepository));
  }
  if (codexDirectory) {
    await runSync(
      "codex",
      () => syncCodexSessions(codexDirectory, archiveRepository),
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
const claudeRepository = archiveRepository
  ? {
    listSessions: (page: number, pageSize: number) =>
      archiveRepository.listSessions(page, pageSize, "claude-code"),
    getSession: (id: string) => archiveRepository.getSession("claude-code", id),
    listUsageCalls: (startedAt?: number) =>
      archiveRepository.listUsageCalls(startedAt, "claude-code"),
  }
  : claudeDirectory
  ? new ClaudeCodeRepository(claudeDirectory)
  : undefined;
const piRepository = archiveRepository
  ? {
    listSessions: (page: number, pageSize: number) =>
      archiveRepository.listSessions(page, pageSize, "pi"),
    getSession: (id: string) => archiveRepository.getSession("pi", id),
    listUsageCalls: (startedAt?: number) =>
      archiveRepository.listUsageCalls(startedAt, "pi"),
  }
  : piDirectory
  ? new PiRepository(piDirectory)
  : undefined;
const codexRepository = archiveRepository
  ? {
    listSessions: (page: number, pageSize: number) =>
      archiveRepository.listSessions(page, pageSize, "codex"),
    getSession: (id: string) => archiveRepository.getSession("codex", id),
    listUsageCalls: (startedAt?: number) =>
      archiveRepository.listUsageCalls(startedAt, "codex"),
  }
  : codexDirectory
  ? new CodexRepository(codexDirectory)
  : undefined;
const repository = archiveRepository
  ? {
    listSessions: (page: number, pageSize: number) =>
      archiveRepository.listSessions(page, pageSize, "opencode"),
    getSession: (id: string) => archiveRepository.getSession("opencode", id),
    listUsageCalls: (startedAt?: number) =>
      archiveRepository.listUsageCalls(startedAt, "opencode"),
  }
  : openCodePath
  ? new OpenCodeRepository(openCodePath)
  : undefined;
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

function repositoryForHarness(harness: SessionSummary["harness"]) {
  if (harness === "claude-code") return claudeRepository;
  if (harness === "pi") return piRepository;
  if (harness === "codex") return codexRepository;
  return repository;
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

function listSessions(
  source: ReturnType<typeof repositoryForHarness>,
  page: number,
  pageSize: number,
) {
  return source?.listSessions(page, pageSize) ?? {
    items: [],
    pagination: { page, pageSize, totalItems: 0, totalPages: 0 },
  };
}

function overviewSessions(start: number, harness: string) {
  const harnesses = harness === "all"
    ? (["opencode", "claude-code", "pi", "codex"] as const)
    : [harness as SessionSummary["harness"]];
  const sessions: SessionDetail[] = [];
  for (const name of harnesses) {
    const source = repositoryForHarness(name);
    if (!source) continue;
    const pageSize = 100;
    for (let page = 1;; page++) {
      const result = source.listSessions(page, pageSize);
      for (const summary of result.items) {
        if (summary.updatedAt < start) continue;
        const detail = source.getSession(summary.id);
        if (detail) sessions.push(priceSessionDetail(detail));
      }
      if (
        page >= result.pagination.totalPages ||
        result.items.every((session) => session.updatedAt < start)
      ) break;
    }
  }
  return sessions;
}

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
  const calls: UsageCall[] = [];
  if (archiveRepository) {
    calls.push(...archiveRepository.listUsageCalls(
      cacheStart,
      harness === "all" ? undefined : harness as SessionSummary["harness"],
    ));
  } else {
    const sources = [
      ["opencode", repository],
      ["claude-code", claudeRepository],
      ["pi", piRepository],
      ["codex", codexRepository],
    ] as const;
    for (const [name, source] of sources) {
      if (!source || (harness !== "all" && harness !== name)) continue;
      calls.push(...source.listUsageCalls(cacheStart));
    }
  }
  return context.json(
    aggregatePerformance(calls, start, end, openaiModel, anthropicModel),
  );
});

app.get("/api/ttl-misses", (context) => {
  const harness = context.req.query("harness") ?? "all";
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "90";
  const range = rangeParam === "all"
    ? Math.ceil(Date.now() / 86_400_000)
    : Math.min(365, Math.max(1, Number.parseInt(rangeParam, 10) || 90));
  const start = rangeParam === "all"
    ? 0
    : new Date(
      new Date().setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
    ).getTime();
  const usageCalls: UsageCall[] = [];

  if (archiveRepository) {
    usageCalls.push(...archiveRepository.listUsageCalls(
      start,
      harness === "all" ? undefined : harness as SessionSummary["harness"],
    ));
  } else {
    const sources = [
      ["opencode", repository],
      ["claude-code", claudeRepository],
      ["pi", piRepository],
      ["codex", codexRepository],
    ] as const;
    for (const [name, source] of sources) {
      if (!source || (harness !== "all" && harness !== name)) continue;
      usageCalls.push(...source.listUsageCalls(start));
    }
  }

  return context.json(aggregateTtlMisses(usageCalls, start, range));
});

app.get("/api/overview", (context) => {
  const harness = context.req.query("harness") ?? "all";
  if (!["all", "opencode", "claude-code", "pi", "codex"].includes(harness)) {
    return context.json({ error: "Invalid harness" }, 400);
  }
  const rangeParam = context.req.query("range") ?? "90";
  const range = rangeParam === "all"
    ? Math.ceil(Date.now() / 86_400_000)
    : Math.min(365, Math.max(1, Number.parseInt(rangeParam, 10) || 90));
  const start = rangeParam === "all"
    ? 0
    : new Date(
      new Date().setHours(0, 0, 0, 0) - (range - 1) * 86_400_000,
    ).getTime();
  const end = Date.now();
  const coverage = harness === "pi" || harness === "codex"
    ? "none"
    : harness === "all"
    ? "partial"
    : "full";
  return context.json(
    aggregateOverview(
      overviewSessions(
        start - ROTATION_INACTIVITY_MINUTES * 60_000,
        harness,
      ),
      start,
      end,
      range,
      coverage,
    ),
  );
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
  const usageCalls: UsageCall[] = [];

  const detailDurations = new Map<string, number>();
  if (archiveRepository) {
    const detailStartedAt = performance.now();
    const calls = archiveRepository.listUsageCalls(
      start,
      harness === "all" ? undefined : harness as SessionSummary["harness"],
    );
    detailDurations.set("database", performance.now() - detailStartedAt);
    for (const call of calls) {
      const pricedCall = {
        ...call,
        computedCost: call.computedCost ?? computeModelCallCost(
          call.tokens,
          call.model,
          call.startedAt,
        ),
      };
      usageCalls.push(pricedCall);
    }
  } else {
    const sources = [
      ["opencode", repository],
      ["claude-code", claudeRepository],
      ["pi", piRepository],
      ["codex", codexRepository],
    ] as const;
    for (const [name, source] of sources) {
      if (harness !== "all" && harness !== name) continue;
      if (!source) continue;
      const detailStartedAt = performance.now();
      for (const call of source.listUsageCalls(start)) {
        const pricedCall = {
          ...call,
          computedCost: call.computedCost ?? computeModelCallCost(
            call.tokens,
            call.model,
            call.startedAt,
          ),
        };
        usageCalls.push(pricedCall);
      }
      detailDurations.set(name, performance.now() - detailStartedAt);
    }
  }

  const subagentCoverage = harness === "pi" || harness === "codex"
    ? "none"
    : harness === "all"
    ? "partial"
    : "full";
  const aggregated = aggregateUsage(usageCalls, start, subagentCoverage);
  const totalDuration = performance.now() - requestStartedAt;
  const detailDuration = [...detailDurations.values()].reduce(
    (total, duration) => total + duration,
    0,
  );
  const harnessTimings = [...detailDurations.entries()].map(
    ([name, duration]) => `${name}=${duration.toFixed(1)}ms`,
  ).join(" ");
  context.header(
    "Server-Timing",
    `sources;dur=${detailDuration.toFixed(1)}, total;dur=${
      totalDuration.toFixed(1)
    }`,
  );
  console.info(
    `[usage] harness=${harness} range=${rangeParam} calls=${aggregated.callCount} days=${aggregated.dayCount} sources=${
      detailDuration.toFixed(1)
    }ms ${harnessTimings} total=${totalDuration.toFixed(1)}ms`,
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
  const queryStartedAt = performance.now();
  let result: SessionListResponse;
  if (archiveRepository) {
    result = archiveRepository.listSessions(
      page,
      pageSize,
      harness === "all" ? undefined : harness as SessionSummary["harness"],
    );
  } else if (harness !== "all") {
    result = listSessions(
      repositoryForHarness(harness as SessionSummary["harness"]),
      page,
      pageSize,
    );
  } else {
    const openCode = listSessions(repository, 1, page * pageSize);
    const claude = listSessions(claudeRepository, 1, page * pageSize);
    const pi = listSessions(piRepository, 1, page * pageSize);
    const codex = listSessions(codexRepository, 1, page * pageSize);
    const totalItems = openCode.pagination.totalItems +
      claude.pagination.totalItems + pi.pagination.totalItems +
      codex.pagination.totalItems;
    result = {
      items: [
        ...openCode.items,
        ...claude.items,
        ...pi.items,
        ...codex.items,
      ].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }
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
  const harness = context.req.query("harness");
  const session = harness === "claude-code"
    ? claudeRepository?.getSession(context.req.param("id"))
    : harness === "pi"
    ? piRepository?.getSession(context.req.param("id"))
    : harness === "codex"
    ? codexRepository?.getSession(context.req.param("id"))
    : repository?.getSession(context.req.param("id"));
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

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
Deno.serve({
  port,
  onListen: ({ port }) =>
    console.log(`Frugal Tokens API listening on http://localhost:${port}`),
}, app.fetch);
await syncSources();
if (archiveRepository && syncIntervalSeconds !== undefined) {
  void syncSourcesPeriodically(syncIntervalSeconds);
}
