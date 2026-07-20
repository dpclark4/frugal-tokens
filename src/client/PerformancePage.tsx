import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PerformanceResponse } from "../shared/sessionSchemas.ts";
import { getPerformance } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";

const route = getRouteApi("/performance");
const integer = new Intl.NumberFormat("en-US");
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

type ProviderResult = PerformanceResponse["openai"];
type Week = ProviderResult["weeks"][number] & {
  sessionRate: number | null;
  turnRate: number | null;
};

function rate(part: number, total: number) {
  return total === 0 ? null : part / total * 100;
}

function displayRate(value: number | null) {
  return value === null ? "No data" : `${value.toFixed(1)}%`;
}

function formatModel(model: string) {
  if (model === "all") return "All models";
  return model.split(/[-_]/).map((part) =>
    part.toLowerCase() === "gpt"
      ? "GPT"
      : part ? part[0].toUpperCase() + part.slice(1) : part
  ).join(" ");
}

function MissTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: Week }>;
}) {
  const week = payload?.[0]?.payload;
  if (!active || !week) return null;
  return (
    <div className="usage-tooltip performance-tooltip">
      <p>
        {date.format(new Date(`${week.date}T00:00:00`))}–
        {date.format(new Date(`${week.endDate}T00:00:00`))}
      </p>
      <div>
        <span>Sessions with a miss</span>
        <strong>
          {week.sessionsWithMiss} of {week.sessions} · {displayRate(week.sessionRate)}
        </strong>
      </div>
      <div>
        <span>Turns with a miss</span>
        <strong>
          {week.turnsWithMiss} of {week.turns} · {displayRate(week.turnRate)}
        </strong>
      </div>
    </div>
  );
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function EfficiencyBoxPlot({ weeks }: { weeks: ProviderResult["weeks"] }) {
  const [selected, setSelected] = useState<ProviderResult["weeks"][number]>();
  const width = 720;
  const height = 260;
  const left = 52;
  const right = 18;
  const top = 14;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const step = plotWidth / Math.max(weeks.length, 1);
  const y = (value: number) => top + (1 - value) * plotHeight;
  const selectedEfficiency = selected?.efficiency;

  return (
    <div className="efficiency-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Weekly cache efficiency distributions">
        {[0, 0.25, 0.5, 0.75, 1].map((value) => (
          <g key={value}>
            <line
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
              className="efficiency-grid-line"
            />
            <text x={left - 9} y={y(value) + 3} textAnchor="end" className="efficiency-axis-label">
              {Math.round(value * 100)}%
            </text>
          </g>
        ))}
        {weeks.map((week, index) => {
          const value = week.efficiency;
          const x = left + step * index + step / 2;
          const boxWidth = Math.min(24, step * .48);
          return (
            <g key={week.date}>
              {value && (
                <g
                  className={`efficiency-box ${value.sampleSize < 5 ? "small-sample" : ""}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${week.date}, median ${percent(value.median)}, ${value.sampleSize} sessions`}
                  onMouseEnter={() => setSelected(week)}
                  onMouseLeave={() => setSelected(undefined)}
                  onFocus={() => setSelected(week)}
                  onBlur={() => setSelected(undefined)}
                >
                  <line x1={x} x2={x} y1={y(value.upperWhisker)} y2={y(value.lowerWhisker)} />
                  <line x1={x - boxWidth / 3} x2={x + boxWidth / 3} y1={y(value.upperWhisker)} y2={y(value.upperWhisker)} />
                  <line x1={x - boxWidth / 3} x2={x + boxWidth / 3} y1={y(value.lowerWhisker)} y2={y(value.lowerWhisker)} />
                  <rect
                    x={x - boxWidth / 2}
                    y={y(value.q3)}
                    width={boxWidth}
                    height={Math.max(1, y(value.q1) - y(value.q3))}
                  />
                  <line
                    className="efficiency-median"
                    x1={x - boxWidth / 2}
                    x2={x + boxWidth / 2}
                    y1={y(value.median)}
                    y2={y(value.median)}
                  />
                </g>
              )}
              {(index % 2 === 0 || weeks.length <= 8) && (
                <text x={x} y={height - 17} textAnchor="middle" className="efficiency-axis-label">
                  {date.format(new Date(`${week.date}T00:00:00`))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="efficiency-tooltip-slot" aria-live="polite">
        {selected && selectedEfficiency
          ? (
            <div className="efficiency-tooltip">
              <div className="efficiency-tooltip-heading">
                <p>
                  {date.format(new Date(`${selected.date}T00:00:00`))}–
                  {date.format(new Date(`${selected.endDate}T00:00:00`))}
                </p>
                <strong>{selectedEfficiency.sampleSize} sessions</strong>
                {selectedEfficiency.sampleSize < 5 && <small>Small sample</small>}
              </div>
              <dl>
                <div><dt>Lower</dt><dd>{percent(selectedEfficiency.lowerWhisker)}</dd></div>
                <div><dt>P25</dt><dd>{percent(selectedEfficiency.q1)}</dd></div>
                <div><dt>Median</dt><dd>{percent(selectedEfficiency.median)}</dd></div>
                <div><dt>P75</dt><dd>{percent(selectedEfficiency.q3)}</dd></div>
                <div><dt>Upper</dt><dd>{percent(selectedEfficiency.upperWhisker)}</dd></div>
                <div><dt>Average</dt><dd>{percent(selectedEfficiency.average)}</dd></div>
                <div><dt>Outliers</dt><dd>{selectedEfficiency.outliers}</dd></div>
              </dl>
            </div>
          )
          : <span className="efficiency-tooltip-hint">Hover or focus a weekly box for details</span>}
      </div>
    </div>
  );
}

function EfficiencyPanel({ title, result }: { title: string; result?: ProviderResult }) {
  return (
    <article className="performance-provider efficiency-panel">
      <div className="performance-provider-heading">
        <div>
          <h2>{title}</h2>
        </div>
        <span className="efficiency-model">
          {formatModel(result?.selectedModel ?? "all")}
        </span>
      </div>
      {!result
        ? <div className="performance-chart"><div className="chart-message">Loading distribution…</div></div>
        : <EfficiencyBoxPlot weeks={result.weeks} />}
    </article>
  );
}

function ProviderPanel({
  title,
  result,
  models,
  onModelChange,
}: {
  title: string;
  result?: ProviderResult;
  models: string[];
  onModelChange: (model: string) => void;
}) {
  const rows: Week[] = (result?.weeks ?? []).map((week) => ({
    ...week,
    sessionRate: rate(week.sessionsWithMiss, week.sessions),
    turnRate: rate(week.turnsWithMiss, week.turns),
  }));
  return (
    <article className="performance-provider">
      <div className="performance-provider-heading">
        <div>
          <p className="eyebrow">Provider</p>
          <h2>{title}</h2>
        </div>
        <label>
          <span>Model</span>
          <select
            value={result?.selectedModel ?? "all"}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="all">All models</option>
            {models.map((model) => (
              <option key={model} value={model}>{formatModel(model)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="performance-totals">
        <div>
          <strong>{integer.format(result?.sessions ?? 0)}</strong>
          <span>Sessions</span>
        </div>
        <div>
          <strong>{integer.format(result?.turns ?? 0)}</strong>
          <span>Turns</span>
        </div>
        <div>
          <strong>
            {result ? displayRate(rate(result.sessionsWithMiss, result.sessions)) : "–"}
          </strong>
          <span>Sessions with miss</span>
        </div>
        <div>
          <strong>
            {result ? displayRate(rate(result.turnsWithMiss, result.turns)) : "–"}
          </strong>
          <span>Turns with miss</span>
        </div>
      </div>
      <div className="performance-chart">
        {!result
          ? <div className="chart-message">Loading comparison…</div>
          : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 12, right: 10, bottom: 4, left: -12 }}>
                <CartesianGrid vertical={false} stroke="#e6e2d9" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => date.format(new Date(`${value}T00:00:00`))}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, 100]}
                  tickFormatter={(value) => `${value}%`}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip content={<MissTooltip />} />
                <Line
                  type="monotone"
                  dataKey="sessionRate"
                  name="Sessions"
                  stroke="#b4522d"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#b4522d", strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: "#b4522d", stroke: "#fffdf8", strokeWidth: 2 }}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="turnRate"
                  name="Turns"
                  stroke="#466244"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#466244", strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: "#466244", stroke: "#fffdf8", strokeWidth: 2 }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>
      <div className="performance-legend">
        <span><i className="session-series" /> Sessions with any miss</span>
        <span><i className="turn-series" /> Turns with any miss</span>
      </div>
    </article>
  );
}

export function PerformancePage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<PerformanceResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getPerformance(search.harness, search.openai, search.anthropic).then((result) => {
      if (active) setData(result);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load performance");
    });
    return () => { active = false; };
  }, [search.harness, search.openai, search.anthropic]);

  function update(next: Partial<typeof search>) {
    navigate({ search: { ...search, ...next } });
  }

  return (
    <main>
      <SiteHeader active="performance" />
      <section className="performance-intro">
        <div>
          <p className="eyebrow">Model comparison</p>
          <h2>Cache performance</h2>
          <p>Weekly session cohorts from the last 90 days.</p>
        </div>
        <label>
          <span>Harness</span>
          <select
            value={search.harness}
            onChange={(event) => update({ harness: event.target.value as typeof search.harness })}
          >
            <option value="all">All harnesses</option>
            <option value="claude-code">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="pi">PI</option>
            <option value="codex">Codex</option>
          </select>
        </label>
      </section>
      {error && <div className="error performance-error">{error}</div>}
      <section className="performance-grid">
        <ProviderPanel
          title="OpenAI"
          result={data?.openai}
          models={data?.models.openai ?? []}
          onModelChange={(openai) => update({ openai })}
        />
        <ProviderPanel
          title="Anthropic"
          result={data?.anthropic}
          models={data?.models.anthropic ?? []}
          onModelChange={(anthropic) => update({ anthropic })}
        />
      </section>
      <section className="performance-section-heading">
        <h2>Cache efficiency</h2>
      </section>
      <section className="performance-grid">
        <EfficiencyPanel title="OpenAI" result={data?.openai} />
        <EfficiencyPanel title="Anthropic" result={data?.anthropic} />
      </section>
    </main>
  );
}
