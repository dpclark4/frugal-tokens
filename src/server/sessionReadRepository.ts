import type {
  SessionDetail,
  SessionListResponse,
  SessionMissFilter,
  SessionSummary,
} from "../shared/sessionSchemas.ts";
import { sessionListResponseSchema } from "../shared/sessionSchemas.ts";
import { ConversationCompatibilityRepository } from "./conversationCompatibilityRepository.ts";
import {
  type InitialInputDistribution,
  type ModelCallCostSummary,
  SessionRepository,
} from "./sessionRepository.ts";

type Harness = SessionSummary["harness"];
const harnesses: Harness[] = ["opencode", "claude-code", "pi", "codex"];

function percentile(values: number[], quantile: number) {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const remainder = index - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * remainder ||
    sorted[lower];
}

/** Per-harness read delegation with legacy retained as a rollback provider. */
export class SessionReadRepository {
  #scopedIDs = new Map<string, number>();

  constructor(
    private legacy: SessionRepository,
    private conversations: ConversationCompatibilityRepository,
    private conversationHarnesses: ReadonlySet<Harness>,
  ) {}

  #provider(harness: Harness) {
    return this.conversationHarnesses.has(harness)
      ? this.conversations
      : this.legacy;
  }

  #allConversationReads() {
    return harnesses.every((item) => this.conversationHarnesses.has(item));
  }

  #scopedID(kind: "session" | "turn" | "call", harness: Harness, id: number) {
    const key = `${kind}:${harness}:${id}`;
    const existing = this.#scopedIDs.get(key);
    if (existing !== undefined) return existing;
    const value = this.#scopedIDs.size + 1;
    this.#scopedIDs.set(key, value);
    return value;
  }

  listSessions(
    page: number,
    pageSize: number,
    harness?: Harness,
    missFilters?: SessionMissFilter[],
  ): SessionListResponse {
    if (harness !== undefined) {
      return this.#provider(harness).listSessions(
        page,
        pageSize,
        harness,
        missFilters,
      );
    }
    if (
      !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) ||
      pageSize < 1
    ) throw new RangeError("page and pageSize must be positive integers");
    if (this.#allConversationReads()) {
      return this.conversations.listSessions(
        page,
        pageSize,
        undefined,
        missFilters,
      );
    }
    const items = harnesses.flatMap((harness) =>
      this.#provider(harness).listSessions(
        1,
        1_000_000,
        harness,
        missFilters,
      ).items.map((item) => ({
        ...item,
        ...(item.internalID === undefined ? {} : {
          internalID: this.#scopedID("session", harness, item.internalID),
        }),
      }))
    ).sort((a, b) =>
      b.updatedAt - a.updatedAt || b.id.localeCompare(a.id) ||
      b.harness.localeCompare(a.harness)
    );
    const totalItems = items.length;
    return sessionListResponseSchema.parse({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    });
  }

  getSession(harness: Harness, id: string): SessionDetail | undefined {
    return this.#provider(harness).getSession(harness, id);
  }

  enrichSessionSummaries(items: SessionSummary[]): SessionSummary[] {
    const conversationItems = items.filter((item) =>
      this.conversationHarnesses.has(item.harness)
    );
    const enriched = new Map(
      this.conversations.enrichSessionSummaries(conversationItems).map((
        item,
      ) => [`${item.harness}:${item.id}`, item]),
    );
    return items.map((item) =>
      enriched.get(`${item.harness}:${item.id}`) ?? item
    );
  }

  listUsageCalls(startedAt?: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listUsageCalls(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listUsageCalls(startedAt, item).map((call) => ({
          ...call,
          ...(call.modelCallID === undefined ? {} : {
            modelCallID: this.#scopedID("call", item, call.modelCallID),
          }),
          ...(call.previousModelCallID === undefined ? {} : {
            previousModelCallID: this.#scopedID(
              "call",
              item,
              call.previousModelCallID,
            ),
          }),
        }))
      ).sort((a, b) => a.startedAt - b.startedAt)
      : this.#provider(harness).listUsageCalls(startedAt, harness);
  }

  listCacheMisses(startedAt?: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listCacheMisses(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listCacheMisses(startedAt, item).map((miss) => ({
          ...miss,
          modelCallID: this.#scopedID("call", item, miss.modelCallID),
          ...(miss.previousModelCallID === undefined ? {} : {
            previousModelCallID: this.#scopedID(
              "call",
              item,
              miss.previousModelCallID,
            ),
          }),
          turnID: this.#scopedID("turn", item, miss.turnID),
        }))
      )
      : this.#provider(harness).listCacheMisses(startedAt, harness);
  }

  summarizeModelCallCosts(
    startedAt: number,
    harness?: Harness,
  ): ModelCallCostSummary {
    if (harness !== undefined) {
      return this.#provider(harness).summarizeModelCallCosts(
        startedAt,
        harness,
      );
    }
    if (this.#allConversationReads()) {
      return this.conversations.summarizeModelCallCosts(startedAt);
    }
    const values = harnesses.map((item) =>
      this.#provider(item).summarizeModelCallCosts(startedAt, item)
    );
    return {
      totalCost: values.reduce((sum, value) => sum + value.totalCost, 0),
      hasUnpricedTotalCost: values.some((value) => value.hasUnpricedTotalCost),
      totalSessionCost: values.reduce(
        (sum, value) => sum + value.totalSessionCost,
        0,
      ),
      hasUnpricedSessionCost: values.some((value) =>
        value.hasUnpricedSessionCost
      ),
      sessions: values.flatMap((value) => value.sessions),
    };
  }

  listToolCalls(startedAt: number, endedAt: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listToolCalls(startedAt, endedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listToolCalls(startedAt, endedAt, item).map(
          (call) => ({
            ...call,
            modelCallID: this.#scopedID("call", item, call.modelCallID),
          }),
        )
      )
      : this.#provider(harness).listToolCalls(startedAt, endedAt, harness);
  }

  listOverviewRollups(startedAt: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listOverviewRollups(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listOverviewRollups(startedAt, item).map(
          (rollup) => ({
            ...rollup,
            rootSessionID: this.#scopedID(
              "session",
              item,
              rollup.rootSessionID,
            ),
          }),
        )
      )
      : this.#provider(harness).listOverviewRollups(startedAt, harness);
  }

  listSessionShapeRollups(startedAt: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listSessionShapeRollups(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listSessionShapeRollups(startedAt, item).map(
          (rollup) => ({
            ...rollup,
            rootSessionID: this.#scopedID(
              "session",
              item,
              rollup.rootSessionID,
            ),
          }),
        )
      )
      : this.#provider(harness).listSessionShapeRollups(startedAt, harness);
  }

  listUsageRollups(startedAt?: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listUsageRollups(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listUsageRollups(startedAt, item).map((
          rollup,
        ) => ({
          ...rollup,
          rootSessionID: this.#scopedID(
            "session",
            item,
            rollup.rootSessionID,
          ),
        }))
      )
      : this.#provider(harness).listUsageRollups(startedAt, harness);
  }

  listSubagentUsage(startedAt?: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listSubagentUsage(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listSubagentUsage(startedAt, item).map((
          usage,
        ) => ({
          ...usage,
          rootSessionID: this.#scopedID(
            "session",
            item,
            usage.rootSessionID,
          ),
          subagentSessionID: this.#scopedID(
            "session",
            item,
            usage.subagentSessionID,
          ),
        }))
      )
      : this.#provider(harness).listSubagentUsage(startedAt, harness);
  }

  listInitialInputSamples(startedAt?: number, harness?: Harness) {
    if (harness === undefined && this.#allConversationReads()) {
      return this.conversations.listInitialInputSamples(startedAt);
    }
    return harness === undefined
      ? harnesses.flatMap((item) =>
        this.#provider(item).listInitialInputSamples(startedAt, item)
      )
      : this.#provider(harness).listInitialInputSamples(startedAt, harness);
  }

  initialInputDistribution(
    startedAt: number,
    harness?: Harness,
  ): InitialInputDistribution | undefined {
    if (harness !== undefined) {
      return this.#provider(harness).initialInputDistribution(
        startedAt,
        harness,
      );
    }
    const values = this.listInitialInputSamples(startedAt).map((sample) =>
      sample.input
    );
    return values.length === 0 ? undefined : {
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
    };
  }
}
