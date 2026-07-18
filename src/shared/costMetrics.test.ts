import { deepStrictEqual } from "node:assert/strict";
import { rollupCosts } from "./costMetrics.ts";

Deno.test("rolls up known costs without turning unknown usage into zero", () => {
  deepStrictEqual(rollupCosts([0.06, undefined, 0.08]), {
    cost: 0.14,
    hasUnpricedCost: true,
  });
  deepStrictEqual(rollupCosts([undefined]), {
    cost: undefined,
    hasUnpricedCost: true,
  });
  deepStrictEqual(rollupCosts([0]), {
    cost: 0,
    hasUnpricedCost: false,
  });
});
