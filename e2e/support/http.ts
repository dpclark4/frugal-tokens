import { strictEqual } from "node:assert/strict";

export async function getJson(url: string, path: string, status = 200) {
  const response = await fetch(`${url}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  strictEqual(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}
