import { Fragment, useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  CacheAssessment,
  CacheIssue,
  CacheSummary,
  ModelCall,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { contextRange, contextSize } from "../shared/contextMetrics.ts";
import { getSession, getSessions } from "./api.ts";
import claudeCodeIcon from "./assets/icons/claudecode-color.svg";
import codexIcon from "./assets/icons/codex-logo-light.svg";
import openCodeIcon from "./assets/icons/opencode-logo-light.svg";
import piIcon from "./assets/icons/pi-logo.svg";
import { UsageChart } from "./UsageChart.tsx";
import { TtlMissCard } from "./TtlMissCard.tsx";
import { Overview } from "./Overview.tsx";

const route = getRouteApi("/");
const integer = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const sessionDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const turnDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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
const sessionStarted = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const COST_EPSILON = 0.0001;

function TokenValue({ value }: { value: number }) {
  return <span title={integer.format(value)}>{compact.format(value)}</span>;
}

function ContextMetric({
  value,
  secondary,
  secondaryLabel,
  title,
}: {
  value?: number;
  secondary?: number;
  secondaryLabel?: string;
  title?: string;
}) {
  if (value === undefined) return <span className="muted">-</span>;
  return (
    <span className="metric-stack context-metric" title={title}>
      <strong>
        <TokenValue value={value} />
      </strong>
      {secondary !== undefined && secondary !== value && secondaryLabel && (
        <small>
          <TokenValue value={secondary} /> {secondaryLabel}
        </small>
      )}
    </span>
  );
}

function ModelSummary({ models }: { models: string[] }) {
  const primary = models.at(-1) ?? "unknown";
  const others = models.slice(0, -1);
  return (
    <span className="session-model-summary">
      <span className="session-model-name" title={primary}>
        {modelDisplayName(primary)}
      </span>
      {others.length > 0 && (
        <span
          className="model-overflow"
          title={others.map(modelDisplayName).join(", ")}
          aria-label={`Other models: ${
            others.map(modelDisplayName).join(", ")
          }`}
          tabIndex={0}
        >
          +{others.length}
        </span>
      )}
    </span>
  );
}

const modelDisplayNames: Record<string, string> = {
  "claude-fable-5": "Claude Fable 5",
  "claude-mythos-5": "Claude Mythos 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-haiku-3-5": "Claude Haiku 3.5",
  "grok-4-5": "Grok 4.5",
};

function modelDisplayName(model: string) {
  const mapped = modelDisplayNames[model];
  if (mapped) return mapped;

  const names: Record<string, string> = {
    gpt: "GPT",
    claude: "Claude",
    codex: "Codex",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    sol: "Sol",
    gemini: "Gemini",
    pro: "Pro",
    mini: "Mini",
    nano: "Nano",
    o1: "O1",
    o3: "O3",
    o4: "O4",
  };
  const displayModel = model.toLowerCase().includes("claude")
    ? model.replace(/[-_]20\d{6}$/, "")
    : model;
  return displayModel.split(/[-_]/).map((part) =>
    names[part.toLowerCase()] ??
      (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
  ).join(" ");
}

function cacheHitRate(tokens: TokenUsage) {
  const input = contextSize(tokens);
  return input === 0 ? undefined : tokens.cacheRead / input;
}

function SessionInputMetric({
  tokens,
  anthropic,
  label = "input processed",
  showWriteTtl = false,
}: {
  tokens: Pick<
    TokenUsage,
    | "uncachedInput"
    | "cacheRead"
    | "cacheWrite"
    | "cacheWrite5m"
    | "cacheWrite1h"
  >;
  anthropic: boolean;
  label?: string;
  showWriteTtl?: boolean;
}) {
  const cacheWrite = tokens.cacheWrite ?? 0;
  const totalInput = tokens.uncachedInput + tokens.cacheRead + cacheWrite;
  const reused = totalInput === 0 ? undefined : tokens.cacheRead / totalInput;
  return (
    <span
      className="metric-stack session-input-metric"
      title="Cumulative input processed by all direct and subagent model calls"
    >
      <span>
        <TokenValue value={totalInput} /> {label}
      </span>
      <small>
        <TokenValue value={tokens.cacheRead} /> {anthropic ? "read" : "cached"}
        {" "}
        ·{"  "}<TokenValue value={tokens.uncachedInput} /> uncached
        {tokens.cacheWrite !== undefined && (
          <>
            · <TokenValue value={tokens.cacheWrite} /> written
          </>
        )}
      </small>
      {showWriteTtl &&
        (tokens.cacheWrite5m !== undefined ||
          tokens.cacheWrite1h !== undefined) &&
        (
          <small>
            writes: <TokenValue value={tokens.cacheWrite5m ?? 0} /> at 5m ·
            {"  "}<TokenValue value={tokens.cacheWrite1h ?? 0} /> at 1h
          </small>
        )}
      <small className={reused === undefined ? "muted" : undefined}>
        {reused === undefined
          ? "Reuse unavailable"
          : `${(reused * 100).toFixed(1)}% reused`}
      </small>
    </span>
  );
}

const cacheAssessmentReasonLabels = {
  "no-predecessor": "No preceding comparable call",
  "model-change": "New cache chain: provider or model changed",
  "no-reusable-cache": "No reusable cache in the preceding call",
} as const;

function CacheAssessmentBadge(
  { assessment, title: providedTitle }: {
    assessment?: CacheAssessment;
    title?: string;
  },
) {
  if (
    !assessment ||
    assessment.cause !== undefined ||
    (assessment.status !== "partial-hit" && assessment.status !== "full-miss")
  ) return null;
  const title = providedTitle ??
    (assessment.reason !== undefined
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
      } previously reusable tokens`);
  const label = assessment.status === "full-miss"
    ? "Full miss"
    : "Partial miss";
  return (
    <span
      className={`cache-assessment cache-issue-badge cache-assessment-${assessment.status}`}
      title={title}
    >
      {label}
    </span>
  );
}

function cacheSummaryTitle(summary: CacheSummary) {
  return `${summary.hits} hits · ${summary.partialHits} partial hits · ${summary.fullMisses} full misses · ${summary.compactionRelatedMisses} compaction-related misses · ${summary.ttlRelatedMisses} TTL misses · ${summary.unexpectedMisses} unexpected misses · ${summary.baseline} baseline · ${summary.notComparable} not comparable · ${summary.unknown} unavailable`;
}

function CompactionBadge({ count = 1 }: { count?: number }) {
  if (count === 0) return null;
  return (
    <span
      className="cache-issue-badge compaction-badge"
      title={`${count} context compaction${count === 1 ? "" : "s"}`}
    >
      Compacted
    </span>
  );
}

function TtlMissBadge({ count = 1 }: { count?: number }) {
  if (count === 0) return null;
  return (
    <span
      className="cache-issue-badge ttl-miss-badge"
      title={`${count} cache miss${count === 1 ? "" : "es"} after TTL expiry`}
    >
      TTL miss
    </span>
  );
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

function cacheIssueLabel(issue: CacheIssue) {
  return issue.scope
    ? `${issue.scope}, turn ${issue.turn}`
    : `Turn ${issue.turn}`;
}

function SessionCacheStatus({
  summary,
  issues,
  compactionCount,
}: {
  summary?: CacheSummary;
  issues?: CacheIssue[];
  compactionCount?: number;
}) {
  const full =
    issues?.filter((issue) =>
      issue.status === "full-miss" && issue.cause === undefined
    ) ?? [];
  const partial =
    issues?.filter((issue) =>
      issue.status === "partial-hit" && issue.cause === undefined
    ) ?? [];
  const ttl = issues?.filter((issue) => issue.cause === "ttl") ?? [];
  if (
    !summary ||
    (full.length === 0 && partial.length === 0 && ttl.length === 0 &&
      !compactionCount)
  ) {
    return null;
  }
  const title = [
    full.length > 0
      ? `Full miss turns:\n${full.map(cacheIssueLabel).join("\n")}`
      : undefined,
    partial.length > 0
      ? `Partial hit turns:\n${partial.map(cacheIssueLabel).join("\n")}`
      : undefined,
    ttl.length > 0
      ? `TTL miss turns:\n${ttl.map(cacheIssueLabel).join("\n")}`
      : undefined,
    `Call totals: ${cacheSummaryTitle(summary)}`,
  ].filter(Boolean).join("\n\n");
  return (
    <span className="cache-issue-counts" title={title}>
      {full.length > 0 && (
        <>
          <span className="cache-issue-badge session-cache-full">
            Full miss
          </span>
          <span className="session-cache-count">x{full.length}</span>
        </>
      )}
      {partial.length > 0 && (
        <>
          <span className="cache-issue-badge session-cache-partial">
            Partial miss
          </span>
          <span className="session-cache-count">x{partial.length}</span>
        </>
      )}
      {ttl.length > 0 && (
        <>
          <TtlMissBadge count={ttl.length} />
          <span className="session-cache-count">x{ttl.length}</span>
        </>
      )}
      {!!compactionCount && (
        <>
          <CompactionBadge count={compactionCount} />
          <span className="session-cache-count">x{compactionCount}</span>
        </>
      )}
    </span>
  );
}

function TurnCacheStatus({ turn }: { turn: SessionDetail["turns"][number] }) {
  const full = turn.calls.filter((call) =>
    call.cacheAssessment?.status === "full-miss" &&
    call.cacheAssessment.cause === undefined
  );
  const partial = turn.calls.filter((call) =>
    call.cacheAssessment?.status === "partial-hit" &&
    call.cacheAssessment.cause === undefined
  );
  const ttl = turn.calls.filter((call) =>
    call.cacheAssessment?.cause === "ttl"
  );
  const compactions = turn.calls.reduce(
    (total, call) =>
      total +
      (call.contextEventsBefore ?? []).filter((event) =>
        event.type === "compaction"
      ).length,
    0,
  );
  const title = [
    full.length > 0
      ? `Full miss calls: ${
        full.map((call) => `#${call.callWithinTurn}`).join(", ")
      }`
      : undefined,
    partial.length > 0
      ? `Partial hit calls: ${
        partial.map((call) => `#${call.callWithinTurn}`).join(", ")
      }`
      : undefined,
    ttl.length > 0
      ? `TTL miss calls: ${
        ttl.map((call) => `#${call.callWithinTurn}`).join(", ")
      }`
      : undefined,
    turn.cacheSummary === undefined
      ? undefined
      : `Call totals: ${cacheSummaryTitle(turn.cacheSummary)}`,
  ].filter(Boolean).join("\n");
  if (
    full.length === 0 && partial.length === 0 && ttl.length === 0 &&
    compactions === 0
  ) {
    return null;
  }
  return (
    <span className="cache-issue-group">
      {full.length > 0 && (
        <CacheAssessmentBadge
          assessment={full[0].cacheAssessment}
          title={title}
        />
      )}
      {partial.length > 0 && (
        <CacheAssessmentBadge
          assessment={partial[0].cacheAssessment}
          title={title}
        />
      )}
      <TtlMissBadge count={ttl.length} />
      <CompactionBadge count={compactions} />
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

function turnDuration(startedAt: number, completedAt: number) {
  const milliseconds = completedAt - startedAt;
  if (milliseconds < 0) return undefined;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
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
  let cacheWrite5m = 0;
  let hasWrite5m = false;
  let cacheWrite1h = 0;
  let hasWrite1h = false;
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
    if (call.tokens.cacheWrite5m !== undefined) {
      cacheWrite5m += call.tokens.cacheWrite5m;
      hasWrite5m = true;
    }
    if (call.tokens.cacheWrite1h !== undefined) {
      cacheWrite1h += call.tokens.cacheWrite1h;
      hasWrite1h = true;
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
    cacheWrite5m: hasWrite5m ? cacheWrite5m : undefined,
    cacheWrite1h: hasWrite1h ? cacheWrite1h : undefined,
    output,
    reasoning,
    processed,
    reportedCost: hasReported ? reportedCost : undefined,
    computedCost: hasComputed && calls.length > 0 ? computedCost : undefined,
    duration: duration(start, end),
  };
}

function sessionTree(session: SessionDetail): SessionDetail[] {
  return [session, ...session.subagents.flatMap(sessionTree)];
}

function aggregateSessionTrees(sessions: SessionDetail[]) {
  const tree = sessions.flatMap(sessionTree);
  const computedCosts = tree.map((session) => session.computedCost);
  const reportedCosts = tree.map((session) => session.reportedCost);
  return {
    userTurns: tree.reduce((total, session) => total + session.userTurns, 0),
    modelCalls: tree.reduce((total, session) => total + session.modelCalls, 0),
    uncachedInput: tree.reduce(
      (total, session) => total + session.tokens.uncachedInput,
      0,
    ),
    cacheRead: tree.reduce(
      (total, session) => total + session.tokens.cacheRead,
      0,
    ),
    cacheWrite: tree.reduce(
      (total, session) => total + (session.tokens.cacheWrite ?? 0),
      0,
    ),
    output: tree.reduce(
      (total, session) =>
        total + session.tokens.output + session.tokens.reasoning,
      0,
    ),
    processed: tree.reduce(
      (total, session) => total + session.tokens.processed,
      0,
    ),
    computedCost: computedCosts.every((cost) => cost !== undefined)
      ? computedCosts.reduce((total, cost) => total + cost!, 0)
      : undefined,
    reportedCost: reportedCosts.every((cost) => cost !== undefined)
      ? reportedCosts.reduce((total, cost) => total + cost!, 0)
      : undefined,
    end: tree.reduce<number | undefined>((latest, session) => {
      const end = sessionSpan(session)?.end;
      if (end === undefined) return latest;
      return latest === undefined ? end : Math.max(latest, end);
    }, undefined),
    start: tree.reduce<number | undefined>((earliest, session) => {
      const start = sessionSpan(session)?.start;
      if (start === undefined) return earliest;
      return earliest === undefined ? start : Math.min(earliest, start);
    }, undefined),
  };
}

function formattedCost(value?: number) {
  return value === undefined ? "unpriced" : dollars.format(value);
}

function formattedTurnCost(value?: number) {
  return value === undefined ? "unpriced" : turnDollars.format(value);
}

function formattedSessionCost(value?: number) {
  return value === undefined ? "-" : sessionDollars.format(value);
}

function SubagentCostBreakdown({
  total,
  subagents,
  format,
}: {
  total?: number;
  subagents?: number;
  format: (value?: number) => string;
}) {
  return (
    <span className="subagent-cost-breakdown">
      <strong className="subagent-cost-total">{format(total)}</strong>
      <small className="subagent-cost-label">subagents</small>
      <small className="subagent-cost-amount">{format(subagents)}</small>
    </span>
  );
}

function SubagentSummary({
  session,
  expanded,
  onToggle,
}: {
  session: SessionDetail;
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = aggregateSessionTrees([session]);
  const nested = aggregateSessionTrees(session.subagents);
  const input = total.uncachedInput + total.cacheRead + total.cacheWrite;
  const reused = input === 0 ? undefined : total.cacheRead / input;
  const elapsed = total.start === undefined || total.end === undefined
    ? undefined
    : duration(total.start, total.end);
  const hasDescendants = session.subagents.length > 0;
  return (
    <div className={`subagent-summary${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="subagent-summary-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="subagent-summary-marker">{expanded ? "▾" : "▸"}</span>
        <span className="subagent-summary-body">
          <span className="subagent-summary-title">
            <strong>Subagent · {session.agent ?? "agent"}</strong>
            <span>{session.title}</span>
          </span>
          <small>
            {total.userTurns} turn{total.userTurns === 1 ? "" : "s"} ·{"  "}
            {hasDescendants
              ? `${session.modelCalls} direct calls · ${session.subagents.length} nested subagent${
                session.subagents.length === 1 ? "" : "s"
              }`
              : `${total.modelCalls} calls`}
            {elapsed ? ` · ${elapsed}` : ""}
          </small>
          <small>
            <TokenValue value={total.processed} /> processed ·{"  "}
            {reused === undefined
              ? "reuse unavailable"
              : `${(reused * 100).toFixed(1)}% reused`}
          </small>
        </span>
        <span className="subagent-summary-cost">
          <CostCell
            reported={total.reportedCost}
            computed={total.computedCost}
            direct={hasDescendants ? session.computedCost : undefined}
            subagents={hasDescendants ? nested.computedCost : undefined}
            turn
          />
        </span>
      </button>
      {expanded && <SessionBreakdown session={session} nested hideHeading />}
    </div>
  );
}

function costsMismatch(reported?: number, computed?: number) {
  if (reported === undefined || reported === 0) return false;
  if (computed === undefined) return false;
  return Math.abs(reported - computed) > COST_EPSILON;
}

function CostCell({
  reported,
  computed,
  direct,
  subagents,
  session = false,
  turn = false,
}: {
  reported?: number;
  computed?: number;
  direct?: number;
  subagents?: number;
  session?: boolean;
  turn?: boolean;
}) {
  const mismatch = costsMismatch(reported, computed);
  const primary = computed === undefined
    ? "-"
    : (session ? sessionDollars : turn ? turnDollars : dollars).format(
      computed,
    );
  const reportedLabel = reported === undefined
    ? "Reported cost: n/a"
    : `Reported cost: ${dollars.format(reported)}`;
  const computedLabel = computed === undefined
    ? "Calculated cost: n/a"
    : `Calculated cost: ${dollars.format(computed)}`;
  const costBreakdown = direct === undefined
    ? computedLabel
    : `Calculated total: ${formattedCost(computed)} · Direct: ${
      formattedCost(direct)
    } · Subagents: ${formattedCost(subagents)}`;
  const title = mismatch
    ? `${costBreakdown} · ${reportedLabel} (mismatch)`
    : `${costBreakdown} · ${reportedLabel}`;

  return (
    <span
      className={`cost-cell${session ? " session-cost" : ""}${
        mismatch ? " cost-mismatch" : ""
      }`}
      title={title}
    >
      {mismatch && (
        <span className="cost-mismatch-icon" aria-label="Cost mismatch">!</span>
      )}
      {subagents !== undefined
        ? (
          <SubagentCostBreakdown
            total={computed}
            subagents={subagents}
            format={session ? formattedSessionCost : formattedTurnCost}
          />
        )
        : session
        ? <strong>{primary}</strong>
        : <span>{primary}</span>}
    </span>
  );
}

function HarnessIcon({ harness }: { harness: SessionSummary["harness"] }) {
  const title = harness === "claude-code"
    ? "Claude Code"
    : harness === "codex"
    ? "Codex"
    : harness === "pi"
    ? "PI"
    : "OpenCode";
  const src = harness === "claude-code"
    ? claudeCodeIcon
    : harness === "codex"
    ? codexIcon
    : harness === "pi"
    ? piIcon
    : openCodeIcon;
  return (
    <span className={`harness-icon harness-${harness}`} title={title}>
      <img src={src} alt={title} />
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

function toolMechanics(call: ModelCall) {
  const counts = new Map<string, number>();
  for (const tool of call.activity.tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${name} ×${count}`).join(" · ");
}

function exceptionalFinishReason(reason?: string) {
  if (!reason) return undefined;
  const normalized = reason.toLowerCase().replaceAll(/[-_]/g, "");
  return ["stop", "endturn", "tooluse", "toolcalls"].includes(normalized)
    ? undefined
    : reason;
}

function toolTargetPreview(value?: string) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      for (
        const key of [
          "description",
          "prompt",
          "task",
          "command",
          "filePath",
          "path",
          "pattern",
          "query",
        ]
      ) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (typeof candidate === "string") return candidate;
      }
    }
  } catch {
    // Non-JSON previews are already displayable.
  }
  return value;
}

function CallInputMetric({ call }: { call: ModelCall }) {
  const anthropic = call.provider.toLowerCase().includes("anthropic");
  const total = contextSize(call.tokens);
  const reused = cacheHitRate(call.tokens);
  const parts = anthropic
    ? [
      call.tokens.cacheRead > 0
        ? `${compact.format(call.tokens.cacheRead)} read`
        : undefined,
      `${compact.format(call.tokens.uncachedInput)} uncached`,
      call.tokens.cacheWrite !== undefined
        ? `${compact.format(call.tokens.cacheWrite)} written`
        : undefined,
    ]
    : [
      call.tokens.cacheRead > 0
        ? `${compact.format(call.tokens.cacheRead)} cached`
        : undefined,
      `${compact.format(call.tokens.uncachedInput)} uncached`,
    ];
  return (
    <span
      className="metric-stack session-input-metric call-input-metric"
      title={`${integer.format(total)} total input tokens`}
    >
      <span>
        <TokenValue value={total} /> total input
      </span>
      <small>{parts.filter(Boolean).join(" · ")}</small>
      {call.tokens.cacheWrite5m !== undefined &&
        call.tokens.cacheWrite1h !== undefined && (
        <small>
          writes: {compact.format(call.tokens.cacheWrite5m)} at 5m ·{"  "}
          {compact.format(call.tokens.cacheWrite1h)} at 1h
        </small>
      )}
      {reused !== undefined && (
        <small>{(reused * 100).toFixed(1)}% reused</small>
      )}
    </span>
  );
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
        <colgroup>
          <col className="call-number-column" />
          <col className="call-started-column" />
          <col className="call-model-column" />
          <col className="call-time-column" />
          <col className="call-outcome-column" />
          <col className="call-context-column" />
          <col className="call-input-column" />
          <col className="call-cache-column" />
          <col className="call-output-column" />
          <col className="call-cost-column" />
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Model</th>
            <th>Time</th>
            <th>Activity</th>
            <th>Context</th>
            <th>Volume</th>
            <th>Cache</th>
            <th>Output</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const expanded = expandedCallID === call.id;
            const callDuration = duration(call.startedAt, call.completedAt);
            const callContext = contextSize(call.tokens);
            const cacheMiss = call.cacheAssessment?.cause === undefined &&
              (call.cacheAssessment?.status === "partial-hit" ||
                call.cacheAssessment?.status === "full-miss");
            const ttlMiss = call.cacheAssessment?.cause === "ttl";
            const compactions = (call.contextEventsBefore ?? []).filter((
              event,
            ) => event.type === "compaction").length;
            const subagents = callSubagents(call, session);
            const subagentTotals = aggregateSessionTrees(subagents);
            const hasSubagents = subagents.length > 0;
            const inclusiveComputedCost = hasSubagents
              ? call.computedCost !== undefined &&
                  subagentTotals.computedCost !== undefined
                ? call.computedCost + subagentTotals.computedCost
                : undefined
              : call.computedCost;
            const inclusiveReportedCost = hasSubagents
              ? call.reportedCost !== undefined &&
                  subagentTotals.reportedCost !== undefined
                ? call.reportedCost + subagentTotals.reportedCost
                : undefined
              : call.reportedCost;
            const mechanics = toolMechanics(call);
            const finishWarning = exceptionalFinishReason(
              call.activity.finishReason,
            );
            const hasDetails = call.activity.tools.length > 0 ||
              subagents.length > 0 || finishWarning !== undefined;
            const previewTool = call.activity.tools.find((tool) =>
              tool.inputPreview !== undefined
            );
            const target = toolTargetPreview(previewTool?.inputPreview);
            const outcome = call.preview ??
              (previewTool && target
                ? `${previewTool.name}: ${target}`
                : activitySummary(call));
            const secondaryMechanics = call.preview || target ? mechanics : "";
            return (
              <Fragment key={call.id}>
                <tr
                  className={`call-row${hasDetails ? " has-details" : ""}${
                    expanded ? " row-open" : ""
                  }`}
                  onClick={hasDetails
                    ? () => setExpandedCallID(expanded ? undefined : call.id)
                    : undefined}
                >
                  <td>{call.callWithinTurn}</td>
                  <td title={fullTimestamp.format(call.startedAt)}>
                    {timeOnly.format(call.startedAt)}
                  </td>
                  <td>
                    {modelDisplayName(call.model)}
                  </td>
                  <td className={callDuration ? undefined : "muted"}>
                    {callDuration ?? "—"}
                  </td>
                  <td className="activity-cell">
                    <button
                      type="button"
                      className="activity-button"
                      aria-expanded={hasDetails ? expanded : undefined}
                      disabled={!hasDetails}
                    >
                      <span className="activity-summary-line">
                        <span title={call.preview}>{outcome}</span>
                        <SubagentBadge count={subagents.length} />
                      </span>
                      {(secondaryMechanics || subagents.length > 0) && (
                        <small>
                          {[
                            secondaryMechanics,
                            subagents.length > 0
                              ? `${subagents.length} subagent${
                                subagents.length === 1 ? "" : "s"
                              }`
                              : undefined,
                          ].filter(Boolean).join(" · ")}
                        </small>
                      )}
                    </button>
                  </td>
                  <td>
                    <ContextMetric
                      value={callContext}
                      title={`${
                        integer.format(callContext)
                      } tokens in this request`}
                    />
                  </td>
                  <td>
                    <CallInputMetric call={call} />
                  </td>
                  <td>
                    {(cacheMiss || ttlMiss || compactions > 0) && (
                      <span className="cache-issue-group">
                        {cacheMiss && (
                          <CacheAssessmentBadge
                            assessment={call.cacheAssessment}
                          />
                        )}
                        <TtlMissBadge count={ttlMiss ? 1 : 0} />
                        <CompactionBadge count={compactions} />
                      </span>
                    )}
                  </td>
                  <td>
                    <TokenValue
                      value={call.tokens.output + call.tokens.reasoning}
                    />
                  </td>
                  <td>
                    <CostCell
                      reported={inclusiveReportedCost}
                      computed={inclusiveComputedCost}
                      direct={hasSubagents ? call.computedCost : undefined}
                      subagents={hasSubagents
                        ? subagentTotals.computedCost
                        : undefined}
                      turn
                    />
                  </td>
                </tr>
                {expanded && (
                  <tr className="activity-detail-row">
                    <td colSpan={10}>
                      <div className="activity-detail">
                        {finishWarning && (
                          <div className="activity-warning">
                            Finished: {finishWarning}
                          </div>
                        )}
                        {call.activity.tools.length > 0 && (
                          <div className="tools-detail">
                            <div className="tool-table-wrap">
                              <table className="tool-table">
                                <thead>
                                  <tr>
                                    <th>Tool</th>
                                    <th>Status</th>
                                    <th>Time</th>
                                    <th>Details</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {call.activity.tools.map((tool, index) => (
                                    <tr key={`${tool.name}-${index}`}>
                                      <td>{tool.name}</td>
                                      <td
                                        className={`tool-status tool-status-${tool.status}`}
                                      >
                                        {tool.status}
                                      </td>
                                      <td>
                                        {duration(
                                          tool.startedAt,
                                          tool.completedAt,
                                        ) ?? "—"}
                                      </td>
                                      <td
                                        className="tool-details"
                                        title={tool.inputPreview}
                                      >
                                        {toolTargetPreview(tool.inputPreview) ??
                                          "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                        {subagents.map((child) => (
                          <SubagentSummary
                            key={child.id}
                            session={child}
                            expanded={expandedSubagentID === child.id}
                            onToggle={() =>
                              setExpandedSubagentID(
                                expandedSubagentID === child.id
                                  ? undefined
                                  : child.id,
                              )}
                          />
                        ))}
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
  hideHeading = false,
}: {
  session: SessionDetail;
  nested?: boolean;
  hideHeading?: boolean;
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
      {nested && !hideHeading && (
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
          <colgroup>
            <col className="turn-column" />
            <col className="started-column" />
            <col className="turn-elapsed-column" />
            <col className="turn-activity-column" />
            <col className="turn-context-column" />
            <col className="turn-input-column" />
            <col className="turn-cache-column" />
            <col className="turn-output-column" />
            <col className="turn-cost-column" />
          </colgroup>
          <thead>
            <tr>
              <th>Turn</th>
              <th>Started</th>
              <th>Elapsed</th>
              <th>Activity</th>
              <th>Context</th>
              <th>Volume</th>
              <th>Cache</th>
              <th>Output</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {session.turns.map((turn) => {
              const metrics = turnMetrics(turn.calls);
              const context = contextRange(turn.calls);
              const open = expandedTurns.has(turn.number);
              const subs = turnSubagents(turn, session);
              const nestedMetrics = aggregateSessionTrees(subs);
              const toolCalls = turn.calls.reduce(
                (total, call) => total + call.activity.tools.length,
                0,
              );
              const directEnd = turn.calls.reduce(
                (latest, call) =>
                  Math.max(latest, call.completedAt ?? call.startedAt),
                turn.startedAt,
              );
              const turnEnd = nestedMetrics.end === undefined
                ? directEnd
                : Math.max(directEnd, nestedMetrics.end);
              const elapsed = turnDuration(turn.startedAt, turnEnd);
              const directInput = metrics.uncachedInput + metrics.cacheRead +
                (metrics.cacheWrite ?? 0);
              const nestedInput = nestedMetrics.uncachedInput +
                nestedMetrics.cacheRead + nestedMetrics.cacheWrite;
              const inclusiveComputedCost =
                metrics.computedCost !== undefined &&
                  nestedMetrics.computedCost !== undefined
                  ? metrics.computedCost + nestedMetrics.computedCost
                  : undefined;
              const inclusiveReportedCost =
                metrics.reportedCost !== undefined &&
                  nestedMetrics.reportedCost !== undefined
                  ? metrics.reportedCost + nestedMetrics.reportedCost
                  : undefined;
              return (
                <Fragment key={turn.number}>
                  <tr
                    className={`turn-row${open ? " row-open" : ""}`}
                    onClick={() => toggleTurn(turn.number)}
                  >
                    <td className="turn-label">
                      <span className="turn-label-line">
                        <button
                          type="button"
                          className="turn-expand"
                          aria-expanded={open}
                          aria-label={`${
                            open ? "Collapse" : "Expand"
                          } turn ${turn.number}`}
                        >
                          {open ? "▾" : "▸"}
                        </button>
                        <span>Turn {turn.number}</span>
                      </span>
                    </td>
                    <td title={fullTimestamp.format(turn.startedAt)}>
                      {timeOnly.format(turn.startedAt)}
                    </td>
                    <td className={elapsed ? undefined : "muted"}>
                      {elapsed ?? "—"}
                    </td>
                    <td>
                      <span className="metric-stack">
                        <span>
                          {turn.calls.length}{" "}
                          {subs.length > 0 ? "direct model" : "model"}{" "}
                          call{turn.calls.length === 1 ? "" : "s"}
                        </span>
                        {(subs.length > 0 || toolCalls > 0) && (
                          <small>
                            {subs.length > 0
                              ? `${subs.length} subagent${
                                subs.length === 1 ? "" : "s"
                              } · ${nestedMetrics.modelCalls} nested calls`
                              : `${toolCalls} tool${
                                toolCalls === 1 ? "" : "s"
                              }`}
                          </small>
                        )}
                      </span>
                    </td>
                    <td>
                      <ContextMetric
                        value={context.latest?.size}
                        secondary={context.first?.size}
                        secondaryLabel="start"
                        title={context.latest && context.first && context.peak
                          ? `First request: ${
                            integer.format(context.first.size)
                          } tokens · Last request: ${
                            integer.format(context.latest.size)
                          } tokens · Peak request: ${
                            integer.format(context.peak.size)
                          } tokens (call #${context.peak.call.callWithinTurn})`
                          : undefined}
                      />
                    </td>
                    <td>
                      {subs.length === 0
                        ? (
                          <SessionInputMetric
                            tokens={{
                              uncachedInput: metrics.uncachedInput,
                              cacheRead: metrics.cacheRead,
                              cacheWrite: metrics.cacheWrite,
                              cacheWrite5m: metrics.cacheWrite5m,
                              cacheWrite1h: metrics.cacheWrite1h,
                            }}
                            anthropic={session.providers.some((provider) =>
                              provider.toLowerCase().includes("anthropic")
                            )}
                            label="total input"
                            showWriteTtl
                          />
                        )
                        : (
                          <span className="metric-stack turn-nested-input">
                            <span>
                              <TokenValue value={directInput} /> direct input
                            </span>
                            <small>
                              <TokenValue value={nestedInput} />{" "}
                              nested processed
                            </small>
                          </span>
                        )}
                    </td>
                    <td>
                      <TurnCacheStatus turn={turn} />
                    </td>
                    <td>
                      <TokenValue
                        value={metrics.output + metrics.reasoning +
                          nestedMetrics.output}
                      />
                    </td>
                    <td>
                      {subs.length === 0
                        ? (
                          <CostCell
                            reported={metrics.reportedCost}
                            computed={metrics.computedCost}
                            turn
                          />
                        )
                        : (
                          <CostCell
                            reported={inclusiveReportedCost}
                            computed={inclusiveComputedCost}
                            direct={metrics.computedCost}
                            subagents={nestedMetrics.computedCost}
                            turn
                          />
                        )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="turn-detail-row">
                      <td colSpan={9}>
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
  const { harness } = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<SessionListResponse>();
  const [expandedIDs, setExpandedIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const harnessRef = useRef(harness);
  harnessRef.current = harness;

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    setLoadMoreError(undefined);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    getSessions(1, harness).then((result) => active && setData(result))
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
  }, [harness]);

  async function loadNextPage() {
    if (
      !data || loadingMoreRef.current ||
      data.pagination.page >= data.pagination.totalPages
    ) return;
    const requestedHarness = harness;
    const nextPage = data.pagination.page + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const result = await getSessions(nextPage, requestedHarness);
      if (harnessRef.current !== requestedHarness) return;
      setData((current) => {
        if (!current) return result;
        const seen = new Set(
          current.items.map((session) => `${session.harness}:${session.id}`),
        );
        return {
          ...result,
          items: [
            ...current.items,
            ...result.items.filter((session) =>
              !seen.has(`${session.harness}:${session.id}`)
            ),
          ],
        };
      });
    } catch (reason) {
      if (harnessRef.current === requestedHarness) {
        setLoadMoreError(
          reason instanceof Error
            ? reason.message
            : "Unable to load more sessions",
        );
      }
    } finally {
      if (harnessRef.current === requestedHarness) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !target || !data || data.pagination.page >= data.pagination.totalPages ||
      typeof IntersectionObserver === "undefined"
    ) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [data?.pagination.page, data?.pagination.totalPages, harness]);

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

      <Overview harness={harness} />

      <div className="homepage-metrics">
        <TtlMissCard harness={harness} />
        <UsageChart harness={harness} />
      </div>

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
                <colgroup>
                  <col className="session-column" />
                  <col className="model-column" />
                  <col className="elapsed-column" />
                  <col className="activity-column" />
                  <col className="context-column" />
                  <col className="input-column" />
                  <col className="cache-column" />
                  <col className="output-column" />
                  <col className="cost-column" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Model</th>
                    <th>Elapsed</th>
                    <th>Activity</th>
                    <th>Context</th>
                    <th>Volume</th>
                    <th title="Full and partial cache misses">Cache</th>
                    <th>Output</th>
                    <th title="Computed cost; ! if reported is non-zero and differs">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((session) => {
                    const expanded = expandedIDs.has(session.id);
                    const detail = details[session.id];
                    const span = sessionSpan(detail ?? session);
                    const tokens = session.inclusiveTokens ?? session.tokens;
                    const hasInclusiveMetrics =
                      session.inclusiveTokens !== undefined;
                    const hasSubagents = (session.subagentCount ?? 0) > 0;
                    const subagentComputedCost = hasSubagents &&
                        session.inclusiveComputedCost !== undefined &&
                        session.computedCost !== undefined
                      ? Math.max(
                        0,
                        session.inclusiveComputedCost - session.computedCost,
                      )
                      : undefined;
                    const anthropic = session.providers.some((provider) =>
                      provider.toLowerCase().includes("anthropic")
                    );
                    return (
                      <Fragment key={session.id}>
                        <tr
                          className={`session-row${
                            expanded ? " row-open" : ""
                          }`}
                          onClick={() => toggleSession(session.id)}
                        >
                          <td className="session-cell">
                            <div className="session-identity">
                              <button
                                type="button"
                                className="session-expand"
                                aria-expanded={expanded}
                                aria-label={`${
                                  expanded ? "Collapse" : "Expand"
                                } ${session.title}`}
                              >
                                {expanded ? "▾" : "▸"}
                              </button>
                              <div className="session-copy">
                                <strong
                                  className="session-title"
                                  title={session.title}
                                >
                                  {session.title}
                                </strong>
                                {session.startedAt !== undefined && (
                                  <small
                                    className="session-started"
                                    title={`Started ${
                                      fullTimestamp.format(session.startedAt)
                                    }`}
                                  >
                                    {sessionStarted.format(session.startedAt)}
                                  </small>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="session-model-harness">
                              <HarnessIcon harness={session.harness} />
                              <ModelSummary models={session.models} />
                            </span>
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
                          <td title="Inclusive of direct and subagent turns and calls">
                            <span className="metric-stack">
                              <span>
                                {session.inclusiveUserTurns ??
                                  session.userTurns} turns
                              </span>
                              <span>
                                {session.inclusiveModelCalls ??
                                  session.modelCalls} calls
                              </span>
                              {(session.subagentCount ?? 0) > 0 && (
                                <small>
                                  {session.subagentCount}{" "}
                                  subagent{session.subagentCount === 1
                                    ? ""
                                    : "s"}
                                </small>
                              )}
                            </span>
                          </td>
                          <td>
                            <ContextMetric
                              value={session.contextLatest}
                              secondary={session.contextPeak}
                              secondaryLabel="peak"
                              title={session.contextLatest !== undefined &&
                                  session.contextPeak !== undefined
                                ? `Latest root request: ${
                                  integer.format(session.contextLatest)
                                } tokens · Peak root request: ${
                                  integer.format(session.contextPeak)
                                } tokens${
                                  session.contextPeakTurn !== undefined &&
                                    session.contextPeakCall !== undefined
                                    ? ` (turn ${session.contextPeakTurn}, call #${session.contextPeakCall})`
                                    : ""
                                }`
                                : undefined}
                            />
                          </td>
                          <td>
                            <SessionInputMetric
                              tokens={tokens}
                              anthropic={anthropic}
                            />
                          </td>
                          <td>
                            <SessionCacheStatus
                              summary={session.cacheSummary}
                              issues={session.cacheIssues}
                              compactionCount={session.compactionCount}
                            />
                          </td>
                          <td>
                            <TokenValue
                              value={tokens.output + tokens.reasoning}
                            />
                          </td>
                          <td>
                            <CostCell
                              reported={hasInclusiveMetrics
                                ? session.inclusiveReportedCost
                                : session.reportedCost}
                              computed={hasInclusiveMetrics
                                ? session.inclusiveComputedCost
                                : session.computedCost}
                              direct={hasSubagents
                                ? session.computedCost
                                : undefined}
                              subagents={subagentComputedCost}
                              session
                            />
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="detail-row">
                            <td colSpan={9}>
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
            <div ref={loadMoreRef} className="session-load-more">
              {loadingMore && <span>Loading more sessions...</span>}
              {loadMoreError && (
                <>
                  <span className="session-load-error">{loadMoreError}</span>
                  <button type="button" onClick={loadNextPage}>
                    Try again
                  </button>
                </>
              )}
              {!loadingMore && !loadMoreError &&
                data.pagination.page < data.pagination.totalPages && (
                <button type="button" onClick={loadNextPage}>Load more</button>
              )}
              {data.pagination.page >= data.pagination.totalPages && (
                <span>
                  Showing all {integer.format(data.items.length)} sessions
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
