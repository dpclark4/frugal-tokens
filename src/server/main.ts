import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { OpenCodeRepository } from "./opencodeRepository.ts";

const defaultDatabasePath = `${
  Deno.env.get("HOME")
}/.local/share/opencode/opencode.db`;
const repository = new OpenCodeRepository(
  Deno.env.get("OPENCODE_DB_PATH") ?? defaultDatabasePath,
);
const app = new Hono();

app.get("/api/sessions", (context) => {
  const page = Math.max(
    1,
    Number.parseInt(context.req.query("page") ?? "1", 10) || 1,
  );
  const requestedPageSize =
    Number.parseInt(context.req.query("pageSize") ?? "10", 10) || 10;
  const pageSize = Math.min(100, Math.max(1, requestedPageSize));
  return context.json(repository.listSessions(page, pageSize));
});

app.get("/api/sessions/:id", (context) => {
  const session = repository.getSession(context.req.param("id"));
  return session
    ? context.json(session)
    : context.json({ error: "Session not found" }, 404);
});

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const port = Number.parseInt(Deno.env.get("PORT") ?? "9000", 10);
console.log(`Frugal Tokens API listening on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
