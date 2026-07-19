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
      <section className="performance-next" aria-label="Planned cache efficiency comparison">
        <div>
          <p className="eyebrow">Next metric</p>
          <h2>Cache efficiency distribution</h2>
          <p>Weekly session-level box and whisker comparison.</p>
        </div>
      </section>
    </main>
  );
}
