import { useEffect, useState } from "react";
import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import { getTtlMissMetrics } from "./api.ts";

const integer = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function share(value: number, total: number) {
  return percent.format(total === 0 ? 0 : value / total);
}

export function TtlMissCard({ harness }: { harness: string }) {
  const [metrics, setMetrics] = useState<TtlMissMetrics>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setMetrics(undefined);
    setError(undefined);
    getTtlMissMetrics(90, harness).then((result) => {
      if (active) setMetrics(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load TTL metrics",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [harness]);

  return (
    <section className="ttl-miss-card" aria-labelledby="ttl-miss-title">
      <div className="ttl-miss-heading">
        <div>
          <p className="eyebrow">Cache efficiency</p>
          <h2 id="ttl-miss-title">TTL misses</h2>
        </div>
        <span>Last 90 days</span>
      </div>
      {!metrics && !error && (
        <div className="ttl-miss-message">Analyzing session gaps...</div>
      )}
      {error && <div className="ttl-miss-message chart-error">{error}</div>}
      {metrics && (
        <>
          <div className="ttl-miss-lead">
            <strong>{integer.format(metrics.affectedSessions)}</strong>
            <div>
              <span>of {integer.format(metrics.sessions)} sessions</span>
              <b>
                {share(metrics.affectedSessions, metrics.sessions)} affected
              </b>
            </div>
          </div>
          <div className="ttl-cost-summary">
            <div>
              <span>All spend in range</span>
              <strong>{money.format(metrics.totalCost)}</strong>
              <small>
                Root + subagents
                {metrics.hasUnpricedTotalCost ? " · known prices only" : ""}
              </small>
            </div>
            <div>
              <span>Root spend analyzed</span>
              <strong>{money.format(metrics.totalSessionCost)}</strong>
              <small>
                {share(metrics.totalSessionCost, metrics.totalCost)}{" "}
                of all spend
                {metrics.hasUnpricedSessionCost ? " · known prices only" : ""}
              </small>
            </div>
            <div>
              <span>Affected root-session spend</span>
              <strong>{money.format(metrics.affectedSessionCost)}</strong>
              <small>
                {share(metrics.affectedSessionCost, metrics.totalSessionCost)}
                {" "}
                of root spend
                {metrics.hasUnpricedAffectedSessionCost
                  ? " · known prices only"
                  : ""}
              </small>
            </div>
            <div>
              <span>Estimated TTL-attributed cost</span>
              <strong>{money.format(metrics.misses.attributedCost)}</strong>
              <small>
                {share(
                  metrics.misses.attributedCost,
                  metrics.affectedSessionCost,
                )} of affected spend
              </small>
            </div>
          </div>
          <div className="ttl-miss-breakdown">
            <div className="ttl-miss-breakdown-title">
              <span>Root-session gap</span>
              <strong>{integer.format(metrics.misses.total)} misses</strong>
            </div>
            {([
              [
                "Quick return (<2 hours)",
                metrics.misses.underTwoHours,
                metrics.misses.underTwoHoursCost,
              ],
              [
                "Later return (2–8 hours)",
                metrics.misses.twoToEightHours,
                metrics.misses.twoToEightHoursCost,
              ],
              [
                "Long-gap return (8+ hours)",
                metrics.misses.eightHoursOrMore,
                metrics.misses.eightHoursOrMoreCost,
              ],
            ] as const).map(([label, count, cost]) => (
              <div className="ttl-miss-row" key={label}>
                <span>{label}</span>
                <i />
                <strong>{money.format(cost)}</strong>
                <small>
                  {integer.format(count)} · {share(count, metrics.misses.total)}
                </small>
              </div>
            ))}
          </div>
          {metrics.misses.unpriced > 0 && (
            <p className="ttl-pricing-note">
              {integer.format(metrics.misses.unpriced)}{" "}
              miss{metrics.misses.unpriced === 1 ? "" : "es"}{" "}
              could not be priced.
            </p>
          )}
          <div className="ttl-subagent-summary">
            <div>
              <span>Subagent TTL misses</span>
              <small>Reported separately from user-session resumptions</small>
            </div>
            <strong>{integer.format(metrics.subagents.misses)} misses</strong>
            <span>
              {integer.format(metrics.subagents.affectedSessions)} sessions
            </span>
          </div>
        </>
      )}
    </section>
  );
}
