import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { OpenCodeRepository } from "./opencodeRepository.ts";
import { ClaudeCodeRepository } from "./claudeCodeRepository.ts";
import { PiRepository } from "./piRepository.ts";
import { CodexRepository } from "./codexRepository.ts";
import { computeModelCallCost, priceSessionDetail } from "./pricing.ts";
import { analyzeSessionCache, summarizeSessionCache } from "./cacheAnalysis.ts";
import type {
  SessionDetail,
  SessionSummary,
} from "../shared/sessionSchemas.ts";
import type { UsageCall } from "./usage.ts";
import { aggregateUsage } from "./usageAnalytics.ts";
import { openArchiveDatabase, sqlitePath } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";
import { syncPiSessions } from "./piImporter.ts";
import { syncCodexSessions } from "./codexImporter.ts";
import { syncClaudeCodeSessions } from "./claudeCodeImporter.ts";

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
const repository = configuredPath(
  "opencode",
  "OPENCODE_DB_PATH",
  "file",
  (path) => new OpenCodeRepository(path),
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
if (archiveRepository && claudeDirectory) {
  const result = await syncClaudeCodeSessions(
    claudeDirectory,
    archiveRepository,
  );
  console.info(
    `[sync] harness=claude-code discovered=${result.discovered} imported=${result.imported} skipped=${result.skipped} failed=${result.failed}`,
  );
}
if (archiveRepository && piDirectory) {
  const result = await syncPiSessions(piDirectory, archiveRepository);
  console.info(
    `[sync] harness=pi discovered=${result.discovered} imported=${result.imported} skipped=${result.skipped} failed=${result.failed}`,
  );
}
if (archiveRepository && codexDirectory) {
  const result = await syncCodexSessions(codexDirectory, archiveRepository);
  console.info(
    `[sync] harness=codex discovered=${result.discovered} imported=${result.imported} skipped=${result.skipped} failed=${result.failed}`,
  );
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
const app = new Hono();

function repositoryForHarness(harness: SessionSummary["harness"]) {
  if (harness === "claude-code") return claudeRepository;
  if (harness === "pi") return piRepository;
  if (harness === "codex") return codexRepository;
  return repository;
}

type SubagentTotals = { count: number; modelCalls: number };

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

function priceSummaries(items: SessionSummary[]) {
  return items.map((item) => {
    const detail = repositoryForHarness(item.harness)?.getSession(item.id);
    if (!detail) return item;
    const priced = priceSessionDetail(detail);
    const analyzed = analyzeSessionCache(priced);
    const subagents = subagentTotals(priced.subagents);
    return {
      ...item,
      computedCost: priced.computedCost,
      cacheSummary: summarizeSessionCache(analyzed),
      subagentCount: subagents.count,
      subagentModelCalls: subagents.modelCalls,
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
  const page = Math.max(
    1,
    Number.parseInt(context.req.query("page") ?? "1", 10) || 1,
  );
  const requestedPageSize =
    Number.parseInt(context.req.query("pageSize") ?? "10", 10) || 10;
  const pageSize = Math.min(100, Math.max(1, requestedPageSize));
  const harness = context.req.query("harness") ?? "all";
  if (harness === "opencode") {
    const result = listSessions(repository, page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "claude-code") {
    const result = listSessions(claudeRepository, page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "pi") {
    const result = listSessions(piRepository, page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "codex") {
    const result = listSessions(codexRepository, page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  const openCode = listSessions(repository, 1, page * pageSize);
  const claude = listSessions(claudeRepository, 1, page * pageSize);
  const pi = listSessions(piRepository, 1, page * pageSize);
  const codex = listSessions(codexRepository, 1, page * pageSize);
  const totalItems = openCode.pagination.totalItems +
    claude.pagination.totalItems + pi.pagination.totalItems +
    codex.pagination.totalItems;
  const items = [
    ...openCode.items,
    ...claude.items,
    ...pi.items,
    ...codex.items,
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
    .slice((page - 1) * pageSize, page * pageSize);
  return context.json({
    items: priceSummaries(items),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    },
  });
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

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
console.log(`Frugal Tokens API listening on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
