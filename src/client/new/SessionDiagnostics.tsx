import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  CartesianGrid,
  Label,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActivityOverviewResponse } from "../../shared/sessionSchemas.ts";
import { harnessName } from "../harness.ts";
import { compact, currency } from "./formatters.ts";
import { saveOverviewReturnScroll } from "./overviewReturnScroll.ts";
import "./SessionDiagnostics.css";

type SessionDiagnosticsData = ActivityOverviewResponse["sessionDiagnostics"];
type SessionPoint = SessionDiagnosticsData["sessions"][number];
type Metric = "spend" | "input";
type ChartPoint = SessionPoint & {
  plotValue: number;
  highestValueLabel?: string;
  highlighted: boolean;
};
type SessionDotShapeProps = {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
};

const chartMono = '"SFMono-Regular", Consolas, monospace';
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const SCALE_PIVOT: Record<Metric, number> = {
  spend: 0.1,
  input: 10_000,
};

function duration(minutes?: number) {
  if (minutes === undefined || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${decimal.format(minutes)}m`;
  if (minutes < 1_440) return `${decimal.format(minutes / 60)}h`;
  return `${decimal.format(minutes / 1_440)}d`;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function scaleValue(metric: Metric, value: number) {
  return Math.log10(1 + value / SCALE_PIVOT[metric]);
}

function unscaleValue(metric: Metric, value: number) {
  return SCALE_PIVOT[metric] * (10 ** value - 1);
}

function metricValue(metric: Metric, session: SessionPoint) {
  return metric === "spend" ? session.spend : session.processedInput;
}

function formatMetric(metric: Metric, value: number) {
  return metric === "spend" ? currency.format(value) : compact.format(value);
}

function SessionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
}) {
  const session = payload?.[0]?.payload;
  if (!active || !session) return null;
  return (
    <div className="usage-tooltip session-diagnostics-tooltip">
      <p>{session.title}</p>
      <span className="session-diagnostics-tooltip-model">
        {session.harness ? harnessName(session.harness) : "Unknown harness"}
        {session.primaryModel ? ` · ${session.primaryModel}` : ""}
      </span>
      <dl>
        <div>
          <dt>Est. active time</dt>
          <dd>{duration(session.estimatedActiveMinutes)}</dd>
        </div>
        <div>
          <dt>Session duration</dt>
          <dd>{duration(session.observedSessionMinutes)}</dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>
            {currency.format(session.spend)}
            {session.hasUnpricedSpend ? "+" : ""}
          </dd>
        </div>
        <div>
          <dt>Processed input</dt>
          <dd>{compact.format(session.processedInput)}</dd>
        </div>
        <div>
          <dt>Token reuse</dt>
          <dd>
            {session.tokenReuse === undefined
              ? "—"
              : `${decimal.format(session.tokenReuse * 100)}%`}
          </dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{session.userTurns}</dd>
        </div>
      </dl>
    </div>
  );
}

function SessionDot({
  cx,
  cy,
  payload,
  onOpen,
}: SessionDotShapeProps & { onOpen: (session: ChartPoint) => void }) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  const canOpen = payload.harness !== undefined;
  const open = () => {
    if (canOpen) onOpen(payload);
  };
  return (
    <g
      className={`session-diagnostics-point${
        payload.highlighted ? " is-highlighted" : ""
      }${canOpen ? " is-linked" : ""}`}
      role={canOpen ? "link" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open ${payload.title}` : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <circle
        cx={cx}
        cy={cy}
        r={payload.highlighted ? 4.2 : 3.1}
        fill={payload.highlighted ? "#235f59" : "#657a76"}
        fillOpacity={payload.highlighted ? 0.88 : 0.34}
        stroke={payload.highlighted ? "#235f59" : "#657a76"}
        strokeOpacity={payload.highlighted ? 1 : 0.5}
        strokeWidth={0.75}
      />
      {payload.highestValueLabel && (
        <text
          x={cx}
          y={cy - 9}
          fill="#29433f"
          fontFamily={chartMono}
          fontSize={9}
          fontWeight={700}
          paintOrder="stroke"
          pointerEvents="none"
          stroke="#fbfcfb"
          strokeLinejoin="round"
          strokeWidth={3}
          textAnchor="middle"
        >
          {payload.highestValueLabel}
        </text>
      )}
    </g>
  );
}

export function SessionDiagnostics({ data }: { data: SessionDiagnosticsData }) {
  const navigate = useNavigate();
  const [metric, setMetric] = useState<Metric>("spend");
  const sessions = data.sessions;
  const medianActive = median(
    sessions.map((session) => session.estimatedActiveMinutes),
  );
  const medianY = median(
    sessions.map((session) => metricValue(metric, session)),
  );
  const highestValueKeys = new Set(
    sessions.toSorted((a, b) => metricValue(metric, b) - metricValue(metric, a))
      .slice(0, 3).map((session) =>
        `${session.harness ?? "unknown"}:${session.id}`
      ),
  );
  const points: ChartPoint[] = sessions.map((session) => {
    const key = `${session.harness ?? "unknown"}:${session.id}`;
    const highlighted = highestValueKeys.has(key);
    const value = metricValue(metric, session);
    return {
      ...session,
      plotValue: scaleValue(metric, value),
      highlighted,
      ...(highlighted
        ? {
          highestValueLabel: `${formatMetric(metric, value)}${
            metric === "spend" && session.hasUnpricedSpend ? "+" : ""
          }`,
        }
        : {}),
    };
  });
  const metricLabel = metric === "spend" ? "Spend" : "Processed input";

  function openSession(session: ChartPoint) {
    if (!session.harness) return;
    saveOverviewReturnScroll();
    navigate({
      to: "/sessions/$harness/$sessionId",
      params: { harness: session.harness, sessionId: session.id },
      search: {
        misses: undefined,
        paths: "relative",
        color: "time",
        model: "recorded",
        thinking: "recorded",
      },
    });
  }

  return (
    <section
      className="new-placeholder-section session-diagnostics-section"
      aria-labelledby="session-diagnostics-title"
    >
      <header>
        <h2 id="session-diagnostics-title">
          {metric === "spend"
            ? "Session cost vs. active time"
            : "Processed input vs. active time"}
        </h2>
        <div className="session-diagnostics-toggle" aria-label="Chart metric">
          <button
            type="button"
            className={metric === "spend" ? "active" : ""}
            aria-pressed={metric === "spend"}
            onClick={() => setMetric("spend")}
          >
            Spend
          </button>
          <button
            type="button"
            className={metric === "input" ? "active" : ""}
            aria-pressed={metric === "input"}
            onClick={() => setMetric("input")}
          >
            Processed input
          </button>
        </div>
      </header>

      <div
        className="session-diagnostics-chart"
        role="group"
        aria-label={`${metricLabel} by estimated active time for ${sessions.length} sessions`}
      >
        {sessions.length === 0
          ? (
            <div className="session-diagnostics-message">
              No sessions in this range.
            </div>
          )
          : (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart
                margin={{ top: 30, right: 22, bottom: 28, left: 12 }}
              >
                <CartesianGrid stroke="#dfdbd1" strokeDasharray="3 5" />
                <XAxis
                  type="number"
                  dataKey="estimatedActiveMinutes"
                  name="Estimated active time"
                  domain={[0, (maximum: number) => Math.max(5, maximum)]}
                  tickFormatter={duration}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tick={{ fill: "#697572", fontFamily: chartMono, fontSize: 9 }}
                >
                  <Label
                    value="Estimated active time"
                    position="insideBottom"
                    offset={-16}
                    style={{
                      fill: "#697572",
                      fontFamily: chartMono,
                      fontSize: 9,
                    }}
                  />
                </XAxis>
                <YAxis
                  type="number"
                  dataKey="plotValue"
                  name={metricLabel}
                  domain={[0, (maximum: number) => Math.max(1, maximum)]}
                  tickFormatter={(value: number) =>
                    formatMetric(metric, unscaleValue(metric, value))}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  tick={{ fill: "#697572", fontFamily: chartMono, fontSize: 9 }}
                >
                  <Label
                    value={`${metricLabel} · log scale`}
                    angle={-90}
                    position="insideLeft"
                    offset={4}
                    style={{
                      fill: "#697572",
                      fontFamily: chartMono,
                      fontSize: 9,
                    }}
                  />
                </YAxis>
                <ReferenceLine
                  x={medianActive}
                  stroke="#7d8b86"
                  strokeOpacity={0.9}
                  strokeDasharray="4 4"
                  label={{
                    value: `Median active · ${duration(medianActive)}`,
                    position: "insideTopLeft",
                    fill: "#697572",
                    fontFamily: chartMono,
                    fontSize: 9,
                  }}
                />
                <ReferenceLine
                  y={scaleValue(metric, medianY)}
                  stroke="#7d8b86"
                  strokeOpacity={0.9}
                  strokeDasharray="4 4"
                  label={{
                    value: `Median ${
                      metric === "spend" ? "spend" : "input"
                    } · ${formatMetric(metric, medianY)}`,
                    position: "insideTopRight",
                    fill: "#697572",
                    fontFamily: chartMono,
                    fontSize: 9,
                  }}
                />
                <Tooltip
                  isAnimationActive={false}
                  cursor={{ stroke: "#aeb8b4", strokeDasharray: "2 4" }}
                  content={(props) => (
                    <SessionTooltip
                      active={props.active}
                      payload={props.payload as Array<{ payload?: ChartPoint }>}
                    />
                  )}
                />
                <Scatter
                  data={points}
                  shape={(props: SessionDotShapeProps) => (
                    <SessionDot {...props} onOpen={openSession} />
                  )}
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          )}
      </div>
    </section>
  );
}
