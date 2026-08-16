export const dashboardChartFont = '"SFMono-Regular", Consolas, monospace';
export const dashboardChartLabelSize = 10;

export const integer = new Intl.NumberFormat("en-US");
export const decimal = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
export const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
export const monthName = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
export const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
