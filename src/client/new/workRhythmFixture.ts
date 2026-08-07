import type {
  WorkRhythmData,
  WorkRhythmDay,
  WorkRhythmSession,
} from "./workRhythmTypes.ts";

type DaySeed = readonly [
  date: string,
  estimatedActiveMinutes: number,
  spend: number,
  userTurns: number,
  rootSessions: number,
];

const daySeeds: DaySeed[] = [
  ["2026-07-08", 143, 9.84, 24, 7],
  ["2026-07-09", 95, 6.18, 16, 5],
  ["2026-07-10", 129, 11.42, 21, 6],
  ["2026-07-11", 30, 1.26, 5, 2],
  ["2026-07-12", 0, 0, 0, 0],
  ["2026-07-13", 159, 14.76, 27, 8],
  ["2026-07-14", 112, 7.91, 19, 5],
  ["2026-07-15", 163, 13.28, 29, 8],
  ["2026-07-16", 86, 5.67, 14, 4],
  ["2026-07-17", 108, 8.95, 18, 6],
  ["2026-07-18", 24, 0.88, 4, 1],
  ["2026-07-19", 38, 2.16, 6, 2],
  ["2026-07-20", 175, 17.62, 31, 9],
  ["2026-07-21", 0, 0, 0, 0],
  ["2026-07-22", 167, 15.04, 28, 8],
  ["2026-07-23", 105, 7.48, 17, 5],
  ["2026-07-24", 96, 6.73, 16, 5],
  ["2026-07-25", 26, 1.14, 5, 2],
  ["2026-07-26", 44, 2.72, 8, 3],
  ["2026-07-27", 153, 12.86, 25, 7],
  ["2026-07-28", 120, 9.31, 20, 6],
  ["2026-07-29", 110, 8.14, 18, 5],
  ["2026-07-30", 0, 0, 0, 0],
  ["2026-07-31", 112, 10.27, 19, 6],
  ["2026-08-01", 24, 1.03, 4, 2],
  ["2026-08-02", 56, 3.84, 9, 3],
  ["2026-08-03", 165, 16.38, 28, 8],
  ["2026-08-04", 104, 7.56, 17, 5],
  ["2026-08-05", 117, 9.72, 20, 6],
  ["2026-08-06", 111, 12.48, 17, 5],
];

const selectedDaySessions: WorkRhythmSession[] = [
  {
    id: "mock-2026-08-06-auth",
    title: "Refactor auth flow",
    harness: "claude-code",
    model: "Claude Opus 4.1",
    startTime: "2026-08-06T09:18:00-07:00",
    activeDateRange: { start: "2026-08-06", end: "2026-08-06" },
    spend: 4.82,
    hasUnpricedSpend: false,
    totalSpend: 4.82,
    hasUnpricedTotalSpend: false,
  },
  {
    id: "mock-2026-08-06-pi",
    title: null,
    harness: "pi",
    model: "GPT-5.2 Codex",
    startTime: "2026-08-06T14:40:00-07:00",
    activeDateRange: { start: "2026-08-06", end: "2026-08-06" },
    spend: 3.11,
    hasUnpricedSpend: false,
    totalSpend: 3.11,
    hasUnpricedTotalSpend: false,
  },
  {
    id: "mock-2026-08-06-cache",
    title: "Investigate cache misses",
    harness: "codex",
    model: null,
    startTime: "2026-08-06T16:12:00-07:00",
    activeDateRange: { start: "2026-08-06", end: "2026-08-06" },
    spend: 1.94,
    hasUnpricedSpend: false,
    totalSpend: 1.94,
    hasUnpricedTotalSpend: false,
  },
];

const harnesses = ["claude-code", "codex", "pi", "opencode"] as const;
const models = ["Claude Sonnet 4", "GPT-5.2 Codex", "Claude Opus 4.1", null] as const;
const generatedTitles = [
  "Tighten session parser",
  null,
  "Review analytics layout",
] as const;

function intensity(minutes: number): WorkRhythmDay["intensity"] {
  if (minutes === 0) return 0;
  if (minutes <= 45) return 1;
  if (minutes <= 90) return 2;
  if (minutes <= 140) return 3;
  return 4;
}

function sessionsForDay(seed: DaySeed, index: number): WorkRhythmSession[] {
  const [date, , spend, , rootSessions] = seed;
  if (date === "2026-08-06") return selectedDaySessions;
  if (rootSessions === 0) return [];

  return Array.from({ length: Math.min(3, rootSessions) }, (_, sessionIndex) => {
    const harness = harnesses[(index + sessionIndex) % harnesses.length];
    const hour = 9 + sessionIndex * 3 + (index % 3);
    return {
      id: `mock-${date}-${sessionIndex + 1}`,
      title: generatedTitles[(index + sessionIndex) % generatedTitles.length],
      harness,
      model: models[(index + sessionIndex) % models.length],
      startTime: `${date}T${String(hour).padStart(2, "0")}:${sessionIndex === 1 ? "35" : "10"}:00-07:00`,
      activeDateRange: { start: date, end: date },
      spend: Number((spend * [0.43, 0.27, 0.16][sessionIndex]).toFixed(2)),
      hasUnpricedSpend: false,
      totalSpend: Number((spend * [0.43, 0.27, 0.16][sessionIndex]).toFixed(2)),
      hasUnpricedTotalSpend: false,
    };
  });
}

const days: Record<string, WorkRhythmDay> = Object.fromEntries(
  daySeeds.map((seed, index) => {
    const [date, estimatedActiveMinutes, spend, userTurns, rootSessions] = seed;
    const processedInputTokens = date === "2026-08-06"
      ? 18_600_000
      : Math.round(estimatedActiveMinutes * 125_000 + userTurns * 40_000);
    return [date, {
      date,
      estimatedActiveMinutes,
      spend,
      hasUnpricedSpend: false,
      processedInputTokens,
      userTurns,
      rootSessions,
      intensity: intensity(estimatedActiveMinutes),
      topSessions: sessionsForDay(seed, index),
    }];
  }),
);

const hourlyMinutes = [
  12, 6, 4, 3, 4, 18, 40, 72, 105, 140, 160, 180,
  175, 190, 215, 270, 260, 235, 200, 180, 130, 80, 50, 43,
];
const totalMinutes = hourlyMinutes.reduce((total, minutes) => total + minutes, 0);

export const workRhythmFixture: WorkRhythmData = {
  range: { start: "2026-07-08", end: "2026-08-06" },
  estimatedActiveMinutes: totalMinutes,
  methodology: { minutesBeforeTurn: 5, overlapsCountedOnce: true },
  weekdayActivity: [
    { weekday: 1, label: "Mon", averageMinutes: 163, totalMinutes: 652, occurrences: 4, activeOccurrences: 4 },
    { weekday: 2, label: "Tue", averageMinutes: 84, totalMinutes: 336, occurrences: 4, activeOccurrences: 3 },
    { weekday: 3, label: "Wed", averageMinutes: 140, totalMinutes: 700, occurrences: 5, activeOccurrences: 5 },
    { weekday: 4, label: "Thu", averageMinutes: 79, totalMinutes: 397, occurrences: 5, activeOccurrences: 4 },
    { weekday: 5, label: "Fri", averageMinutes: 111, totalMinutes: 445, occurrences: 4, activeOccurrences: 4 },
    { weekday: 6, label: "Sat", averageMinutes: 26, totalMinutes: 104, occurrences: 4, activeOccurrences: 4 },
    { weekday: 0, label: "Sun", averageMinutes: 35, totalMinutes: 138, occurrences: 4, activeOccurrences: 3 },
  ],
  hourlyActivity: hourlyMinutes.map((estimatedMinutes, hour) => ({
    hour,
    estimatedMinutes,
    shareOfTotal: estimatedMinutes / totalMinutes,
    activeDates: estimatedMinutes < 20
      ? Math.max(1, Math.round(estimatedMinutes / 4))
      : Math.min(26, Math.round(estimatedMinutes / 12) + 3),
  })),
  afterHoursShare: hourlyMinutes.slice(20).reduce((sum, minutes) => sum + minutes, 0) / totalMinutes,
  peakHour: 15,
  days,
};
