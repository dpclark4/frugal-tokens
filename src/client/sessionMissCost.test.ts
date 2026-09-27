import { strictEqual } from "node:assert/strict";
import { formatMissCost, sessionMissCost } from "./sessionMissCost.ts";

Deno.test("session and subagent miss totals preserve sub-cent amounts and coverage", () => {
  for (
    const [cost, expected] of [
      [0, "$0.00"],
      [0.001, "<$0.01"],
      [0.0099, "<$0.01"],
      [0.01, "$0.01"],
      [2.69, "$2.69"],
    ] as const
  ) {
    strictEqual(formatMissCost(cost), expected);
    strictEqual(formatMissCost(cost, true), `${expected}+`);
    strictEqual(
      sessionMissCost([{
        cacheAssessment: { status: "full-miss" },
        cacheMissCost: cost,
      }])?.amount,
      formatMissCost(cost),
    );
  }
});

Deno.test("miss cost omits calls without misses", () => {
  strictEqual(sessionMissCost([{}]), undefined);
});

Deno.test("miss cost sums full and partial misses", () => {
  const result = sessionMissCost([
    { cacheAssessment: { status: "full-miss" }, cacheMissCost: 0.32 },
    { cacheAssessment: { status: "partial-hit" }, cacheMissCost: 0.01 },
  ]);
  strictEqual(result?.amount, "$0.33");
});

Deno.test("miss cost distinguishes tiny, zero, and unavailable prices", () => {
  for (
    const [cost, amount] of [
      [0.001, "<$0.01"],
      [0, "$0.00"],
      [undefined, "unavailable"],
    ] as const
  ) {
    strictEqual(
      sessionMissCost([{
        cacheAssessment: { status: "partial-hit" },
        cacheMissCost: cost,
      }])?.amount,
      amount,
    );
  }
});

Deno.test("miss cost marks incomplete totals and explains coverage", () => {
  const result = sessionMissCost([
    { cacheAssessment: { status: "full-miss" }, cacheMissCost: 0.33 },
    { cacheAssessment: { status: "partial-hit" } },
  ]);
  strictEqual(result?.amount, "$0.33+");
  strictEqual(
    result?.title.includes("1 of 2 misses could not be priced"),
    true,
  );
});
