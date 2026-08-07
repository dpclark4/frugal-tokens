import { useEffect, useState } from "react";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";
import { InitialInputChart } from "../analytics/InitialInputChart.tsx";
import { getUsage } from "../api.ts";
import { compact } from "./formatters.ts";
import "./HarnessOverview.css";

type HarnessOverviewProps = {
  range: 30 | 90;
  harness: string;
};

export function HarnessOverview({ range, harness }: HarnessOverviewProps) {
  const [usage, setUsage] = useState<UsageResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    getUsage(range, harness).then((result) => {
      if (active) setUsage(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load harness metrics",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [range, harness]);

  return (
    <section
      className="new-placeholder-section harness-overview-section"
      aria-labelledby="harness-section-title"
    >
      <header>
        <h2 id="harness-section-title">Initial input</h2>
        {usage?.initialInputSummary && (
          <div className="initial-input-summary">
            <span>Median <strong>{compact.format(usage.initialInputSummary.median)}</strong></span>
            <span>Average <strong>{compact.format(usage.initialInputSummary.average)}</strong></span>
          </div>
        )}
      </header>
      {usage
        ? <InitialInputChart usage={usage} bare showLegend />
        : (
          <p className={error ? "harness-overview-message error" : "harness-overview-message"}>
            {error ?? "Loading…"}
          </p>
        )}
    </section>
  );
}
