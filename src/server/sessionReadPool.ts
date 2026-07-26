import type {
  SessionDetail,
  SessionListResponse,
  SessionSummary,
} from "../shared/sessionSchemas.ts";
import type { UsageCall } from "./usage.ts";
import { ReaderPool } from "./readerPool.ts";

type Harness = SessionSummary["harness"];

export type SessionReadRequest =
  | {
    operation: "listSessions";
    page: number;
    pageSize: number;
    harness?: Harness;
  }
  | { operation: "getSession"; harness: Harness; id: string }
  | { operation: "listUsageCalls"; startedAt?: number; harness?: Harness };

type SessionReadResult =
  | SessionListResponse
  | SessionDetail
  | UsageCall[]
  | undefined;

export interface SessionReader {
  listSessions(
    page: number,
    pageSize: number,
    harness?: Harness,
  ): Promise<SessionListResponse>;
  getSession(harness: Harness, id: string): Promise<SessionDetail | undefined>;
  listUsageCalls(startedAt?: number, harness?: Harness): Promise<UsageCall[]>;
}

export class SessionReadPool implements SessionReader {
  readonly #pool: ReaderPool<SessionReadRequest, SessionReadResult>;

  constructor(path: string, size: number) {
    const workerURL = new URL("./sessionReadWorker.ts", import.meta.url).href;
    this.#pool = new ReaderPool(
      size,
      () => new Worker(workerURL, { type: "module" }),
      { path },
    );
  }

  async listSessions(page: number, pageSize: number, harness?: Harness) {
    return await this.#pool.execute({
      operation: "listSessions",
      page,
      pageSize,
      harness,
    }) as SessionListResponse;
  }

  async getSession(harness: Harness, id: string) {
    return await this.#pool.execute({
      operation: "getSession",
      harness,
      id,
    }) as SessionDetail | undefined;
  }

  async listUsageCalls(startedAt?: number, harness?: Harness) {
    return await this.#pool.execute({
      operation: "listUsageCalls",
      startedAt,
      harness,
    }) as UsageCall[];
  }

  close() {
    this.#pool.close();
  }
}
