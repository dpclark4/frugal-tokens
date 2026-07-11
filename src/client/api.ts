import {
  sessionDetailSchema,
  sessionListResponseSchema,
} from "../shared/sessionSchemas.ts";

async function getJson(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    throw new Error(`API returned ${contentType ?? "unknown content"} for ${path}`);
  }
  return response.json();
}

export async function getSessions(page: number, harness: string) {
  return sessionListResponseSchema.parse(
    await getJson(`/api/sessions?page=${page}&pageSize=10&harness=${harness}`),
  );
}

export async function getSession(id: string, harness: string) {
  return sessionDetailSchema.parse(
    await getJson(`/api/sessions/${encodeURIComponent(id)}?harness=${harness}`),
  );
}
