import { Fragment, useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  CacheAssessment,
  CacheSummary,
  ModelCall,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { getSession, getSessions } from "./api.ts";
import claudeCodeIcon from "./assets/icons/claudecode-color.svg";
import codexIcon from "./assets/icons/codex-logo-light.svg";
import openCodeIcon from "./assets/icons/opencode-logo-light.svg";
import piIcon from "./assets/icons/pi-logo.svg";
import { UsageChart } from "./UsageChart.tsx";

const route = getRouteApi("/");
const integer = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const COST_EPSILON = 0.0001;

function TokenValue({ value }: { value: number }) {
  return <span title={integer.format(value)}>{compact.format(value)}</span>;
}

function cacheHitRate(tokens: TokenUsage) {
  const input = tokens.uncachedInput + tokens.cacheRead +
    (tokens.cacheWrite ?? 0);
  return input === 0 ? undefined : tokens.cacheRead / input;
}

const cacheStatusLabels: Record<CacheAssessment["status"], string> = {
  baseline: "Baseline",
  hit: "Hit",
  "partial-hit": "Partial hit",
  "full-miss": "Full miss",
  "not-comparable": "Not comparable",
  unknown: "Unavailable",
};

const cacheAssessmentReasonLabels = {
  "no-predecessor": "No preceding comparable call",
  "model-change": "New cache chain: provider or model changed",
  "no-reusable-cache": "No reusable cache in the preceding call",
} as const;

function CacheAssessmentBadge(
  { assessment }: { assessment?: CacheAssessment },
) {
  if (!assessment || assessment.status === "baseline") return null;
  const title = assessment.reason !== undefined
    ? cacheAssessmentReasonLabels[assessment.reason]
    : assessment.retainedRatio === undefined ||
        assessment.previousReusableTokens === undefined
    ? "No comparable preceding call"
    : `Retained ${(assessment.retainedRatio * 100).toFixed(1)}% · Read ${
      integer.format(
        Math.round(
          assessment.retainedRatio * assessment.previousReusableTokens,
        ),
      )
    } of ${
      integer.format(assessment.previousReusableTokens)
    } previously reusable tokens`;
  const label = assessment.status === "not-comparable"
    ? assessment.reason === "model-change"
      ? "New cache chain"
      : "No prior cache"
    : cacheStatusLabels[assessment.status];
  return (
    <span
      className={`cache-assessment cache-assessment-${assessment.status}`}
      title={title}
    >
      {label}
    </span>
  );
}

function cacheSummaryTitle(summary: CacheSummary) {
  return `${summary.hits} hits · ${summary.partialHits} partial hits · ${summary.fullMisses} full misses · ${summary.baseline} baseline · ${summary.notComparable} not comparable · ${summary.unknown} unavailable`;
}

function hasCacheOutcome(summary?: CacheSummary) {
  return summary !== undefined &&
    summary.hits + summary.partialHits + summary.fullMisses + summary.unknown >
      0;
}

function CacheSummaryBadge({ summary }: { summary?: CacheSummary }) {
  if (!summary || !hasCacheOutcome(summary)) return null;
  const comparable = summary.hits + summary.partialHits + summary.fullMisses;
  const title = cacheSummaryTitle(summary);
  const parts = [
    summary.fullMisses > 0
      ? `${summary.fullMisses} full miss${summary.fullMisses === 1 ? "" : "es"}`
      : undefined,
    summary.partialHits > 0
      ? `${summary.partialHits} partial hit${
        summary.partialHits === 1 ? "" : "s"
      }`
      : undefined,
    summary.hits > 0
      ? `${summary.hits} hit${summary.hits === 1 ? "" : "s"}`
      : undefined,
    summary.unknown > 0 ? `${summary.unknown} unavailable` : undefined,
  ].filter(Boolean);
  const status = comparable === 0
    ? "unknown"
    : summary.fullMisses > 0
    ? "full-miss"
    : summary.partialHits > 0
    ? "partial"
    : summary.hits > 0
    ? "hit"
    : "unknown";
  return (
    <span
      className={`cache-summary cache-summary-${status}`}
      title={title}
    >
      {parts.join(" · ") || "Unavailable"}
    </span>
  );
}

function CacheMetric({
  read,
  write,
  share,
  summary,
  peak,
}: {
  read: number;
  write?: number;
  share?: number;
  summary?: CacheSummary;
  peak?: number;
}) {
  const title = [
    `${integer.format(read)} cached tokens read`,
    write === undefined
      ? "Cache write not reported"
      : `${integer.format(write)} cache write tokens`,
    share === undefined
      ? undefined
      : `${(share * 100).toFixed(1)}% cached input`,
    summary === undefined ? undefined : cacheSummaryTitle(summary),
    peak === undefined || peak === read
      ? undefined
      : `${integer.format(peak)} peak cached tokens read`,
  ].filter(Boolean).join(" · ");
  return (
    <span className="metric-stack cache-metric" title={title}>
      <span>
        <TokenValue value={read} /> <span className="cache-unit">read</span>
      </span>
      {write !== undefined && (
        <small>
          <TokenValue value={write} /> write
        </small>
      )}
      <small>
        {share === undefined
          ? "Coverage unavailable"
          : `${(share * 100).toFixed(1)}% cached input`}
      </small>
      {hasCacheOutcome(summary) && (
        <small>
          <CacheSummaryBadge summary={summary} />
        </small>
      )}
      {peak !== undefined && peak !== read && (
        <small>
          Peak <TokenValue value={peak} />
        </small>
      )}
    </span>
  );
}

function duration(startedAt?: number, completedAt?: number) {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const milliseconds = completedAt - startedAt;
  if (milliseconds < 0) return undefined;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function sessionSpan(
  session: Pick<SessionSummary, "startedAt" | "endedAt" | "updatedAt"> & {
    turns?: SessionDetail["turns"];
  },
) {
  if (session.startedAt !== undefined && session.endedAt !== undefined) {
    return {
      start: session.startedAt,
      end: session.endedAt,
      label: duration(session.startedAt, session.endedAt),
    };
  }
  if (!session.turns || session.turns.length === 0) return undefined;
  const starts = session.turns.map((turn) => turn.startedAt);
  const ends = session.turns.flatMap((turn) =>
    turn.calls.map((call) => call.completedAt ?? call.startedAt)
  );
  const start = Math.min(...starts);
  const end = ends.length > 0 ? Math.max(...ends) : session.updatedAt;
  return { start, end, label: duration(start, end) };
}

function turnMetrics(calls: ModelCall[]) {
  let uncachedInput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let hasWrite = false;
  let output = 0;
  let reasoning = 0;
  let processed = 0;
  let reportedCost = 0;
  let hasReported = false;
  let computedCost = 0;
  let hasComputed = true;
  let start: number | undefined;
  let end: number | undefined;

  for (const call of calls) {
    uncachedInput += call.tokens.uncachedInput;
    cacheRead += call.tokens.cacheRead;
    if (call.tokens.cacheWrite !== undefined) {
      cacheWrite += call.tokens.cacheWrite;
      hasWrite = true;
    }
    output += call.tokens.output;
    reasoning += call.tokens.reasoning;
    processed += call.tokens.processed;
    if (call.reportedCost !== undefined) {
      reportedCost += call.reportedCost;
      hasReported = true;
    }
    if (call.computedCost === undefined) hasComputed = false;
    else computedCost += call.computedCost;
    start = start === undefined
      ? call.startedAt
      : Math.min(start, call.startedAt);
    const callEnd = call.completedAt ?? call.startedAt;
    end = end === undefined ? callEnd : Math.max(end, callEnd);
  }

  return {
    uncachedInput,
    cacheRead,
    cacheWrite: hasWrite ? cacheWrite : undefined,
    output,
    reasoning,
    processed,
    reportedCost: hasReported ? reportedCost : undefined,
    computedCost: hasComputed && calls.length > 0 ? computedCost : undefined,
    duration: duration(start, end),
  };
}

function costsMismatch(reported?: number, computed?: number) {
  if (reported === undefined || reported === 0) return false;
  if (computed === undefined) return false;
  return Math.abs(reported - computed) > COST_EPSILON;
}

function CostCell({
  reported,
  computed,
}: {
  reported?: number;
  computed?: number;
}) {
  const mismatch = costsMismatch(reported, computed);
  const primary = computed === undefined ? "-" : dollars.format(computed);
  const reportedLabel = reported === undefined
    ? "Reported: n/a"
    : `Reported: ${dollars.format(reported)}`;
  const computedLabel = computed === undefined
    ? "Computed: n/a"
    : `Computed: ${dollars.format(computed)}`;
  const title = mismatch
    ? `${computedLabel} · ${reportedLabel} (mismatch)`
    : `${computedLabel} · ${reportedLabel}`;

  return (
    <span
      className={`cost-cell${mismatch ? " cost-mismatch" : ""}`}
      title={title}
    >
      <span>{primary}</span>
      {mismatch && (
        <span className="cost-mismatch-icon" aria-label="Cost mismatch">!</span>
      )}
    </span>
  );
}

function harnessTitle(harness: SessionSummary["harness"]) {
  if (harness === "claude-code") return "Claude Code";
  if (harness === "pi") return "PI";
  if (harness === "codex") return "Codex";
  return "OpenCode";
}

function HarnessIcon({ harness }: { harness: SessionSummary["harness"] }) {
  const title = harnessTitle(harness);
  const src = harness === "claude-code"
    ? claudeCodeIcon
    : harness === "codex"
    ? codexIcon
    : harness === "pi"
    ? piIcon
    : openCodeIcon;
  return (
    <span className={`harness-icon harness-${harness}`} title={title}>
      <img src={src} alt={title} width={16} height={16} />
    </span>
  );
}

function activitySummary(call: ModelCall) {
  const imageLabel = call.activity.images === undefined
    ? ""
    : `${call.activity.images} image${
      call.activity.images === 1 ? "" : "s"
    } + `;
  const names = [...new Set(call.activity.tools.map((tool) => tool.name))];
  if (call.activity.tools.length > 0) {
    return `${imageLabel}${call.activity.tools.length} ${
      call.activity.tools.length === 1 ? "tool" : "tools"
    } | ${names.join(", ")}`;
  }
  if (call.activity.finishReason === "stop") {
    return `${imageLabel}Final response`;
  }
  if (call.activity.hasText) return `${imageLabel}Text response`;
  if (call.activity.hasReasoning) return `${imageLabel}Reasoning`;
  return imageLabel + (call.activity.finishReason ?? "Model call");
}

function callSubagents(call: ModelCall, session: SessionDetail) {
  const seen = new Set<string>();
  const children: SessionDetail[] = [];
  for (const tool of call.activity.tools) {
    if (!tool.childSessionID || seen.has(tool.childSessionID)) continue;
    const child = session.subagents.find((subagent) =>
      subagent.id === tool.childSessionID
    );
    if (!child) continue;
    seen.add(child.id);
    children.push(child);
  }
  return children;
}

function turnSubagents(
  turn: SessionDetail["turns"][number],
  session: SessionDetail,
) {
  const seen = new Set<string>();
  const children: SessionDetail[] = [];
  for (const call of turn.calls) {
    for (const child of callSubagents(call, session)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      children.push(child);
    }
  }
  return children;
}

function SubagentBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="subagent-badge"
      title={`${count} subagent${count === 1 ? "" : "s"} spawned`}
    >
      {count} sub
    </span>
  );
}

function CallTable({
  calls,
  session,
  expandedCallID,
  setExpandedCallID,
  expandedSubagentID,
  setExpandedSubagentID,
}: {
  calls: ModelCall[];
  session: SessionDetail;
  expandedCallID?: string;
  setExpandedCallID: (id: string | undefined) => void;
  expandedSubagentID?: string;
  setExpandedSubagentID: (id: string | undefined) => void;
}) {
  if (calls.length === 0) {
    return <p className="empty-turn">No completed model calls</p>;
  }

  return (
    <div className="call-table-wrap">
      <table className="data-table call-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Model time</th>
            <th>Outcome</th>
            <th>Model</th>
            <th>Uncached input</th>
            <th>Cache</th>
            <th>Completion</th>
            <th>Processed</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const expanded = expandedCallID === call.id;
            const callDuration = duration(call.startedAt, call.completedAt);
            const subagents = callSubagents(call, session);
            return (
              <Fragment key={call.id}>
                <tr className={expanded ? "row-open" : undefined}>
                  <td>{call.callWithinTurn}</td>
                  <td title={fullTimestamp.format(call.startedAt)}>
                    {timeOnly.format(call.startedAt)}
                  </td>
                  <td className={callDuration ? undefined : "muted"}>
                    {callDuration ?? "—"}
                  </td>
                  <td className="activity-cell">
                    <button
                      type="button"
                      className="activity-button"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedCallID(expanded ? undefined : call.id)}
                    >
                      <span className="activity-summary-line">
                        <span>{activitySummary(call)}</span>
                        <SubagentBadge count={subagents.length} />
                      </span>
                      <small>
                        {expanded ? "Hide details" : "Show details"}
                        {subagents.length > 0 && !expanded
                          ? ` · ${subagents.length} subagent${
                            subagents.length === 1 ? "" : "s"
                          }`
                          : ""}
                      </small>
                    </button>
                  </td>
                  <td>
                    <span className="provider">{call.provider}</span>
                    {call.model}
                  </td>
                  <td>
                    <TokenValue value={call.tokens.uncachedInput} />
                  </td>
                  <td
                    title={`Cache read ${
                      integer.format(call.tokens.cacheRead)
                    }${
                      call.tokens.cacheWrite === undefined
                        ? " · Cache write not reported"
                        : ` · Cache write ${
                          integer.format(call.tokens.cacheWrite)
                        }`
                    }`}
                  >
                    <span className="cache-cell-content cache-call">
                      <span
                        className={`metric-stack${
                          call.tokens.cacheRead > 0 ? " cache-hit" : " muted"
                        }`}
                      >
                        <span>
                          <TokenValue value={call.tokens.cacheRead} /> read
                        </span>
                        {call.tokens.cacheWrite !== undefined && (
                          <small>
                            <TokenValue value={call.tokens.cacheWrite} /> write
                          </small>
                        )}
                      </span>
                      <CacheAssessmentBadge
                        assessment={call.cacheAssessment}
                      />
                    </span>
                  </td>
                  <td>
                    <TokenValue
                      value={call.tokens.output + call.tokens.reasoning}
                    />
                  </td>
                  <td>
                    <TokenValue value={call.tokens.processed} />
                  </td>
                  <td>
                    <CostCell
                      reported={call.reportedCost}
                      computed={call.computedCost}
                    />
                  </td>
                </tr>
                {expanded && (
                  <tr className="activity-detail-row">
                    <td colSpan={10}>
                      <div className="activity-detail">
                        <div className="activity-meta">
                          <span className="chip">
                            {call.activity.finishReason === "stop"
                              ? "Final"
                              : "Model call"}
                          </span>
                          {call.activity.hasReasoning && (
                            <span className="chip chip-muted">Reasoning</span>
                          )}
                          {call.activity.hasText && (
                            <span className="chip chip-muted">Text</span>
                          )}
                          {callDuration && <span>Model {callDuration}</span>}
                          {call.activity.finishReason && (
                            <span>
                              Finished: {call.activity.finishReason}
                            </span>
                          )}
                        </div>
                        {call.activity.tools.length === 0
                          ? (
                            <p>
                              No tool calls in this model invocation.
                            </p>
                          )
                          : (
                            <div className="tool-events">
                              {call.activity.tools.map((tool, index) => {
                                const child = tool.childSessionID
                                  ? session.subagents.find((subagent) =>
                                    subagent.id === tool.childSessionID
                                  )
                                  : undefined;
                                const childExpanded = child &&
                                  expandedSubagentID === child.id;
                                return (
                                  <div
                                    className={child
                                      ? "tool-event has-subagent"
                                      : "tool-event"}
                                    key={`${tool.name}-${index}`}
                                  >
                                    <strong>{tool.name}</strong>
                                    <span
                                      className={`tool-status tool-status-${tool.status}`}
                                    >
                                      {tool.status}
                                    </span>
                                    <span>
                                      {duration(
                                        tool.startedAt,
                                        tool.completedAt,
                                      ) ?? "duration unavailable"}
                                    </span>
                                    {child && (
                                      <>
                                        <button
                                          type="button"
                                          className="subagent-toggle"
                                          aria-expanded={childExpanded}
                                          onClick={() =>
                                            setExpandedSubagentID(
                                              childExpanded
                                                ? undefined
                                                : child.id,
                                            )}
                                        >
                                          <span>
                                            <strong>{child.title}</strong>
                                            <small>
                                              {child.agent ?? "subagent"} ·{" "}
                                              {child.userTurns} turns ·{" "}
                                              {child.modelCalls} calls ·{" "}
                                              {child.computedCost === undefined
                                                ? "unpriced"
                                                : dollars.format(
                                                  child.computedCost,
                                                )}
                                            </small>
                                          </span>
                                          <b>
                                            {childExpanded ? "Hide" : "Expand"}
                                          </b>
                                        </button>
                                        {childExpanded && (
                                          <SessionBreakdown
                                            session={child}
                                            nested
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionBreakdown({
  session,
  nested = false,
}: {
  session: SessionDetail;
  nested?: boolean;
}) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedCallID, setExpandedCallID] = useState<string>();
  const [expandedSubagentID, setExpandedSubagentID] = useState<string>();
  const span = sessionSpan(session);

  function toggleTurn(number: number) {
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  return (
    <div className={nested ? "breakdown nested-breakdown" : "breakdown"}>
      {nested && (
        <div className="subagent-heading">
          <div className="subagent-identity">
            <div className="chip-row">
              <span className="chip">Subagent</span>
              {session.agent && (
                <span className="chip chip-muted">{session.agent}</span>
              )}
            </div>
            <strong>{session.title}</strong>
            <code className="session-id">{session.id}</code>
          </div>
          <div className="subagent-stats">
            <span>{session.userTurns} turns</span>
            <span>{session.modelCalls} calls</span>
            {span?.label && <span>{span.label}</span>}
            <CostCell
              reported={session.reportedCost}
              computed={session.computedCost}
            />
          </div>
        </div>
      )}

      <div className="turn-table-wrap">
        <table className="data-table turn-table">
          <thead>
            <tr>
              <th>User turn</th>
              <th>Started</th>
              <th>Model span</th>
              <th>Model calls</th>
              <th>Uncached input</th>
              <th title="Cache reads, writes, coverage, and cache outcome">
                Cache
              </th>
              <th>Completion</th>
              <th>Processed</th>
              <th>Cost</th>
              <th aria-label="Expand" />
            </tr>
          </thead>
          <tbody>
            {session.turns.map((turn) => {
              const metrics = turnMetrics(turn.calls);
              const open = expandedTurns.has(turn.number);
              const subs = turnSubagents(turn, session);
              return (
                <Fragment key={turn.number}>
                  <tr
                    className={`turn-row${open ? " row-open" : ""}`}
                    onClick={() => toggleTurn(turn.number)}
                    aria-expanded={open}
                  >
                    <td className="turn-label">
                      <span className="turn-label-line">
                        Turn {turn.number}
                        <SubagentBadge count={subs.length} />
                      </span>
                    </td>
                    <td title={fullTimestamp.format(turn.startedAt)}>
                      <span className="metric-stack timestamp-stack">
                        <span>{dateOnly.format(turn.startedAt)}</span>
                        <small>{timeOnly.format(turn.startedAt)}</small>
                      </span>
                    </td>
                    <td className={metrics.duration ? undefined : "muted"}>
                      {metrics.duration ?? "—"}
                    </td>
                    <td>{turn.calls.length}</td>
                    <td>
                      <TokenValue value={metrics.uncachedInput} />
                    </td>
                    <td>
                      <CacheMetric
                        read={turn.cacheSummary?.totalCacheRead ??
                          metrics.cacheRead}
                        write={metrics.cacheWrite}
                        share={turn.cacheSummary?.cachedInputShare}
                        summary={turn.cacheSummary}
                        peak={turn.cacheSummary && turn.calls.length > 1
                          ? turn.cacheSummary.peakCacheRead
                          : undefined}
                      />
                    </td>
                    <td>
                      <TokenValue
                        value={metrics.output + metrics.reasoning}
                      />
                    </td>
                    <td>
                      <TokenValue value={metrics.processed} />
                    </td>
                    <td>
                      <CostCell
                        reported={metrics.reportedCost}
                        computed={metrics.computedCost}
                      />
                    </td>
                    <td className="chevron">{open ? "−" : "+"}</td>
                  </tr>
                  {open && (
                    <tr className="turn-detail-row">
                      <td colSpan={10}>
                        <CallTable
                          calls={turn.calls}
                          session={session}
                          expandedCallID={expandedCallID}
                          setExpandedCallID={setExpandedCallID}
                          expandedSubagentID={expandedSubagentID}
                          setExpandedSubagentID={setExpandedSubagentID}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SessionsPage() {
  const { page, harness } = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<SessionListResponse>();
  const [expandedIDs, setExpandedIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getSessions(page, harness).then((result) => active && setData(result))
      .catch(
        (reason) => {
          if (active) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Unable to load sessions",
            );
          }
        },
      );
    return () => {
      active = false;
    };
  }, [page, harness]);

  async function toggleSession(id: string) {
    if (expandedIDs.has(id)) {
      setExpandedIDs((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      return;
    }
    setExpandedIDs((current) => new Set(current).add(id));
    if (details[id]) return;
    try {
      const summary = data?.items.find((session) => session.id === id);
      if (!summary) return;
      const detail = await getSession(id, summary.harness);
      setDetails((current) => ({ ...current, [id]: detail }));
    } catch (reason) {
      setExpandedIDs((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setError(
        reason instanceof Error ? reason.message : "Unable to load session",
      );
    }
  }

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Local agent economics</p>
          <h1>Frugal Tokens</h1>
        </div>
        <p className="intro">
          See where tokens went, what was reused, and what each model call cost.
        </p>
      </header>

      <UsageChart harness={harness} />

      <section className="sessions-panel">
        <div className="panel-heading">
          <div>
            <h2>Recent sessions</h2>
            <p>Ordered by latest activity</p>
          </div>
          <div className="session-filters">
            {data && (
              <span className="session-count">
                {integer.format(data.pagination.totalItems)} sessions
              </span>
            )}
            <label>
              <span>Harness</span>
              <select
                value={harness}
                onChange={(event) =>
                  navigate({
                    search: {
                      page: 1,
                      harness: event.target.value as typeof harness,
                    },
                  })}
              >
                <option value="all">All</option>
                <option value="claude-code">Claude Code</option>
                <option value="opencode">OpenCode</option>
                <option value="pi">PI</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {!data && !error && (
          <div className="loading">Reading local sessions...</div>
        )}
        {data && (
          <>
            <div className="session-table-wrap">
              <table className="data-table session-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Provider / model</th>
                    <th>Elapsed</th>
                    <th title="User turns and model calls in the main session">
                      Turns / calls
                    </th>
                    <th title="Child sessions and model calls inside them">
                      Subagents / calls
                    </th>
                    <th>Uncached input</th>
                    <th title="Cache reads, writes, coverage, and cache outcome">
                      Cache
                    </th>
                    <th>Processed</th>
                    <th title="Computed cost; ! if reported is non-zero and differs">
                      Cost
                    </th>
                    <th aria-label="Expand" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((session) => {
                    const expanded = expandedIDs.has(session.id);
                    const detail = details[session.id];
                    const span = sessionSpan(detail ?? session);
                    return (
                      <Fragment key={session.id}>
                        <tr
                          className={`session-row${
                            expanded ? " row-open" : ""
                          }`}
                          onClick={() => toggleSession(session.id)}
                          aria-expanded={expanded}
                        >
                          <td className="session-cell">
                            <div className="session-identity">
                              <HarnessIcon harness={session.harness} />
                              <div className="session-copy">
                                <strong
                                  className="session-title"
                                  title={session.title}
                                >
                                  {session.title}
                                </strong>
                                <small
                                  className="session-id"
                                  title={session.id}
                                >
                                  {session.id}
                                </small>
                                <small className="updated-at">
                                  {new Date(session.updatedAt).toLocaleString()}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="provider">
                              {session.providers.join(", ") || "unknown"}
                            </span>
                            {session.models.join(", ") || "unknown"}
                          </td>
                          <td
                            className={span?.label ? undefined : "muted"}
                            title={span
                              ? `${fullTimestamp.format(span.start)} → ${
                                fullTimestamp.format(span.end)
                              }`
                              : undefined}
                          >
                            {span?.label ?? "—"}
                          </td>
                          <td>
                            <span className="metric-stack">
                              <span>{session.userTurns} turns</span>
                              <small>{session.modelCalls} calls</small>
                            </span>
                          </td>
                          <td>
                            <span className="metric-stack">
                              <span
                                className={session.subagentCount
                                    ? undefined
                                    : "muted"}
                              >
                                {session.subagentCount ?? 0} subagents
                              </span>
                              <small
                                className={session.subagentModelCalls
                                    ? undefined
                                    : "muted"}
                              >
                                {session.subagentModelCalls ?? 0} calls
                              </small>
                            </span>
                          </td>
                          <td>
                            <TokenValue value={session.tokens.uncachedInput} />
                          </td>
                          <td>
                            <CacheMetric
                              read={session.tokens.cacheRead}
                              write={session.tokens.cacheWrite}
                              share={cacheHitRate(session.tokens)}
                              summary={session.cacheSummary}
                            />
                          </td>
                          <td>
                            <TokenValue value={session.tokens.processed} />
                          </td>
                          <td>
                            <CostCell
                              reported={session.reportedCost}
                              computed={session.computedCost}
                            />
                          </td>
                          <td className="chevron">{expanded ? "−" : "+"}</td>
                        </tr>
                        {expanded && (
                          <tr className="detail-row">
                            <td colSpan={12}>
                              {detail
                                ? <SessionBreakdown session={detail} />
                                : (
                                  <div className="loading inset-loading">
                                    Grouping model calls by turn...
                                  </div>
                                )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Session pages">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() =>
                  navigate({ search: { page: page - 1, harness } })}
              >
                Previous
              </button>
              <span>Page {page} of {data.pagination.totalPages || 1}</span>
              <button
                type="button"
                disabled={page >= data.pagination.totalPages}
                onClick={() =>
                  navigate({ search: { page: page + 1, harness } })}
              >
                Next
              </button>
            </nav>
          </>
        )}
      </section>
    </main>
  );
}
