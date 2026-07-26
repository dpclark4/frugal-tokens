/// <reference lib="deno.worker" />

import { openArchiveReader } from "./database.ts";
import { SessionRepository } from "./sessionRepository.ts";
import type { SessionReadRequest } from "./sessionReadPool.ts";

let repository: SessionRepository | undefined;

function errorMessage(error: unknown) {
  return error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error) };
}

self.onmessage = (
  event: MessageEvent<
    | { type: "initialize"; value: { path: string } }
    | { type: "execute"; id: number; request: SessionReadRequest }
  >,
) => {
  const message = event.data;
  if (message.type === "initialize") {
    try {
      repository = new SessionRepository(openArchiveReader(message.value.path));
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "error", ...errorMessage(error) });
    }
    return;
  }

  try {
    if (!repository) throw new Error("Reader worker is not initialized");
    const request = message.request;
    const result = request.operation === "listSessions"
      ? repository.listSessions(
        request.page,
        request.pageSize,
        request.harness,
      )
      : request.operation === "getSession"
      ? repository.getSession(request.harness, request.id)
      : repository.listUsageCalls(request.startedAt, request.harness);
    self.postMessage({ type: "result", id: message.id, result });
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      ...errorMessage(error),
    });
  }
};
