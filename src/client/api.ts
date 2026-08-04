import {
  activityOverviewResponseSchema,
  overviewResponseSchema,
  performanceResponseSchema,
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionMissFilter,
  sessionShapeResponseSchema,
  toolCallsResponseSchema,
  ttlMissMetricsSchema,
  usageResponseSchema,
} from "../shared/sessionSchemas.ts";

const apiBaseUrl = (import.meta as ImportMeta & {
  env: { VITE_API_BASE_URL?: string };
}).env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";

async function getJson(path: string) {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    throw new Error(
      `API returned ${contentType ?? "unknown content"} for ${path}`,
    );
  }
  return response.json();
}

export async function syncSessions() {
  const response = await fetch(`${apiBaseUrl}/api/sync`, { method: "POST" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
}

export async function getUsage(range: number | "all", harness: string) {
  return usageResponseSchema.parse(
    await getJson(`/api/usage?range=${range}&harness=${harness}`),
  );
}

export async function getActivityOverview(
  range: 30 | 90,
  harness: string,
) {
  return activityOverviewResponseSchema.parse(
    await getJson(`/api/activity-overview?range=${range}&harness=${harness}`),
  );
}

export async function getSessionShape(
  range: 30 | 90,
  harness: string,
) {
  return sessionShapeResponseSchema.parse(
    await getJson(`/api/session-shape?range=${range}&harness=${harness}`),
  );
}

export async function getOverview(range: number | "all", harness: string) {
  return overviewResponseSchema.parse(
    await getJson(`/api/overview?range=${range}&harness=${harness}`),
  );
}

export async function getToolCalls(
  range: 7 | 30 | 90,
  harness: string,
  expanded: boolean,
) {
  const query = new URLSearchParams({
    range: String(range),
    harness,
    expand: String(expanded),
  });
  return toolCallsResponseSchema.parse(
    await getJson(`/api/tool-calls?${query}`),
  );
}

export async function getPerformance(
  harness: string,
  openaiModel: string,
  anthropicModel: string,
) {
  const query = new URLSearchParams({
    harness,
    openai: openaiModel,
    anthropic: anthropicModel,
  });
  return performanceResponseSchema.parse(
    await getJson(`/api/performance?${query}`),
  );
}

export async function getCacheMissOverview(
  range: number | "all",
  harness: string,
) {
  return ttlMissMetricsSchema.parse(
    await getJson(
      `/api/cache-misses/overview?range=${range}&harness=${harness}`,
    ),
  );
}

export async function getSessions(
  page: number,
  harness: string,
  missFilters?: SessionMissFilter[],
) {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "25",
    harness,
  });
  if (missFilters !== undefined) {
    query.set(
      "misses",
      missFilters.length === 0 ? "none" : missFilters.join(","),
    );
  }
  return sessionListResponseSchema.parse(
    await getJson(`/api/sessions?${query}`),
  );
}

export async function getSession(id: string, harness: string) {
  return sessionDetailSchema.parse(
    await getJson(`/api/sessions/${encodeURIComponent(id)}?harness=${harness}`),
  );
}
