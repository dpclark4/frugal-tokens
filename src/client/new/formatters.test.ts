import { strictEqual } from "node:assert/strict";
import { rollupCosts } from "../../shared/costMetrics.ts";
import { formatCacheMissCost } from "./formatters.ts";

Deno.test("cache miss costs distinguish missing, zero, and sub-cent estimates", () => {
  strictEqual(formatCacheMissCost(undefined), "N/A");
  strictEqual(formatCacheMissCost(0), "$0.00");
  strictEqual(formatCacheMissCost(0.000010416666666666666), "<$0.01");
  strictEqual(formatCacheMissCost(0.00256), "<$0.01");
  strictEqual(formatCacheMissCost(0.00999), "<$0.01");
  strictEqual(formatCacheMissCost(0.01), "$0.01");
  strictEqual(formatCacheMissCost(2.91), "$2.91");
});

Deno.test("cache miss totals use raw amounts before formatting", () => {
  const total = rollupCosts([0.006, 0.006, undefined]);
  strictEqual(total.hasUnpricedCost, true);
  strictEqual(formatCacheMissCost(total.cost), "$0.01");
});
