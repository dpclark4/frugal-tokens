import { canonicalModelId, displayModelName } from "../shared/modelNames.ts";
import type {
  OverviewResponse,
  TtlMissMetrics,
  UsageResponse,
} from "../shared/sessionSchemas.ts";

export type ReportRange = 7 | 30 | 90 | "all";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type Distribution = NonNullable<OverviewResponse["sessionProfile"]["turns"]>;
type ModelTotal = { model: string; input: number; spend: number };

function cell(value: string | number) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers: string[], rows: Array<Array<string | number>>) {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function percent(value?: number) {
  return value === undefined ? "-" : `${decimal.format(value * 100)}%`;
}

function share(value: number, total: number) {
  return percent(total === 0 ? 0 : value / total);
}

function duration(value: number) {
  const minutes = value / 60_000;
  if (minutes < 1) return `${integer.format(value / 1_000)} sec`;
  if (minutes < 60) return `${decimal.format(minutes)} min`;
  return `${decimal.format(minutes / 60)} hr`;
}

function days(value: number) {
  const formatted = decimal.format(value);
  return `${formatted} ${formatted === decimal.format(1) ? "day" : "days"}`;
}

function distributionRow(
  label: string,
  values: Distribution | undefined,
  format: (value: number) => string = decimal.format,
) {
  return [
    label,
    values ? format(values.median) : "-",
    values ? format(values.average) : "-",
    values ? format(values.p90) : "-",
  ];
}

function rangeLabel(range: ReportRange) {
  return range === "all" ? "All time" : `Last ${range} days`;
}

function harnessLabel(harness: string) {
  const labels: Record<string, string> = {
    all: "All",
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    pi: "Pi",
  };
  return labels[harness] ?? harness;
}

function modelTotals(usage: UsageResponse) {
  const totals = new Map<string, ModelTotal>();
  for (const day of usage.days) {
    for (const item of day.models) {
      const model = canonicalModelId(item.model);
      const total = totals.get(model) ?? { model, input: 0, spend: 0 };
      total.input += item.input;
      total.spend += item.cost ?? 0;
      totals.set(model, total);
    }
  }
  return [...totals.values()];
}

function topModelRows(
  totals: ModelTotal[],
  metric: "spend" | "input",
) {
  const ranked = [...totals].sort((a, b) =>
    b[metric] - a[metric] || a.model.localeCompare(b.model)
  );
  const total = ranked.reduce((sum, model) => sum + model[metric], 0);
  const shown = ranked.slice(0, 5);
  const other = ranked.slice(5);
  const rows: Array<Array<string | number>> = shown.map((model) => [
    displayModelName(model.model),
    metric === "spend" ? money.format(model.spend) : integer.format(model.input),
    share(model[metric], total),
  ]);
  if (other.length > 0) {
    const otherTotal = other.reduce((sum, model) => sum + model[metric], 0);
    rows.push([
      "Other models",
      metric === "spend" ? money.format(otherTotal) : integer.format(otherTotal),
      share(otherTotal, total),
    ]);
  }
  return { rows, total };
}

export function buildHomepageReport({
  overview,
  cacheMisses,
  usage,
  overviewRange,
  usageRange,
  harness,
}: {
  overview: OverviewResponse;
  cacheMisses: TtlMissMetrics;
  usage: UsageResponse;
  overviewRange: ReportRange;
  usageRange: ReportRange;
  harness: string;
}) {
  const sections: string[] = ["# Frugal Tokens Report"];
  const sameRange = overviewRange === usageRange;
  sections.push(table(
    sameRange ? ["Period", "Harness", "Generated"] : [
      "Overview / cache period",
      "Chart period",
      "Harness",
      "Generated",
    ],
    [sameRange
      ? [rangeLabel(overviewRange), harnessLabel(harness), new Date().toISOString()]
      : [
        rangeLabel(overviewRange),
        rangeLabel(usageRange),
        harnessLabel(harness),
        new Date().toISOString(),
      ]],
  ));

  const knownSpend = overview.models.reduce((sum, model) => sum + model.spend, 0);
  const totalInput = overview.models.reduce((sum, model) => sum + model.input, 0);
  sections.push("## Summary\n\n" + table(
    ["Active days", "Sessions", "Spend", "Input processed", "Token reuse", "Multi-day sessions"],
    [[
      integer.format(overview.activeDays),
      integer.format(overview.sessions),
      money.format(knownSpend),
      integer.format(totalInput),
      percent(overview.sessionProfile.overallEfficiency),
      `${integer.format(overview.multiDaySessions)} (${percent(overview.multiDaySessionRate)})`,
    ]],
  ));

  sections.push("## Activity per Active Day\n\n" + table(
    ["Metric", "Median", "Average", "P90"],
    [
      distributionRow("Sessions", overview.activity.sessions),
      distributionRow("Peak concurrent sessions", overview.activity.peakConcurrentSessions),
      distributionRow("Turns", overview.activity.turns),
      distributionRow("Spend", overview.activity.spend, money.format),
    ],
  ));

  sections.push("## Session Profile\n\n" + table(
    ["Metric", "Median", "Average", "P90"],
    [
      distributionRow("Active dates / session", overview.sessionProfile.activeSpan, days),
      distributionRow("Turns / session", overview.sessionProfile.turns),
      distributionRow("Input processed", overview.sessionProfile.input, compact.format),
      distributionRow("Initial input", overview.sessionProfile.initialInput, compact.format),
      distributionRow("Peak context", overview.sessionProfile.peakContext, compact.format),
      distributionRow("Session duration", overview.sessionProfile.elapsed, duration),
      distributionRow("Spend / session", overview.sessionProfile.spend, money.format),
      distributionRow("Token reuse / session", overview.sessionProfile.efficiency, percent),
    ],
  ));

  const cache = cacheMisses.cacheMisses;
  const totalCacheMisses = cache.full.misses + cache.partial.misses;
  const cacheMissCost = cache.full.attributedCost + cache.partial.attributedCost;
  sections.push("## Cache Misses\n\n" + table(
    ["Metric", "Value"],
    [
      ["Sessions with cache misses", `${integer.format(cache.affectedSessions)} (${share(cache.affectedSessions, cacheMisses.sessions)})`],
      ["Total cache misses", integer.format(totalCacheMisses)],
      ["Spend in affected sessions", `${money.format(cache.affectedSessionCost)} (${share(cache.affectedSessionCost, cacheMisses.totalSessionCost)})`],
      ["Cache-miss cost", `${money.format(cacheMissCost)} (${share(cacheMissCost, cache.affectedSessionCost)})`],
    ],
  ));

  sections.push("### TTL Misses\n\n" + table(
    ["Time since previous session", "Misses", "Sessions", "Cost at miss"],
    [
      ["< 2h", integer.format(cacheMisses.misses.underTwoHours), integer.format(cacheMisses.misses.underTwoHoursSessions), money.format(cacheMisses.misses.underTwoHoursCost)],
      ["2–8h", integer.format(cacheMisses.misses.twoToEightHours), integer.format(cacheMisses.misses.twoToEightHoursSessions), money.format(cacheMisses.misses.twoToEightHoursCost)],
      ["8h+", integer.format(cacheMisses.misses.eightHoursOrMore), integer.format(cacheMisses.misses.eightHoursOrMoreSessions), money.format(cacheMisses.misses.eightHoursOrMoreCost)],
    ],
  ));

  const otherMissRows = [
    ["Compaction", cache.compaction],
    ["Thinking change", cache.thinkingChange],
    ["Unexpected full", cache.unexpected.full],
    ["Unexpected partial", cache.unexpected.partial],
  ] as const;
  sections.push("### Other Cache Misses\n\n" + table(
    ["Cause", "Misses", "Sessions", "Cost at miss"],
    otherMissRows.map(([label, category]) => [
      label,
      integer.format(category.misses),
      integer.format(category.affectedSessions),
      money.format(category.attributedCost),
    ]),
  ));

  const models = modelTotals(usage);
  const spend = topModelRows(models, "spend");
  const input = topModelRows(models, "input");
  sections.push(`## Spend by Model\n\n**Total: ${money.format(spend.total)}**\n\n` + table(
    ["Model", "Spend", "Share"],
    spend.rows,
  ));
  sections.push(`## Input by Model\n\n**Total: ${integer.format(input.total)} tokens**\n\n` + table(
    ["Model", "Input tokens", "Share"],
    input.rows,
  ));

  if (usage.subagentCoverage !== "none") {
    const subagents = usage.subagentDays.reduce((total, day) => ({
      sessions: total.sessions + day.rootOnly + day.withSubagents,
      withSubagents: total.withSubagents + day.withSubagents,
      withMultiple: total.withMultiple + day.withMultipleSubagents,
      runs: total.runs + day.subagents,
      input: total.input + day.totalInput,
      subagentInput: total.subagentInput + day.subagentInput,
      cost: total.cost + day.totalCost,
      subagentCost: total.subagentCost + day.subagentCost,
    }), {
      sessions: 0,
      withSubagents: 0,
      withMultiple: 0,
      runs: 0,
      input: 0,
      subagentInput: 0,
      cost: 0,
      subagentCost: 0,
    });
    sections.push("## Subagents\n\n" + table(
      ["Metric", "Value"],
      [
        ["Sessions", integer.format(subagents.sessions)],
        ["Sessions with subagents", `${integer.format(subagents.withSubagents)} (${share(subagents.withSubagents, subagents.sessions)})`],
        ["Sessions with 2+ subagents", `${integer.format(subagents.withMultiple)} (${share(subagents.withMultiple, subagents.sessions)})`],
        ["Subagent runs", integer.format(subagents.runs)],
        ["Subagent input", `${integer.format(subagents.subagentInput)} (${share(subagents.subagentInput, subagents.input)})`],
        ["Subagent spend", `${money.format(subagents.subagentCost)} (${share(subagents.subagentCost, subagents.cost)})`],
      ],
    ));
  }

  return `${sections.join("\n\n")}\n`;
}
