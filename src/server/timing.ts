import prettyMilliseconds from "pretty-ms";

export function formatTiming(milliseconds: number) {
  return prettyMilliseconds(milliseconds, { millisecondsDecimalDigits: 1 });
}
