import { useEffect, useState } from "react";
import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import { getTtlMissMetrics } from "./api.ts";

const integer = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
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
          <div className="ttl-miss-breakdown">
            <div className="ttl-miss-breakdown-title">
              <span>Root-session gap</span>
              <strong>{integer.format(metrics.misses.total)} misses</strong>
            </div>
            {([
              ["Under 2 hours", metrics.misses.underTwoHours],
              ["2 to 8 hours", metrics.misses.twoToEightHours],
              ["8 hours or more", metrics.misses.eightHoursOrMore],
            ] as const).map(([label, count]) => (
              <div className="ttl-miss-row" key={label}>
                <span>{label}</span>
                <i />
                <strong>{integer.format(count)}</strong>
                <small>{share(count, metrics.misses.total)}</small>
              </div>
            ))}
          </div>
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
