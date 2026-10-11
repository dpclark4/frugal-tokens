import { afterEach, expect, test, vi } from "vitest";
import { hoverIntent } from "./hoverIntent.ts";

afterEach(() => vi.useRealTimers());

test("crossed points never show delayed tooltips", () => {
  vi.useFakeTimers();
  const show = vi.fn();
  const hover = hoverIntent(show);
  for (let point = 0; point < 1000; point++) {
    hover.enter(point);
    vi.advanceTimersByTime(10);
    hover.leave();
  }
  vi.runAllTimers();
  expect(show.mock.calls.every(([value]) => value === undefined)).toBe(true);
});

test("only the current settled point opens and leaving closes immediately", () => {
  vi.useFakeTimers();
  const show = vi.fn();
  const hover = hoverIntent(show);
  hover.enter("first");
  vi.advanceTimersByTime(50);
  hover.enter("second");
  vi.advanceTimersByTime(74);
  expect(show).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(show).toHaveBeenCalledExactlyOnceWith("second");
  hover.leave();
  expect(show).toHaveBeenLastCalledWith(undefined);
});

test("keyboard focus is immediate and cancels pending mouse hovers", () => {
  vi.useFakeTimers();
  const show = vi.fn();
  const hover = hoverIntent(show);
  hover.enter("mouse");
  hover.enter("keyboard", true);
  vi.runAllTimers();
  expect(show).toHaveBeenCalledExactlyOnceWith("keyboard");
});

test("cleanup cancels pending updates", () => {
  vi.useFakeTimers();
  const show = vi.fn();
  const hover = hoverIntent(show);
  hover.enter("removed");
  hover.cancel();
  vi.runAllTimers();
  expect(show).not.toHaveBeenCalled();
});
