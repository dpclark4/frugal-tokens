import { useNavigate } from "@tanstack/react-router";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CartesianGrid,
  Label,
  ReferenceLine,
  ResponsiveContainer,
  ScatterChart,
  usePlotArea,
  XAxis,
  YAxis,
} from "recharts";
import type { WorkRhythmOverviewResponse } from "../../shared/sessionSchemas.ts";
import { harnessName } from "../harness.ts";
import { compact, currency, dashboardChartLabelSize } from "./formatters.ts";
import { saveOverviewReturnScroll } from "./overviewReturnScroll.ts";
import { hoverIntent } from "./hoverIntent.ts";
import "./SessionDiagnostics.css";

type SessionDiagnosticsData = WorkRhythmOverviewResponse["sessionDiagnostics"];
type SessionPoint = SessionDiagnosticsData["sessions"][number];
type Metric = "spend" | "input";
type ChartPoint = SessionPoint & {
  plotValue: number;
  highestValueLabel?: string;
  highlighted: boolean;
};
type LocatedPoint = { session: ChartPoint; x: number; y: number };

const chartMono = '"SFMono-Regular", Consolas, monospace';
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const SCALE_PIVOT = {
  spend: 0.1,
  input: 10_000,
} satisfies Record<Metric, number>;

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

function SessionTooltip({ session }: { session: ChartPoint }) {
  return (
    <div className="tooltip-surface usage-tooltip session-diagnostics-tooltip">
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

const SessionDot = memo(function SessionDot({
  point,
  onOpen,
  hover,
}: {
  point: LocatedPoint;
  onOpen: (session: ChartPoint) => void;
  hover: ReturnType<typeof hoverIntent<LocatedPoint>>;
}) {
  const { session: payload, x: cx, y: cy } = point;
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
      tabIndex={0}
      aria-label={canOpen ? `Open ${payload.title}` : payload.title}
      onClick={open}
      onPointerEnter={() => hover.enter(point)}
      onPointerLeave={hover.leave}
      onFocus={() => hover.enter(point, true)}
      onBlur={hover.leave}
      onKeyDown={(event) => {
        if (event.key === "Escape") hover.leave();
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
});

// Recharts owns axes/layout only. Its Scatter/Tooltip hover subscriptions rebuild
// every symbol on active-index changes; this layer keeps the dots static.
const SessionPoints = memo(function SessionPoints({
  points,
  maxActive,
  maxY,
  onOpen,
  onHighlightDates,
}: {
  points: ChartPoint[];
  maxActive: number;
  maxY: number;
  onOpen: (session: ChartPoint) => void;
  onHighlightDates?: (dates: string[] | undefined) => void;
}) {
  const area = usePlotArea();
  const [active, setActive] = useState<LocatedPoint>();
  const hover = useMemo(() => hoverIntent<LocatedPoint>(setActive), []);
  useEffect(() => {
    hover.leave();
    return hover.cancel;
  }, [hover, points, area]);
  useEffect(() => {
    startTransition(() => onHighlightDates?.(active?.session.dates));
    return () => {
      startTransition(() => onHighlightDates?.(undefined));
    };
  }, [active, onHighlightDates]);
  const dots = useMemo(() => {
    if (!area) return null;
    return points.map((session) => (
      <SessionDot
        key={`${session.harness ?? "unknown"}:${session.id}`}
        point={{
          session,
          x: area.x + session.estimatedActiveMinutes / maxActive * area.width,
          y: area.y + area.height - session.plotValue / maxY * area.height,
        }}
        onOpen={onOpen}
        hover={hover}
      />
    ));
  }, [area, points, maxActive, maxY, onOpen, hover]);
  if (!area) return null;
  const tooltipWidth = Math.min(300, area.width);
  const tooltipX = active
    ? Math.max(
      area.x,
      Math.min(active.x + 12, area.x + area.width - tooltipWidth),
    )
    : 0;
  const tooltipY = active
    ? Math.max(0, Math.min(active.y + 12, area.y + area.height - 260))
    : 0;
  return (
    <g>
      {dots}
      {active && (
        <g pointerEvents="none">
          <path
            d={`M ${area.x} ${active.y} H ${
              area.x + area.width
            } M ${active.x} ${area.y} V ${area.y + area.height}`}
            fill="none"
            stroke="#aeb8b4"
            strokeDasharray="2 4"
          />
          <circle
            cx={active.x}
            cy={active.y}
            r={5}
            fill="none"
            stroke="#235f59"
          />
          <foreignObject
            x={tooltipX}
            y={tooltipY}
            width={tooltipWidth}
            height={260}
          >
            <SessionTooltip session={active.session} />
          </foreignObject>
        </g>
      )}
    </g>
  );
});

export const SessionDiagnostics = memo(function SessionDiagnostics({
  data,
  onHighlightDates,
}: {
  data: SessionDiagnosticsData;
  onHighlightDates?: (dates: string[] | undefined) => void;
}) {
  const navigate = useNavigate();
  const [metric, setMetric] = useState<Metric>("spend");
  const sessions = data.sessions;
  const { medianActive, medianY, points } = useMemo(() => {
    const medianActive = median(
      sessions.map((session) => session.estimatedActiveMinutes),
    );
    const medianY = median(
      sessions.map((session) => metricValue(metric, session)),
    );
    const highestValueKeys = new Set(
      sessions.toSorted((a, b) =>
        metricValue(metric, b) - metricValue(metric, a)
      )
        .slice(0, 3).map((session) =>
          `${session.harness ?? "unknown"}:${session.id}`
        ),
    );
    const points: ChartPoint[] = sessions.map((session) => {
      const key = `${session.harness ?? "unknown"}:${session.id}`;
      const highlighted = highestValueKeys.has(key);
      const value = metricValue(metric, session);
      const point: ChartPoint = {
        ...session,
        plotValue: scaleValue(metric, value),
        highlighted,
      };
      if (highlighted) {
        point.highestValueLabel = `${formatMetric(metric, value)}${
          metric === "spend" && session.hasUnpricedSpend ? "+" : ""
        }`;
      }
      return point;
    });
    return { medianActive, medianY, points };
  }, [sessions, metric]);
  const metricLabel = metric === "spend" ? "Spend" : "Processed input";

  const openSession = useCallback((session: ChartPoint) => {
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
  }, [navigate]);

  const maxActive = Math.max(
    5,
    ...points.map((point) => point.estimatedActiveMinutes),
  );
  const maxY = Math.max(1, ...points.map((point) => point.plotValue));

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
                  domain={[0, maxActive]}
                  allowDataOverflow
                  tickFormatter={duration}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tick={{
                    fill: "#697572",
                    fontFamily: chartMono,
                    fontSize: dashboardChartLabelSize,
                  }}
                >
                  <Label
                    value="Estimated active time"
                    position="insideBottom"
                    offset={-16}
                    style={{
                      fill: "#697572",
                      fontFamily: chartMono,
                      fontSize: dashboardChartLabelSize,
                    }}
                  />
                </XAxis>
                <YAxis
                  type="number"
                  dataKey="plotValue"
                  name={metricLabel}
                  domain={[0, maxY]}
                  allowDataOverflow
                  tickFormatter={(value: number) =>
                    formatMetric(metric, unscaleValue(metric, value))}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  tick={{
                    fill: "#697572",
                    fontFamily: chartMono,
                    fontSize: dashboardChartLabelSize,
                  }}
                >
                  <Label
                    value={`${metricLabel} · log scale`}
                    angle={-90}
                    position="insideLeft"
                    offset={4}
                    style={{
                      fill: "#697572",
                      fontFamily: chartMono,
                      fontSize: dashboardChartLabelSize,
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
                <SessionPoints
                  key={metric}
                  points={points}
                  maxActive={maxActive}
                  maxY={maxY}
                  onOpen={openSession}
                  onHighlightDates={onHighlightDates}
                />
              </ScatterChart>
            </ResponsiveContainer>
          )}
      </div>
    </section>
  );
});
