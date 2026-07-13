import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { OpenCodeRepository } from "./opencodeRepository.ts";
import { ClaudeCodeRepository } from "./claudeCodeRepository.ts";
import { PiRepository } from "./piRepository.ts";
import { CodexRepository } from "./codexRepository.ts";
import { priceSessionDetail } from "./pricing.ts";
import {
  analyzeSessionCache,
  summarizeSessionCache,
} from "./cacheAnalysis.ts";
import type { SessionDetail, SessionSummary } from "../shared/sessionSchemas.ts";

const openCodeDatabasePath = Deno.env.get("OPENCODE_DB_PATH");
if (!openCodeDatabasePath) {
  throw new Error("OPENCODE_DB_PATH must be set");
}
const repository = new OpenCodeRepository(openCodeDatabasePath);
const claudeCodeProjectPath = Deno.env.get("CLAUDE_CODE_PROJECT_PATH");
if (!claudeCodeProjectPath) {
  throw new Error("CLAUDE_CODE_PROJECT_PATH must be set");
}
const claudeRepository = new ClaudeCodeRepository(
  claudeCodeProjectPath,
);
const piSessionDirectory = Deno.env.get("PI_SESSION_DIR");
if (!piSessionDirectory) {
  throw new Error("PI_SESSION_DIR must be set");
}
const piRepository = new PiRepository(piSessionDirectory);
const codexSessionDirectory = Deno.env.get("CODEX_SESSION_DIR");
if (!codexSessionDirectory) {
  throw new Error("CODEX_SESSION_DIR must be set");
}
const codexRepository = new CodexRepository(codexSessionDirectory);
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
    const detail = repositoryForHarness(item.harness).getSession(item.id);
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

function allSessionsForHarness(harness: string) {
  const repositories = harness === "all"
    ? [repository, claudeRepository, piRepository, codexRepository]
    : [repositoryForHarness(harness as SessionSummary["harness"])];
  return repositories.flatMap((source) => {
    const firstPage = source.listSessions(1, 1);
    return firstPage.pagination.totalItems === 0
      ? []
      : source.listSessions(1, firstPage.pagination.totalItems).items;
  });
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
  const days = new Map<
    string,
    Map<string, { tokens: number; cost: number; priced: boolean }>
  >();
  let hasUnpricedCost = false;
  let callCount = 0;

  function addSession(session: SessionDetail) {
    for (const turn of session.turns) {
      for (const call of turn.calls) {
        if (start !== undefined && call.startedAt < start) continue;
        callCount++;
        const timestamp = new Date(call.startedAt);
        const date = [
          timestamp.getFullYear(),
          String(timestamp.getMonth() + 1).padStart(2, "0"),
          String(timestamp.getDate()).padStart(2, "0"),
        ].join("-");
        const models = days.get(date) ?? new Map();
        const bucket = models.get(call.model) ?? {
          tokens: 0,
          cost: 0,
          priced: true,
        };
        bucket.tokens += call.tokens.processed;
        bucket.priced &&= call.computedCost !== undefined;
        hasUnpricedCost ||= call.computedCost === undefined;
        bucket.cost += call.computedCost ?? 0;
        models.set(call.model, bucket);
        days.set(date, models);
      }
    }
    session.subagents.forEach(addSession);
  }

  const listStartedAt = performance.now();
  const summaries = allSessionsForHarness(harness);
  const listDuration = performance.now() - listStartedAt;
  const detailDurations = new Map<string, number>();
  let includedSessions = 0;
  for (const summary of summaries) {
    if (start !== undefined && summary.updatedAt < start) continue;
    const detailStartedAt = performance.now();
    const detail = repositoryForHarness(summary.harness).getSession(summary.id);
    if (detail) {
      addSession(priceSessionDetail(detail));
      includedSessions++;
    }
    const duration = performance.now() - detailStartedAt;
    detailDurations.set(
      summary.harness,
      (detailDurations.get(summary.harness) ?? 0) + duration,
    );
    if (duration >= 100) {
      console.warn(
        `[usage] slow session harness=${summary.harness} id=${summary.id} duration=${duration.toFixed(1)}ms`,
      );
    }
  }

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
    `list;dur=${listDuration.toFixed(1)}, details;dur=${detailDuration.toFixed(1)}, total;dur=${totalDuration.toFixed(1)}`,
  );
  console.info(
    `[usage] harness=${harness} range=${rangeParam} sessions=${includedSessions}/${summaries.length} calls=${callCount} days=${days.size} list=${listDuration.toFixed(1)}ms details=${detailDuration.toFixed(1)}ms ${harnessTimings} total=${totalDuration.toFixed(1)}ms`,
  );

  return context.json({
    hasUnpricedCost,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
      ([date, models]) => ({
        date,
        models: [...models.entries()].map(([model, bucket]) => ({
          model,
          tokens: bucket.tokens,
          cost: bucket.priced ? bucket.cost : undefined,
        })),
      }),
    ),
  });
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
    const result = repository.listSessions(page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "claude-code") {
    const result = claudeRepository.listSessions(page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "pi") {
    const result = piRepository.listSessions(page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  if (harness === "codex") {
    const result = codexRepository.listSessions(page, pageSize);
    return context.json({ ...result, items: priceSummaries(result.items) });
  }
  const openCode = repository.listSessions(1, page * pageSize);
  const claude = claudeRepository.listSessions(1, page * pageSize);
  const pi = piRepository.listSessions(1, page * pageSize);
  const codex = codexRepository.listSessions(1, page * pageSize);
  const totalItems = openCode.pagination.totalItems +
    claude.pagination.totalItems + pi.pagination.totalItems +
    codex.pagination.totalItems;
  const items = [...openCode.items, ...claude.items, ...pi.items, ...codex.items]
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
    ? claudeRepository.getSession(context.req.param("id"))
    : harness === "pi"
    ? piRepository.getSession(context.req.param("id"))
    : harness === "codex"
    ? codexRepository.getSession(context.req.param("id"))
    : repository.getSession(context.req.param("id"));
  return session
    ? context.json(analyzeSessionCache(priceSessionDetail(session)))
    : context.json({ error: "Session not found" }, 404);
});

app.get("/api/*", (context) => context.json({ error: "API route not found" }, 404));

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
console.log(`Frugal Tokens API listening on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
