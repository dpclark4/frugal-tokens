import type { ModelCall } from "../shared/sessionSchemas.ts";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function sessionMissCost(
  calls: Pick<ModelCall, "cacheAssessment" | "cacheMissCost">[],
) {
  const misses = calls.filter((call) =>
    call.cacheAssessment?.status === "full-miss" ||
    call.cacheAssessment?.status === "partial-hit"
  );
  if (misses.length === 0) return undefined;
  const priced = misses.filter((call) => call.cacheMissCost !== undefined);
  const unpriced = misses.length - priced.length;
  const cost = priced.reduce((sum, call) => sum + call.cacheMissCost!, 0);
  const amount = priced.length === 0
    ? "unavailable"
    : `${cost > 0 && cost < 0.01 ? "<$0.01" : money.format(cost)}${
      unpriced > 0 ? "+" : ""
    }`;
  const title = "Estimated cost attributed to tokens that missed the cache; " +
    "not the extra cost over a cache hit." +
    (unpriced > 0
      ? ` ${unpriced} of ${misses.length} misses could not be priced.`
      : "");
  return { amount, title, isPositive: cost > 0 };
}
