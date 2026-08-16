import {
  activityOverviewResponseSchema,
  costScenarioResponseSchema,
  harnessesResponseSchema,
  overviewResponseSchema,
  performanceResponseSchema,
  sessionDetailSchema,
  sessionListResponseSchema,
  type SessionMissFilter,
  sessionShapeResponseSchema,
  toolCallsResponseSchema,
  ttlMissMetricsSchema,
  usageResponseSchema,
  workRhythmOverviewResponseSchema,
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

export async function getHarnesses() {
  return harnessesResponseSchema.parse(await getJson("/api/harnesses"))
    .harnesses;
}

export async function getTitleGenerationSetting() {
  const value = await getJson("/api/settings/title-generation") as {
    enabled?: unknown;
  };
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid title generation setting response");
  }
  return value.enabled;
}

export async function setTitleGenerationSetting(enabled: boolean) {
  const response = await fetch(`${apiBaseUrl}/api/settings/title-generation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
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
  const query = new URLSearchParams({
    range: String(range),
    harness,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return activityOverviewResponseSchema.parse(
    await getJson(`/api/activity-overview?${query}`),
  );
}

export async function getWorkRhythm(
  range: 30 | 90,
  harness: string,
) {
  const query = new URLSearchParams({
    range: String(range),
    harness,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return workRhythmOverviewResponseSchema.parse(
    await getJson(`/api/work-rhythm?${query}`),
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

export async function getSessionCostScenario(
  id: string,
  harness: string,
  model: string,
  cacheTtl: "5m" | "1h",
) {
  const query = new URLSearchParams({ harness, model, cacheTtl });
  return costScenarioResponseSchema.parse(
    await getJson(
      `/api/sessions/${encodeURIComponent(id)}/cost-scenario?${query}`,
    ),
  );
}

export async function openSessionInGhostty(id: string, harness: string) {
  const query = new URLSearchParams({ harness });
  const response = await fetch(
    `${apiBaseUrl}/api/sessions/${
      encodeURIComponent(id)
    }/open-in-ghostty?${query}`,
    { method: "POST" },
  );
  if (response.ok) return;
  const body = await response.json().catch(() => undefined) as
    | { error?: string }
    | undefined;
  throw new Error(body?.error ?? `Request failed (${response.status})`);
}
