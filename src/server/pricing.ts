import type { SessionDetail } from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import { computeModelCallCost, modelRateCard } from "../shared/modelPricing.ts";
export { computeModelCallCost } from "../shared/modelPricing.ts";
import {
  type CacheMissTokens,
  estimateCacheMissCost,
} from "./cacheMissPricing.ts";

export function estimateModelCacheMissCost(
  before: CacheMissTokens,
  after: CacheMissTokens,
  model: string,
  timestamp: number,
) {
  // A hit changes the billing category, not the request's context size. Resolve
  // short- versus long-context rates from the call where the miss occurred.
  const rates = modelRateCard(model, timestamp, contextSize(after));
  return rates && estimateCacheMissCost(rates, before, after);
}

export function priceSessionDetail(session: SessionDetail): SessionDetail {
  const turns = session.turns.map((turn) => ({
    ...turn,
    calls: turn.calls.map((call) => ({
      ...call,
      computedCost: computeModelCallCost(
        call.tokens,
        call.model,
        call.startedAt,
      ),
    })),
  }));
  const cost = rollupCosts(
    turns.flatMap((turn) => turn.calls.map((call) => call.computedCost)),
  );
  return {
    ...session,
    computedCost: cost.cost,
    turns,
    subagents: session.subagents.map(priceSessionDetail),
  };
}
