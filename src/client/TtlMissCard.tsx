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
  const [view, setView] = useState<"ttl" | "cost">("ttl");
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
      <div className="ttl-analytics-toolbar">
        <div
          className="chart-tabs"
          role="tablist"
          aria-label="Cache efficiency view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "ttl"}
            className={view === "ttl" ? "active" : undefined}
            onClick={() => setView("ttl")}
          >
            TTL misses
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "cost"}
            className={view === "cost" ? "active" : undefined}
            onClick={() => setView("cost")}
          >
            Miss cost
          </button>
        </div>
        <span>Last 90 days</span>
      </div>
      <div className="ttl-miss-heading">
        <div>
          <p className="eyebrow">Cache efficiency</p>
          <h2 id="ttl-miss-title">
            {view === "ttl" ? "TTL misses" : "Full and partial misses"}
          </h2>
        </div>
      </div>
      {!metrics && !error && (
        <div className="ttl-miss-message">Analyzing session gaps...</div>
      )}
      {error && <div className="ttl-miss-message chart-error">{error}</div>}
      {metrics && view === "ttl" && (
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
      {metrics && view === "cost" && (() => {
        const { cacheMisses } = metrics;
        const totalMisses = cacheMisses.full.misses +
          cacheMisses.partial.misses;
        const attributedCost = cacheMisses.full.attributedCost +
          cacheMisses.partial.attributedCost;
        const unpriced = cacheMisses.full.unpriced +
          cacheMisses.partial.unpriced;
        return (
          <>
            <div className="ttl-miss-lead">
              <strong>{integer.format(totalMisses)}</strong>
              <div>
                <span>root-session cache misses</span>
                <b>
                  {integer.format(cacheMisses.affectedSessions)} of{" "}
                  {integer.format(metrics.sessions)} sessions affected
                </b>
              </div>
            </div>
            <div className="ttl-cost-summary">
              <div>
                <span>All spend in range</span>
                <strong>{money.format(metrics.totalCost)}</strong>
                <small>
                  Root + subagents{metrics.hasUnpricedTotalCost
                    ? " · known prices only"
                    : ""}
                </small>
              </div>
              <div>
                <span>Root spend analyzed</span>
                <strong>{money.format(metrics.totalSessionCost)}</strong>
                <small>
                  {share(metrics.totalSessionCost, metrics.totalCost)}{" "}
                  of all spend
                </small>
              </div>
              <div>
                <span>Affected root-session spend</span>
                <strong>{money.format(cacheMisses.affectedSessionCost)}</strong>
                <small>
                  {share(
                    cacheMisses.affectedSessionCost,
                    metrics.totalSessionCost,
                  )} of root spend{cacheMisses.hasUnpricedAffectedSessionCost
                    ? " · known prices only"
                    : ""}
                </small>
              </div>
              <div>
                <span>Estimated miss-attributed cost</span>
                <strong>{money.format(attributedCost)}</strong>
                <small>
                  {share(attributedCost, cacheMisses.affectedSessionCost)}{" "}
                  of affected spend
                </small>
              </div>
            </div>
            <div
              className="cache-miss-cost-table"
              role="table"
              aria-label="Full and partial cache miss costs"
            >
              <div className="cache-miss-cost-header" role="row">
                <span role="columnheader">Type</span>
                <span role="columnheader">Misses</span>
                <span role="columnheader">Sessions</span>
                <span role="columnheader">Attributed</span>
                <span role="columnheader">Extra cost</span>
              </div>
              {(["full", "partial"] as const).map((type) => {
                const category = cacheMisses[type];
                return (
                  <div className="cache-miss-cost-row" role="row" key={type}>
                    <strong role="cell">
                      {type === "full" ? "Full misses" : "Partial misses"}
                    </strong>
                    <span role="cell">{integer.format(category.misses)}</span>
                    <span role="cell">
                      {integer.format(category.affectedSessions)}
                    </span>
                    <span role="cell">
                      {money.format(category.attributedCost)}
                    </span>
                    <span role="cell">
                      {money.format(category.estimatedExtraCost)}
                    </span>
                    <small>
                      {integer.format(category.missedTokens)}{" "}
                      reusable tokens missed ·{" "}
                      {money.format(category.expectedReadCost)}{" "}
                      expected read cost
                    </small>
                  </div>
                );
              })}
            </div>
            {unpriced > 0 && (
              <p className="ttl-pricing-note">
                {integer.format(unpriced)} miss{unpriced === 1 ? "" : "es"}{" "}
                could not be priced.
              </p>
            )}
            <p className="cache-miss-cost-note">
              Includes TTL and compaction-related misses. Extra cost compares
              observed miss billing with the cache-read cost expected for
              reusable tokens.
            </p>
          </>
        );
      })()}
    </section>
  );
}
