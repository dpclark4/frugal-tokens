import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const cacheSeries = [
  { key: "clean", label: "Clean", color: "#466244" },
  { key: "partial", label: "Partial only", color: "#c18a3d" },
  { key: "fullMiss", label: "Full miss", color: "#b4522d" },
  { key: "notComparable", label: "Not comparable", color: "#aaa69c" },
] as const;

function CacheTooltip({ active, label, payload }: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload?: Record<string, number> }>;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const row = payload[0].payload;
  if (!row) return null;
  const total = cacheSeries.reduce((sum, item) => sum + (row[`${item.key}Count`] ?? 0), 0);
  return (
    <div className="usage-tooltip cache-tooltip">
      <p>{day.format(new Date(`${String(label)}T00:00:00`))}</p>
      <strong>{total} sessions</strong>
      <div className="usage-tooltip-models">
        {cacheSeries.map((item) => {
          const count = row[`${item.key}Count`] ?? 0;
          return (
            <div key={item.key}>
              <span className="model-label"><i style={{ background: item.color }} />{item.label}</span>
              <span>{count} · {total === 0 ? 0 : Math.round(count / total * 100)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CacheMissChart({ usage, range }: {
  usage: UsageResponse;
  range: 7 | 30 | "all";
}) {
  const total = usage.cacheDays.reduce(
    (sum, entry) => sum + entry.clean + entry.partial + entry.fullMiss + entry.notComparable,
    0,
  );
  const data = usage.cacheDays.map((entry) => {
    const entryTotal = entry.clean + entry.partial + entry.fullMiss + entry.notComparable;
    return {
      date: entry.date,
      ...Object.fromEntries(cacheSeries.flatMap((item) => [
        [item.key, entryTotal === 0 ? 0 : entry[item.key] / entryTotal * 100],
        [`${item.key}Count`, entry[item.key]],
      ])),
    };
  });

  return (
    <>
      <div className="usage-chart-heading">
        <div>
          <p className="eyebrow">Usage pulse</p>
          <h2>Sessions with cache misses</h2>
          <p className="chart-total"><strong>{total} sessions</strong><span>{range === "all" ? "All time" : `Last ${range} days`}</span></p>
        </div>
      </div>
      <div className="usage-chart-body">
        {data.length === 0
          ? <div className="chart-message">No usage in this range.</div>
          : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#dfdbd1" strokeDasharray="3 5" />
                <XAxis dataKey="date" tickFormatter={(value: string) => day.format(new Date(`${value}T00:00:00`))} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} tickLine={false} axisLine={false} width={42} />
                <Tooltip cursor={{ fill: "rgba(70, 98, 68, .07)" }} content={(props) => (
                  <CacheTooltip active={props.active} label={props.label} payload={props.payload as Array<{ payload?: Record<string, number> }>} />
                )} />
                {cacheSeries.map((item) => (
                  <Bar key={item.key} dataKey={item.key} name={item.label} stackId="cache" fill={item.color} maxBarSize={48} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>
      {data.length > 0 && (
        <div className="cache-legend" aria-label="Cache outcome legend">
          {cacheSeries.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}
        </div>
      )}
    </>
  );
}
