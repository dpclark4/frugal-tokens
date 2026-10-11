import { expect, test } from "vitest";
import { compositionScale } from "./compositionScale.ts";

test("rounds the weekly spend ceiling to clean, evenly spaced ticks", () => {
  expect(compositionScale(233.27)).toEqual({
    ceiling: 250,
    ticks: [0, 50, 100, 150, 200, 250],
  });
});

test("handles empty, fractional, and token-scale values", () => {
  expect(compositionScale(0).ceiling).toBe(1);
  expect(compositionScale(0.23)).toEqual({
    ceiling: 0.25,
    ticks: [0, 0.05, 0.1, 0.15, 0.2, 0.25],
  });
  expect(compositionScale(233_270_000)).toEqual({
    ceiling: 250_000_000,
    ticks: [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000, 250_000_000],
  });
});

test("keeps headroom when the largest bar is already a round number", () => {
  expect(compositionScale(250).ceiling).toBeGreaterThan(250);
});
