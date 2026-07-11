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
import type { SessionSummary } from "../shared/sessionSchemas.ts";

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

function priceSummaries(items: SessionSummary[]) {
  return items.map((item) => {
    const detail = repositoryForHarness(item.harness).getSession(item.id);
    if (!detail) return item;
    const priced = priceSessionDetail(detail);
    const analyzed = analyzeSessionCache(priced);
    return {
      ...item,
      computedCost: priced.computedCost,
      cacheSummary: summarizeSessionCache(analyzed),
    };
  });
}

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
