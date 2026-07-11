import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { OpenCodeRepository } from "./opencodeRepository.ts";
import { ClaudeCodeRepository } from "./claudeCodeRepository.ts";
import { priceSessionDetail } from "./pricing.ts";
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
const app = new Hono();

function priceSummaries(items: SessionSummary[]) {
  return items.map((item) => {
    const detail = item.harness === "claude-code"
      ? claudeRepository.getSession(item.id)
      : repository.getSession(item.id);
    return detail
      ? { ...item, computedCost: priceSessionDetail(detail).computedCost }
      : item;
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
  const openCode = repository.listSessions(1, page * pageSize);
  const claude = claudeRepository.listSessions(1, page * pageSize);
  const totalItems = openCode.pagination.totalItems +
    claude.pagination.totalItems;
  const items = [...openCode.items, ...claude.items]
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
  const session = context.req.query("harness") === "claude-code"
    ? claudeRepository.getSession(context.req.param("id"))
    : repository.getSession(context.req.param("id"));
  return session
    ? context.json(priceSessionDetail(session))
    : context.json({ error: "Session not found" }, 404);
});

app.get("/api/*", (context) => context.json({ error: "API route not found" }, 404));

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
console.log(`Frugal Tokens API listening on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
