import {
  sessionDetailSchema,
  sessionListResponseSchema,
} from "../shared/sessionSchemas.ts";

async function getJson(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export async function getSessions(page: number) {
  return sessionListResponseSchema.parse(
    await getJson(`/api/sessions?page=${page}&pageSize=10`),
  );
}

export async function getSession(id: string) {
  return sessionDetailSchema.parse(
    await getJson(`/api/sessions/${encodeURIComponent(id)}`),
  );
}
