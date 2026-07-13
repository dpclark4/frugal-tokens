import { useEffect, useState } from "react";
import type { UsageResponse } from "../shared/sessionSchemas.ts";
import { getUsage } from "./api.ts";
import { CacheMissChart } from "./analytics/CacheMissChart.tsx";
import { SessionInputChart } from "./analytics/SessionInputChart.tsx";
import { SpendInputChart } from "./analytics/SpendInputChart.tsx";

type View = "spend" | "input" | "session-input" | "cache";
type Range = 7 | 30 | "all";

const views: Array<{ value: View; label: string }> = [
  { value: "spend", label: "Spend" },
  { value: "input", label: "Input" },
  { value: "session-input", label: "Session size" },
  { value: "cache", label: "Cache misses" },
];

export function UsageChart({ harness }: { harness: string }) {
  const [view, setView] = useState<View>("spend");
  const [range, setRange] = useState<Range>(30);
  const [usage, setUsage] = useState<UsageResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setUsage(undefined);
    setError(undefined);
    getUsage(range, harness).then((result) => active && setUsage(result)).catch(
      (reason) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Unable to load usage",
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [harness, range]);

  return (
    <section className="usage-chart" aria-label="Usage analytics">
      <div className="analytics-toolbar">
        <div className="chart-tabs" role="tablist" aria-label="Analytics view">
          {views.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              className={view === value ? "active" : undefined}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="segmented" aria-label="Chart range">
          {([7, 30, "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={range === value ? "active" : undefined}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {value === "all" ? "All" : `${value}D`}
            </button>
          ))}
        </div>
      </div>
      {!usage && !error && (
        <div className="usage-chart-body">
          <div className="chart-message">Building daily totals...</div>
        </div>
      )}
      {error && (
        <div className="usage-chart-body">
          <div className="chart-message chart-error">{error}</div>
        </div>
      )}
      {usage && (view === "spend" || view === "input") && (
        <SpendInputChart
          usage={usage}
          metric={view === "spend" ? "cost" : "input"}
          range={range}
        />
      )}
      {usage && view === "session-input" && (
        <SessionInputChart usage={usage} range={range} />
      )}
      {usage && view === "cache" && (
        <CacheMissChart usage={usage} range={range} />
      )}
    </section>
  );
}
