import { displayModelName } from "../shared/modelNames.ts";
import type {
  ActivityOverviewResponse,
  SessionShapeResponse,
  TtlMissMetrics,
  WorkRhythmOverviewResponse,
} from "../shared/sessionSchemas.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

function percent(value: number | undefined) {
  return value === undefined ? "—" : `${decimal.format(value * 100)}%`;
}

function duration(minutes: number) {
  if (minutes < 1) return `${integer.format(minutes * 60)} sec`;
  if (minutes < 60) return `${decimal.format(minutes)} min`;
  return `${decimal.format(minutes / 60)} hr`;
}

function harnessLabel(harness: string) {
  switch (harness) {
    case "all":
      return "All harnesses";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    default:
      return harness;
  }
}

function hourLabel(hour: number) {
  if (hour === 0) return "12am";
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return "12pm";
  return `${hour - 12}pm`;
}

const shapeLabels = {
  cost: "Cost",
  observedSpan: "Duration",
  peakContext: "Peak context",
  processedInput: "Processed input",
  startingContext: "Starting context",
  tokenReuse: "Token reuse",
  userTurns: "Turns",
} satisfies Record<
  SessionShapeResponse["metrics"][number]["key"],
  string
>;

function shapeValue(
  key: SessionShapeResponse["metrics"][number]["key"],
  value: number,
) {
  if (key === "cost") return money.format(value);
  if (key === "observedSpan") return duration(value / 60_000);
  if (key === "tokenReuse") return percent(value);
  return integer.format(value);
}

type CacheCategory = {
  affectedSessions: number;
  attributedCost: number;
  misses: number;
};

function cacheRows(metrics: TtlMissMetrics) {
  const root = metrics.cacheMisses;
  const categories: Array<[string, string, CacheCategory]> = [
    ["Root", "TTL", {
      affectedSessions: metrics.affectedSessions,
      attributedCost: metrics.misses.attributedCost,
      misses: metrics.misses.total,
    }],
    ["Root", "Thinking change", root.thinkingChange],
    ["Root", "Compaction", root.compaction],
    ["Root", "Model change", root.modelChange],
    ["Root", "Unexpected full", root.unexpected.full],
    ["Root", "Unexpected partial", root.unexpected.partial],
    ["Subagent", "TTL", metrics.subagents.ttl],
    ["Subagent", "Thinking change", metrics.subagents.thinkingChange],
    ["Subagent", "Compaction", metrics.subagents.compaction],
    ["Subagent", "Model change", metrics.subagents.modelChange],
    ["Subagent", "Unexpected full", metrics.subagents.unexpected.full],
    ["Subagent", "Unexpected partial", metrics.subagents.unexpected.partial],
  ];
  return categories.filter(([, , category]) => category.misses > 0).map(
    ([scope, cause, category]) => [
      scope,
      cause,
      integer.format(category.misses),
      integer.format(category.affectedSessions),
      money.format(category.attributedCost),
    ],
  );
}

export function buildOverviewReport({
  overview,
  workRhythmOverview,
  sessionShape,
  cacheMisses,
  harness,
}: {
  overview: ActivityOverviewResponse;
  workRhythmOverview: WorkRhythmOverviewResponse;
  sessionShape: SessionShapeResponse;
  cacheMisses: TtlMissMetrics;
  harness: string;
}) {
  const { summary, spendComposition } = overview;
  const { workRhythm } = workRhythmOverview;
  const sections = [
    '<!-- frugal-tokens-report version="1" -->',
    "# Frugal Tokens Report",
    table(["Period", "Harness", "Generated"], [[
      `${overview.startDate} – ${overview.endDate}`,
      harnessLabel(harness),
      new Date().toISOString(),
    ]]),
  ];

  const costPerMillion = summary.processedInput === 0
    ? 0
    : summary.spend / summary.processedInput * 1_000_000;
  sections.push(
    "## Usage\n\n" + table(
      ["Sessions", "Spend", "Processed input", "Token reuse", "$/1M processed"],
      [[
        integer.format(summary.sessions),
        `${money.format(summary.spend)}${summary.hasUnpricedCost ? "+" : ""}`,
        integer.format(summary.processedInput),
        percent(summary.tokenReuse),
        money.format(costPerMillion),
      ]],
    ),
  );
  sections.push(table(["Signal", "Value"], [
    ["Attributed cache-miss cost", money.format(summary.spendAtMissCalls)],
    ["Subagent spend", money.format(summary.subagentSpend)],
    ["Spend from top 10% of sessions", percent(summary.topDecileSpendShare)],
  ]));

  sections.push(
    `## Session shape\n\n${integer.format(sessionShape.sampleSize)} sessions; ${
      integer.format(sessionShape.multiDaySessions)
    } span multiple days (${percent(sessionShape.multiDaySessionRate)}); ${
      integer.format(sessionShape.unpricedSessions)
    } include unpriced usage.\n\n` + table(
      ["Metric", "P10", "P25", "Median", "Mean", "P75", "P90"],
      sessionShape.metrics.map((metric) => {
        const distribution = metric.distribution;
        return distribution
          ? [
            shapeLabels[metric.key],
            shapeValue(metric.key, distribution.p10),
            shapeValue(metric.key, distribution.p25),
            shapeValue(metric.key, distribution.median),
            shapeValue(metric.key, distribution.average),
            shapeValue(metric.key, distribution.p75),
            shapeValue(metric.key, distribution.p90),
          ]
          : [shapeLabels[metric.key], "—", "—", "—", "—", "—", "—"];
      }),
    ),
  );

  sections.push(
    `## Estimated work\n\n**Total:** ${
      duration(workRhythm.estimatedActiveMinutes)
    } · **Peak hour:** ${
      workRhythm.peakHour === undefined ? "—" : hourLabel(workRhythm.peakHour)
    } · **After hours:** ${percent(workRhythm.afterHoursShare)}\n\n` +
      "### By weekday\n\n" + table(
        ["Day", "Average", "Active occurrences"],
        workRhythm.weekdayActivity.map((day) => [
          day.label,
          duration(day.averageMinutes),
          `${day.activeOccurrences}/${day.occurrences}`,
        ]),
      ) + "\n\n### By hour\n\n" + table(
        ["Hour", "Estimated active"],
        workRhythm.hourlyActivity.filter((hour) => hour.estimatedMinutes > 0)
          .map((
            hour,
          ) => [hourLabel(hour.hour), duration(hour.estimatedMinutes)]),
      ) + "\n\n" + table(["Work pattern", "Share"], [
        [
          "1 active session",
          percent(workRhythm.parallelWork.activeTimeShare.oneSession),
        ],
        [
          "2 active sessions",
          percent(workRhythm.parallelWork.activeTimeShare.twoSessions),
        ],
        [
          "3+ active sessions",
          percent(
            workRhythm.parallelWork.activeTimeShare.threeSessions +
              workRhythm.parallelWork.activeTimeShare.fourPlusSessions,
          ),
        ],
        [
          "Overlapping activity",
          percent(workRhythm.parallelWork.overlappingShare),
        ],
        ["Work blocks", integer.format(workRhythm.workBlocks.count)],
        [
          "Work blocks / active day",
          decimal.format(workRhythm.workBlocks.blocksPerActiveDay),
        ],
        [
          "Work blocks under 15 min",
          percent(workRhythm.workBlocks.durationShare.underFifteenMinutes),
        ],
        [
          "Work blocks 15–60 min",
          percent(workRhythm.workBlocks.durationShare.fifteenToSixtyMinutes),
        ],
        [
          "Work blocks 1+ hr",
          percent(workRhythm.workBlocks.durationShare.oneHourPlus),
        ],
      ]),
  );

  const modelRows: Array<Array<string | number>> = spendComposition.models.map(
    (model) => [
      displayModelName(model.model),
      `${money.format(model.spend)}${model.hasUnpricedCost ? "+" : ""}`,
      integer.format(model.processedInput),
    ],
  );
  if (spendComposition.other) {
    modelRows.push([
      "Other",
      `${money.format(spendComposition.other.spend)}${
        spendComposition.other.hasUnpricedCost ? "+" : ""
      }`,
      integer.format(spendComposition.other.processedInput),
    ]);
  }
  sections.push(
    "## Spend and input by model\n\n" + table(
      ["Model", "Spend", "Processed input"],
      modelRows,
    ),
  );

  sections.push(
    `## Cache misses\n\n${
      integer.format(cacheMisses.combined.misses)
    } misses across ${
      integer.format(cacheMisses.combined.affectedSessions)
    } of ${integer.format(cacheMisses.sessions)} sessions; ${
      money.format(cacheMisses.combined.attributedCost)
    } attributed cost and ${
      integer.format(cacheMisses.combined.missedTokens)
    } missed tokens.\n\n` + table(
      ["Scope", "Cause", "Misses", "Sessions", "Attributed cost"],
      cacheRows(cacheMisses),
    ) + "\n\n### Root TTL timing\n\n" + table(
      ["Gap", "Misses", "Sessions", "Attributed cost"],
      [
        [
          "Under 30 min",
          cacheMisses.misses.underThirtyMinutes,
          cacheMisses.misses.underThirtyMinutesSessions,
          cacheMisses.misses.underThirtyMinutesCost,
        ],
        [
          "30 min–2 hr",
          cacheMisses.misses.thirtyMinutesToTwoHours,
          cacheMisses.misses.thirtyMinutesToTwoHoursSessions,
          cacheMisses.misses.thirtyMinutesToTwoHoursCost,
        ],
        [
          "2–8 hr",
          cacheMisses.misses.twoToEightHours,
          cacheMisses.misses.twoToEightHoursSessions,
          cacheMisses.misses.twoToEightHoursCost,
        ],
        [
          "8+ hr",
          cacheMisses.misses.eightHoursOrMore,
          cacheMisses.misses.eightHoursOrMoreSessions,
          cacheMisses.misses.eightHoursOrMoreCost,
        ],
      ].filter((row) => Number(row[1]) > 0).map((
        [gap, misses, sessions, cost],
      ) => [
        gap,
        integer.format(Number(misses)),
        integer.format(Number(sessions)),
        money.format(Number(cost)),
      ]),
    ),
  );

  return `${sections.join("\n\n")}\n`;
}
