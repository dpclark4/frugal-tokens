import type { DatabaseSync } from "node:sqlite";
import type { SessionDetail, TokenUsage } from "../shared/sessionSchemas.ts";
import { ConversationRepository } from "./conversationRepository.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import { buildSessionRollup } from "./sessionRollups.ts";
import { enrichSessionSummary } from "./sessionSummaryEnrichment.ts";

const sessionTree = `WITH RECURSIVE tree(id, root_id) AS (
  SELECT id, id FROM conversations c WHERE NOT EXISTS (
    SELECT 1 FROM conversation_subagent_launches l WHERE l.child_conversation_id = c.id
  )
  UNION ALL
  SELECT l.child_conversation_id, tree.root_id FROM tree
  JOIN conversation_subagent_launches l ON l.parent_conversation_id = tree.id
)`;

type StoredCall = {
  id: number;
  conversation_id: number;
  model: string;
  provider: string;
  started_at: number;
  computed_cost: number | null;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
};

function callTokens(call: StoredCall): TokenUsage {
  return {
    uncachedInput: call.uncached_input_tokens,
    cacheRead: call.cache_read_tokens,
    cacheWrite: call.cache_write_tokens ?? undefined,
    cacheWrite5m: call.cache_write_5m_tokens ?? undefined,
    cacheWrite1h: call.cache_write_1h_tokens ?? undefined,
    freshPrompt: call.fresh_prompt_tokens,
    output: call.output_tokens,
    reasoning: call.reasoning_tokens,
    processed: call.processed_tokens,
  };
}

function rollupTree(
  session: SessionDetail,
  parentExternalID?: string,
): Parameters<typeof buildSessionRollup>[0] {
  return [
    { session, parentExternalID },
    ...session.subagents.flatMap((child) => rollupTree(child, session.id)),
  ];
}

export type SessionRepricingResult = {
  conversationID: number;
  updatedCalls: number;
  remainingUnpricedCalls: number;
};

/** Repairs missing calculated prices without rereading sources or replacing sessions. */
export class SessionRepricingService {
  constructor(private db: DatabaseSync) {}

  findUnpricedSessionIDs(): number[] {
    // SAFETY: The static SQL projection defines this row contract.
    const rows = this.db.prepare(`${sessionTree}
      SELECT DISTINCT tree.root_id AS id FROM tree
      JOIN conversation_model_calls call ON call.conversation_id = tree.id
      WHERE call.computed_cost IS NULL
    `).all() as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  repriceSessions(ids: number[]): SessionRepricingResult[] {
    return [...new Set(ids)].map((id) => this.#repriceSession(id));
  }

  #repriceSession(id: number): SessionRepricingResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // SAFETY: The static SQL projection defines this row contract.
      const root = this.db.prepare(`
        SELECT s.harness, COALESCE(c.public_id, c.external_id) AS public_id
        FROM conversations c JOIN sources s ON s.id = c.source_id
        WHERE c.id = ? AND NOT EXISTS (
          SELECT 1 FROM conversation_subagent_launches l WHERE l.child_conversation_id = c.id
        )
      `).get(id) as
        | { harness: SessionDetail["harness"]; public_id: string }
        | undefined;
      if (!root) throw new Error(`Unknown root conversation: ${id}`);
      // SAFETY: The static SQL projection defines this row contract.
      const calls = this.db.prepare(`${sessionTree}
        SELECT call.* FROM conversation_model_calls call
        JOIN tree ON tree.id = call.conversation_id WHERE tree.root_id = ?
      `).all(id) as StoredCall[];
      const updates = calls.filter((call) => call.computed_cost === null)
        .flatMap((call) => {
          const cost = computeModelCallCost(
            callTokens(call),
            call.model,
            call.started_at,
            call.provider,
          );
          return cost === undefined ? [] : [{ call, cost }];
        });
      const remainingUnpricedCalls = calls.filter((call) =>
        call.computed_cost === null
      ).length - updates.length;
      if (updates.length > 0) {
        const updateCall = this.db.prepare(
          "UPDATE conversation_model_calls SET computed_cost = ? WHERE id = ?",
        );
        for (const { call, cost } of updates) updateCall.run(cost, call.id);
        const conversationIDs = new Set(
          calls.map((call) => call.conversation_id),
        );
        for (const conversationID of conversationIDs) {
          this.db.prepare(`UPDATE conversation_rollups SET computed_cost = (
            SELECT CASE WHEN COUNT(*) > 0 AND COUNT(computed_cost) = COUNT(*)
              THEN SUM(computed_cost) END FROM conversation_model_calls WHERE conversation_id = ?
          ) WHERE conversation_id = ?`).run(conversationID, conversationID);
        }
        this.#refreshCacheMissPrices(calls);
        const detail = new ConversationRepository(this.db).getSession(
          root.harness,
          root.public_id,
        );
        if (!detail) throw new Error(`Cannot hydrate conversation: ${id}`);
        const rollup = buildSessionRollup(rollupTree(detail));
        const summary = enrichSessionSummary(detail);
        this.db.prepare(
          `UPDATE conversation_rollups SET overview_json = ?, summary_json = ?
          WHERE conversation_id = ?`,
        ).run(JSON.stringify(rollup.overview), JSON.stringify(summary), id);
      }
      this.db.exec("COMMIT");
      return {
        conversationID: id,
        updatedCalls: updates.length,
        remainingUnpricedCalls,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #refreshCacheMissPrices(calls: StoredCall[]) {
    const byID = new Map(calls.map((call) => [call.id, call]));
    const select = this.db.prepare(
      `SELECT previous_model_call_id, previous_reusable_tokens
      FROM conversation_cache_misses WHERE model_call_id = ?`,
    );
    const update = this.db.prepare(`UPDATE conversation_cache_misses SET
      model_call_cost = ?, actual_missed_cost = ?, expected_read_cost = ?, estimated_extra_cost = ?
      WHERE model_call_id = ?`);
    for (const call of calls) {
      // SAFETY: The static SQL projection defines this row contract.
      const miss = select.get(call.id) as {
        previous_model_call_id: number | null;
        previous_reusable_tokens: number | null;
      } | undefined;
      if (!miss) continue;
      const previous = byID.get(miss.previous_model_call_id!);
      if (!previous) continue;
      const estimate = estimateModelCacheMissCost(
        callTokens(previous),
        callTokens(call),
        call.model,
        call.started_at,
        call.provider,
        miss.previous_reusable_tokens ?? undefined,
      );
      update.run(
        computeModelCallCost(
          callTokens(call),
          call.model,
          call.started_at,
          call.provider,
        ) ?? null,
        estimate?.actualMissedCost ?? null,
        estimate?.expectedReadCost ?? null,
        estimate?.estimatedExtraCost ?? null,
        call.id,
      );
    }
  }
}

export function repriceUnpricedSessions(db: DatabaseSync) {
  const service = new SessionRepricingService(db);
  const ids = service.findUnpricedSessionIDs();
  const summarize = ids.length > 5;
  let updated = 0;
  let notUpdated = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const [result] = service.repriceSessions([id]);
      if (result.updatedCalls > 0) updated++;
      else notUpdated++;
      if (!summarize) {
        console.info(
          `[reprice] session=${id} updated_calls=${result.updatedCalls} remaining_unpriced_calls=${result.remainingUnpricedCalls} status=${
            result.remainingUnpricedCalls === 0 ? "priced" : "unpriced"
          }`,
        );
      }
    } catch (error) {
      failed++;
      console.error(`[reprice] session=${id} failed`, error);
    }
  }
  if (summarize) {
    console.info(
      `[reprice] sessions=${ids.length} updated=${updated} not_updated=${notUpdated} failed=${failed}`,
    );
  }
}
