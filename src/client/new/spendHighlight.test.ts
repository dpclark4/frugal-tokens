import { expect, test, vi } from "vitest";
import { createSpendHighlight } from "./spendHighlight.ts";

test("notifies only subscribers, retains snapshot identity, and clears on leave", () => {
  const highlight = createSpendHighlight();
  const listener = vi.fn();
  const unsubscribe = highlight.subscribe(listener);
  const dates = ["2026-07-13"];
  highlight.set(dates);
  expect(highlight.getSnapshot()).toBe(dates);
  expect(listener).toHaveBeenCalledTimes(1);
  highlight.set(dates);
  expect(listener).toHaveBeenCalledTimes(1);
  highlight.set(undefined);
  expect(highlight.getSnapshot()).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  highlight.set(dates);
  expect(listener).toHaveBeenCalledTimes(2);
});

test("dashboard instances do not share hover state", () => {
  const first = createSpendHighlight();
  const second = createSpendHighlight();
  first.set(["2026-07-13"]);
  expect(second.getSnapshot()).toBeUndefined();
});
