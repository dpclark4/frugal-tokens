import { Hono } from "hono";
import { compactHomePath } from "../../database.ts";
import {
  harnessSchema,
  type SessionSummary,
} from "../../../shared/sessionSchemas.ts";
import type { ConversationRepository } from "../../conversationRepository.ts";
import { enrichSessionSummary } from "../../sessionSummaryEnrichment.ts";
import { formatTiming } from "../../timing.ts";
import { parseSessionBrowserQuery } from "./query.ts";
import type { SessionBrowserRepository } from "./repository.ts";

export function sessionBrowserRoutes(
  browser: Pick<
    SessionBrowserRepository,
    "listSessions" | "listModels" | "listDirectories"
  >,
  conversations: Pick<
    ConversationRepository,
    "enrichSessionSummaries" | "getSession"
  >,
) {
  function priceSummaries(items: SessionSummary[]) {
    return items.map((item) => {
      if (
        item.cacheSummary !== undefined && item.compactionCount !== undefined &&
        item.inclusiveTokens !== undefined
      ) return item;
      const detail = conversations.getSession(item.harness, item.id);
      if (!detail) return item;
      return enrichSessionSummary(detail);
    });
  }

  const app = new Hono();
  app.get("/filter-options", (context) => {
    const requestStartedAt = performance.now();
    const harness = context.req.query("harness") ?? "all";
    const parsedHarness = harnessSchema.safeParse(harness);
    if (harness !== "all" && !parsedHarness.success) {
      return context.json({ error: "Invalid harness" }, 400);
    }
    const queryStartedAt = performance.now();
    const models = browser.listModels(
      parsedHarness.success ? parsedHarness.data : undefined,
    );
    const directories = browser.listDirectories(
      parsedHarness.success ? parsedHarness.data : undefined,
    );
    const queryDuration = performance.now() - queryStartedAt;
    const totalDuration = performance.now() - requestStartedAt;
    context.header(
      "Server-Timing",
      `database;dur=${queryDuration.toFixed(1)}, total;dur=${
        totalDuration.toFixed(1)
      }`,
    );
    console.info(
      `[session-filter-options] harness=${harness} models=${models.length} database=${
        formatTiming(queryDuration)
      } total=${formatTiming(totalDuration)}`,
    );
    return context.json({
      models,
      directories: directories.map((option) => ({
        ...option,
        displayPath: option.path === null
          ? undefined
          : compactHomePath(option.path),
      })),
    });
  });

  return app.get("/", (context) => {
    const requestStartedAt = performance.now();
    const parsed = parseSessionBrowserQuery(
      context.req.query(),
      context.req.queries("model"),
      context.req.queries("directory"),
    );
    if (parsed.error !== undefined) {
      return context.json({ error: parsed.error }, 400);
    }
    const { page, pageSize, harness, missFilters, sort, models, directories } =
      parsed.value;
    const queryStartedAt = performance.now();
    const result = browser.listSessions(
      page,
      pageSize,
      harness === "all" ? undefined : harness,
      missFilters,
      sort,
      models,
      directories,
    );
    const queryDuration = performance.now() - queryStartedAt;
    const enrichmentStartedAt = performance.now();
    const items = priceSummaries(
      conversations.enrichSessionSummaries(result.items),
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
      `[sessions] harness=${harness} models=${models.length} page=${page} items=${items.length} database=${
        formatTiming(queryDuration)
      } enrichment=${formatTiming(enrichmentDuration)} total=${
        formatTiming(totalDuration)
      }`,
    );
    return context.json({ ...result, items });
  });
}
