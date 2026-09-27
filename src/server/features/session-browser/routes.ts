import { Hono } from "hono";
import type { SessionSummary } from "../../../shared/sessionSchemas.ts";
import type { ConversationRepository } from "../../conversationRepository.ts";
import { enrichSessionSummary } from "../../sessionSummaryEnrichment.ts";
import { formatTiming } from "../../timing.ts";
import { parseSessionBrowserQuery } from "./query.ts";
import type { SessionBrowserRepository } from "./repository.ts";

export function sessionBrowserRoutes(
  browser: Pick<SessionBrowserRepository, "listSessions">,
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

  return new Hono().get("/", (context) => {
    const requestStartedAt = performance.now();
    const parsed = parseSessionBrowserQuery(context.req.query());
    if (parsed.error !== undefined) {
      return context.json({ error: parsed.error }, 400);
    }
    const { page, pageSize, harness, missFilters, sort } = parsed.value;
    const queryStartedAt = performance.now();
    const result = browser.listSessions(
      page,
      pageSize,
      harness === "all" ? undefined : harness,
      missFilters,
      sort,
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
      `[sessions] harness=${harness} page=${page} items=${items.length} database=${
        formatTiming(queryDuration)
      } enrichment=${formatTiming(enrichmentDuration)} total=${
        formatTiming(totalDuration)
      }`,
    );
    return context.json({ ...result, items });
  });
}
