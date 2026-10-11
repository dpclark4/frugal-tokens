/** Zero-based ticks with a little headroom and clean 1/2/5 step sizes. */
export function compositionScale(maximum: number) {
  if (maximum <= 0) return { ceiling: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const target = maximum * 1.06;
  const roughStep = target / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1
    ? 1
    : normalized <= 2
    ? 2
    : normalized <= 5
    ? 5
    : 10;
  const step = factor * magnitude;
  const count = Math.ceil(target / step);
  const ticks = Array.from(
    { length: count + 1 },
    (_, index) => Number((index * step).toPrecision(12)),
  );
  return { ceiling: ticks[count], ticks };
}
