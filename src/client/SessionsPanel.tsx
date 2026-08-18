import { Fragment, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Image,
  RefreshCw,
  Split,
} from "lucide-react";
import type {
  CacheAssessment,
  CacheIssue,
  CacheSummary,
  ModelCall,
  SessionDetail,
  SessionListResponse,
  SessionMissFilter,
  SessionSummary,
  TokenUsage,
  TurnInput,
} from "../shared/sessionSchemas.ts";
import { contextRange, contextSize } from "../shared/contextMetrics.ts";
import { displayModelName } from "../shared/modelNames.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import { getTitleGenerationSetting, setTitleGenerationSetting } from "./api.ts";
import { harnessIcon, harnessName } from "./harness.ts";
import { HarnessOptions } from "./HarnessOptions.tsx";
import { costsMismatch, CostWarning } from "./CostWarning.tsx";

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
const sessionStarted = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function TokenValue({ value }: { value: number }) {
  return <span title={integer.format(value)}>{compact.format(value)}</span>;
}

function imageInputLabel(count: number) {
  return `${count} image input${count === 1 ? "" : "s"} included`;
}

function ImageInputIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  const label = imageInputLabel(count);
  return (
    <span
      className="input-image-indicator"
      role="img"
      aria-label={label}
      title={label}
    >
      <Image size={19} strokeWidth={1.75} aria-hidden="true" />
      {count > 1 && <small>{count}</small>}
    </span>
  );
}

function OutputMetric({
  output,
  reasoning,
}: Pick<TokenUsage, "output" | "reasoning">) {
  const title = [
    `${integer.format(output)} visible output tokens`,
    reasoning > 0 ? `${integer.format(reasoning)} reasoning tokens` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <span className="metric-stack output-metric" title={title}>
      <span>
        <TokenValue value={output} />
      </span>
      {reasoning > 0 && (
        <small className="output-reasoning">
          <TokenValue value={reasoning} />
          <span>reasoning</span>
        </small>
      )}
    </span>
  );
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
        {displayModelName(primary)}
      </span>
      {others.length > 0 && (
        <span
          className="model-overflow"
          title={others.map(displayModelName).join(", ")}
          aria-label={`Other models: ${
            others.map(displayModelName).join(", ")
          }`}
          tabIndex={0}
        >
          +{others.length}
        </span>
      )}
    </span>
  );
}

function SessionThinkingSummary(
  { thinking, modelCalls }: Pick<SessionSummary, "thinking" | "modelCalls">,
) {
  const latest = thinking?.latest ?? "unknown";
  const values = thinking?.values ?? [];
  const otherValues = values.filter((value) => value !== latest);
  const classified = thinking?.classifiedCalls ?? 0;
  const title = classified === 0
    ? "No requested thinking setting was exposed by the harness"
    : `Latest: ${latest} · Used: ${
      values.join(" → ")
    } · ${classified} of ${modelCalls} calls classified`;
  return (
    <span className="session-thinking-summary" title={title}>
      <small>Thinking: {latest}</small>
      {otherValues.length > 0 && (
        <span
          className="model-overflow"
          aria-label={`${otherValues.length} other thinking level${
            otherValues.length === 1 ? "" : "s"
          }`}
        >
          +{otherValues.length}
        </span>
      )}
    </span>
  );
}

function ThinkingLevel(
  { setting }: { setting?: ModelCall["reasoningSetting"] },
) {
  if (setting === undefined) return null;
  const source = setting.sourceFieldPath ?? setting.settingName;
  return (
    <small
      className="thinking-level"
      title={`${setting.settingName}=${setting.settingValue} · ${setting.provenance} from ${source}`}
    >
      Thinking: {setting.settingValue}
    </small>
  );
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
      title="Processed input across all direct and subagent model calls"
    >
      <span>
        <TokenValue value={totalInput} /> {label}
      </span>
      <small>
        <TokenValue value={tokens.cacheRead} /> {anthropic ? "read" : "cached"}
        {" "}
        · <TokenValue value={tokens.uncachedInput} /> uncached
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
            writes: <TokenValue value={tokens.cacheWrite5m ?? 0} /> at 5m ·{" "}
            <TokenValue value={tokens.cacheWrite1h ?? 0} /> at 1h
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
  "no-input-context": "Usage record has no input context",
} as const;

function isUnclassifiedMiss(assessment?: CacheAssessment) {
  return (assessment?.status === "partial-hit" ||
    assessment?.status === "full-miss") &&
    assessment.cause === undefined && assessment.reason !== "model-change";
}

function isModelChangeMiss(assessment?: CacheAssessment) {
  return (assessment?.status === "partial-hit" ||
    assessment?.status === "full-miss") &&
    assessment.cause === undefined && assessment.reason === "model-change";
}

function isUnclassifiedIssue(issue: CacheIssue) {
  return issue.cause === undefined && issue.reason !== "model-change";
}

function isModelChangeIssue(issue: CacheIssue) {
  return issue.cause === undefined && issue.reason === "model-change";
}

function ModelChangeBadge({ count = 1 }: { count?: number }) {
  if (count === 0) return null;
  return (
    <span
      className="cache-issue-badge model-change-badge"
      title={`${count} cache miss${
        count === 1 ? "" : "es"
      } after a provider or model change`}
    >
      Model change
    </span>
  );
}

function CacheAssessmentBadge(
  { assessment, title: providedTitle }: {
    assessment?: CacheAssessment;
    title?: string;
  },
) {
  if (!assessment || !isUnclassifiedMiss(assessment)) return null;
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
  return `${summary.hits} hits · ${summary.partialHits} partial hits · ${summary.fullMisses} full misses · ${summary.compactionRelatedMisses} compaction-related misses · ${summary.ttlRelatedMisses} TTL misses · ${summary.thinkingChangeRelatedMisses} thinking-change misses · ${summary.unexpectedMisses} unexpected misses · ${summary.baseline} baseline · ${summary.notComparable} not comparable · ${summary.unknown} unavailable`;
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

function ThinkingChangeBadge({ count = 1 }: { count?: number }) {
  if (count === 0) return null;
  return (
    <span
      className="cache-issue-badge thinking-change-badge"
      title={`${count} cache miss${
        count === 1 ? "" : "es"
      } after a thinking level change`}
    >
      Thinking
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
      issue.status === "full-miss" && isUnclassifiedIssue(issue)
    ) ?? [];
  const partial =
    issues?.filter((issue) =>
      issue.status === "partial-hit" && isUnclassifiedIssue(issue)
    ) ?? [];
  const ttl = issues?.filter((issue) => issue.cause === "ttl") ?? [];
  const thinkingChange =
    issues?.filter((issue) => issue.cause === "thinking-change") ?? [];
  const modelChanges = issues?.filter(isModelChangeIssue) ?? [];
  if (
    !summary ||
    (full.length === 0 && partial.length === 0 && ttl.length === 0 &&
      thinkingChange.length === 0 && modelChanges.length === 0 &&
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
    thinkingChange.length > 0
      ? `Thinking-change miss turns:\n${
        thinkingChange.map(cacheIssueLabel).join("\n")
      }`
      : undefined,
    modelChanges.length > 0
      ? `Model-change miss turns:\n${
        modelChanges.map(cacheIssueLabel).join("\n")
      }`
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
      {thinkingChange.length > 0 && (
        <>
          <ThinkingChangeBadge count={thinkingChange.length} />
          <span className="session-cache-count">x{thinkingChange.length}</span>
        </>
      )}
      {modelChanges.length > 0 && (
        <>
          <ModelChangeBadge count={modelChanges.length} />
          <span className="session-cache-count">x{modelChanges.length}</span>
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

function TurnCacheStatus({
  turn,
  subagents = [],
}: {
  turn: SessionDetail["turns"][number];
  subagents?: SessionDetail[];
}) {
  const calls = [...turn.calls, ...callsFromSessionTrees(subagents)];
  const full = calls.filter((call) =>
    call.cacheAssessment?.status === "full-miss" &&
    isUnclassifiedMiss(call.cacheAssessment)
  );
  const partial = calls.filter((call) =>
    call.cacheAssessment?.status === "partial-hit" &&
    isUnclassifiedMiss(call.cacheAssessment)
  );
  const ttl = calls.filter((call) => call.cacheAssessment?.cause === "ttl");
  const thinkingChange = calls.filter((call) =>
    call.cacheAssessment?.cause === "thinking-change"
  );
  const modelChanges = calls.filter((call) =>
    isModelChangeMiss(call.cacheAssessment)
  );
  const compactions = calls.reduce(
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
    thinkingChange.length > 0
      ? `Thinking-change miss calls: ${
        thinkingChange.map((call) => `#${call.callWithinTurn}`).join(", ")
      }`
      : undefined,
    modelChanges.length > 0
      ? `Model-change miss calls: ${
        modelChanges.map((call) => `#${call.callWithinTurn}`).join(", ")
      }`
      : undefined,
    turn.cacheSummary === undefined
      ? undefined
      : `Call totals: ${cacheSummaryTitle(turn.cacheSummary)}`,
  ].filter(Boolean).join("\n");
  if (
    full.length === 0 && partial.length === 0 && ttl.length === 0 &&
    thinkingChange.length === 0 && modelChanges.length === 0 &&
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
      <ThinkingChangeBadge count={thinkingChange.length} />
      <ModelChangeBadge count={modelChanges.length} />
      <CompactionBadge count={compactions} />
    </span>
  );
}

function duration(startedAt?: number, completedAt?: number) {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const milliseconds = completedAt - startedAt;
  if (milliseconds <= 0) return undefined;
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
  if (milliseconds <= 0) return undefined;
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
      label: turnDuration(session.startedAt, session.endedAt),
    };
  }
  if (!session.turns || session.turns.length === 0) return undefined;
  const starts = session.turns.map((turn) => turn.startedAt);
  const ends = session.turns.flatMap((turn) =>
    turn.calls.map((call) => call.completedAt ?? call.startedAt)
  );
  const start = Math.min(...starts);
  const end = ends.length > 0 ? Math.max(...ends) : session.updatedAt;
  return { start, end, label: turnDuration(start, end) };
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
  const computedCosts: (number | undefined)[] = [];
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
    computedCosts.push(call.computedCost);
    start = start === undefined
      ? call.startedAt
      : Math.min(start, call.startedAt);
    const callEnd = call.completedAt ?? call.startedAt;
    end = end === undefined ? callEnd : Math.max(end, callEnd);
  }

  const computed = rollupCosts(computedCosts);
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
    computedCost: computed.cost,
    duration: duration(start, end),
  };
}

function sessionTree(session: SessionDetail): SessionDetail[] {
  return [session, ...session.subagents.flatMap(sessionTree)];
}

function callsFromSessionTrees(sessions: SessionDetail[]) {
  return sessions.flatMap(sessionTree).flatMap((session) =>
    session.turns.flatMap((turn) => turn.calls)
  );
}

function aggregateSessionTrees(sessions: SessionDetail[]) {
  const tree = sessions.flatMap(sessionTree);
  const computed = rollupCosts(tree.map((session) => session.computedCost));
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
      (total, session) => total + session.tokens.output,
      0,
    ),
    reasoning: tree.reduce(
      (total, session) => total + session.tokens.reasoning,
      0,
    ),
    processed: tree.reduce(
      (total, session) => total + session.tokens.processed,
      0,
    ),
    computedCost: computed.cost,
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
  launcher,
  expanded,
  onToggle,
}: {
  session: SessionDetail;
  launcher?: ModelCall["activity"]["tools"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = aggregateSessionTrees([session]);
  const nested = aggregateSessionTrees(session.subagents);
  const calls = session.turns.flatMap((turn) => turn.calls);
  const cacheCalls = callsFromSessionTrees([session]);
  const fullMisses = cacheCalls.filter((call) =>
    call.cacheAssessment?.status === "full-miss" &&
    isUnclassifiedMiss(call.cacheAssessment)
  );
  const partialMisses = cacheCalls.filter((call) =>
    call.cacheAssessment?.status === "partial-hit" &&
    isUnclassifiedMiss(call.cacheAssessment)
  );
  const ttlMisses = cacheCalls.filter((call) =>
    call.cacheAssessment?.cause === "ttl"
  );
  const thinkingChangeMisses = cacheCalls.filter((call) =>
    call.cacheAssessment?.cause === "thinking-change"
  );
  const modelChanges = cacheCalls.filter((call) =>
    isModelChangeMiss(call.cacheAssessment)
  );
  const compactions = cacheCalls.reduce(
    (total, call) =>
      total +
      (call.contextEventsBefore ?? []).filter((event) =>
        event.type === "compaction"
      ).length,
    0,
  );
  const context = contextRange(calls);
  const elapsed = total.start === undefined || total.end === undefined
    ? undefined
    : turnDuration(total.start, total.end);
  const hasDescendants = session.subagents.length > 0;
  return (
    <div className={`trace-subagent-summary${expanded ? " is-expanded" : ""}`}>
      <table className="data-table call-table subagent-summary-table">
        <colgroup>
          <col className="call-identity-column" />
          <col className="call-model-column" />
          <col className="call-elapsed-column" />
          <col className="call-outcome-column" />
          <col className="call-context-column" />
          <col className="call-input-column" />
          <col className="call-image-column" />
          <col className="call-cache-column" />
          <col className="call-output-column" />
          <col className="call-cost-column" />
        </colgroup>
        <tbody>
          <tr className="subagent-summary-row">
            <td className="subagent-summary-identity">
              <button
                type="button"
                className="subagent-summary-toggle"
                aria-expanded={expanded}
                onClick={onToggle}
              >
                <span className="subagent-summary-marker">
                  {expanded ? "▾" : "▸"}
                </span>
                <span className="subagent-summary-body">
                  <strong>Subagent session</strong>
                  <small>Agent · {session.agent ?? "default"}</small>
                </span>
              </button>
            </td>
            <td className="call-model-cell">
              <span className="model-leading-layout">
                <span className="model-leading-slot" aria-hidden="true" />
                <span className="session-model-details">
                  <ModelSummary models={session.models} />
                  <SessionThinkingSummary
                    thinking={session.thinking}
                    modelCalls={session.modelCalls}
                  />
                </span>
              </span>
            </td>
            <td className={elapsed ? undefined : "muted"}>{elapsed ?? "—"}</td>
            <td className="subagent-summary-activity">
              <span className="metric-stack">
                <span title={session.title}>{session.title}</span>
                <small>
                  {launcher ? `Launched by ${launcher.name} · ` : ""}
                  {total.userTurns} turn{total.userTurns === 1 ? "" : "s"} ·
                  {" "}
                  {hasDescendants
                    ? `${session.modelCalls} direct calls · ${session.subagents.length} nested subagent${
                      session.subagents.length === 1 ? "" : "s"
                    }`
                    : `${total.modelCalls} calls`}
                </small>
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
                  } tokens`
                  : undefined}
              />
            </td>
            <td className="subagent-summary-input">
              <SessionInputMetric
                tokens={{
                  uncachedInput: total.uncachedInput,
                  cacheRead: total.cacheRead,
                  cacheWrite: total.cacheWrite,
                }}
                anthropic={session.providers.some((provider) =>
                  provider.toLowerCase().includes("anthropic")
                )}
                label="total input"
              />
            </td>
            <td aria-hidden="true" />
            <td className="subagent-summary-cache">
              {(fullMisses.length > 0 || partialMisses.length > 0 ||
                ttlMisses.length > 0 || thinkingChangeMisses.length > 0 ||
                modelChanges.length > 0 || compactions > 0) && (
                <span className="cache-issue-group">
                  {fullMisses.length > 0 && (
                    <CacheAssessmentBadge
                      assessment={fullMisses[0].cacheAssessment}
                    />
                  )}
                  {partialMisses.length > 0 && (
                    <CacheAssessmentBadge
                      assessment={partialMisses[0].cacheAssessment}
                    />
                  )}
                  <TtlMissBadge count={ttlMisses.length} />
                  <ThinkingChangeBadge count={thinkingChangeMisses.length} />
                  <ModelChangeBadge count={modelChanges.length} />
                  <CompactionBadge count={compactions} />
                </span>
              )}
            </td>
            <td>
              <OutputMetric output={total.output} reasoning={total.reasoning} />
            </td>
            <td>
              <span className="subagent-summary-cost">
                <CostCell
                  reported={total.reportedCost}
                  computed={total.computedCost}
                  direct={hasDescendants ? session.computedCost : undefined}
                  subagents={hasDescendants ? nested.computedCost : undefined}
                  turn
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      {expanded && <SessionBreakdown session={session} nested />}
    </div>
  );
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
  const usesReportedFallback = computed === undefined && reported !== undefined;
  const primary = usesReportedFallback
    ? turnDollars.format(reported)
    : computed === undefined
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
  const title = usesReportedFallback
    ? `Missing computed cost · ${reportedLabel}`
    : mismatch
    ? `${costBreakdown} · ${reportedLabel} (mismatch)`
    : `${costBreakdown} · ${reportedLabel}`;

  return (
    <span
      className={`cost-cell${session ? " session-cost" : ""}${
        mismatch ? " cost-mismatch" : ""
      }${usesReportedFallback ? " cost-reported-fallback" : ""}`}
      title={mismatch || usesReportedFallback ? undefined : title}
    >
      <CostWarning reported={reported} computed={computed} />
      {subagents !== undefined && !usesReportedFallback
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
  const title = harnessName(harness);
  return (
    <span className={`harness-icon harness-${harness}`} title={title}>
      <img src={harnessIcon(harness)} alt={title} />
    </span>
  );
}

const sessionMissFilterOptions: Array<{
  value: SessionMissFilter;
  label: string;
}> = [
  { value: "compaction", label: "Compaction" },
  { value: "ttl", label: "TTL miss" },
  { value: "thinking-change", label: "Thinking change" },
  { value: "model-change", label: "Model change" },
  { value: "full-miss", label: "Full miss" },
  { value: "partial-miss", label: "Partial miss" },
];

function SessionMissFilterControl({
  selected,
  onChange,
}: {
  selected?: SessionMissFilter[];
  onChange: (filters?: SessionMissFilter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const noFilter = selected === undefined;
  const selectedFilters = selected ?? [];
  const allSelected =
    selectedFilters.length === sessionMissFilterOptions.length;
  const label = noFilter
    ? "No filter"
    : allSelected
    ? "All"
    : selectedFilters.length === 0
    ? "None"
    : `${selectedFilters.length} selected`;

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle(value: SessionMissFilter) {
    if (noFilter || allSelected) {
      onChange([value]);
      return;
    }
    const filters = selectedFilters.includes(value)
      ? selectedFilters.filter((current) => current !== value)
      : [...selectedFilters, value];
    onChange(filters.length === 0 ? undefined : filters);
  }

  return (
    <div className="session-filter-control" ref={menuRef}>
      <span className="session-control-label">Cache misses</span>
      <button
        type="button"
        className="session-filter-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="session-filter-menu"
          role="dialog"
          aria-label="Session miss filters"
        >
          <label className="session-filter-option">
            <input
              type="checkbox"
              checked={noFilter}
              onChange={() => onChange(undefined)}
            />
            <span>No filter</span>
          </label>
          <div className="session-filter-divider" role="separator" />
          {sessionMissFilterOptions.map(({ value, label: optionLabel }) => (
            <label className="session-filter-option" key={value}>
              <input
                type="checkbox"
                checked={selectedFilters.includes(value)}
                onChange={() => toggle(value)}
              />
              <span>{optionLabel}</span>
            </label>
          ))}
        </div>
      )}
    </div>
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
  const normalized = normalizedFinishReason(reason);
  return ["stop", "endturn", "tooluse", "toolcalls"].includes(normalized)
    ? undefined
    : reason;
}

function normalizedFinishReason(reason: string) {
  return reason.toLowerCase().replaceAll(/[-_\s]/g, "");
}

function terminalResponseCall(calls: ModelCall[]) {
  const call = calls.at(-1);
  if (
    !call?.activity.hasText || call.activity.tools.length > 0 ||
    !call.responsePreview
  ) return undefined;
  const reason = call.activity.finishReason;
  if (
    reason !== undefined &&
    !["stop", "endturn"].includes(normalizedFinishReason(reason))
  ) return undefined;
  return call;
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

function TurnInputSummary({ inputs }: { inputs?: TurnInput[] }) {
  const [expanded, setExpanded] = useState(false);
  if (inputs === undefined || inputs.length === 0) return null;
  const textInputs = inputs.filter((input) => input.kind === "text");
  const textPreview = textInputs.map((input) => input.preview).filter(
    (preview): preview is string => preview !== undefined && preview.length > 0,
  ).join("\n");
  const textLength = textInputs.reduce(
    (total, input) =>
      total + (input.originalLength ?? input.preview?.length ?? 0),
    0,
  );
  const imageCount = inputs.filter((input) => input.kind === "image").length;
  const otherCount =
    inputs.filter((input) => input.kind !== "text" && input.kind !== "image")
      .length;
  const truncated = inputs.some((input) => input.truncated);
  const canExpand = textPreview.length > 320 || truncated;
  const previewClassName = [
    "turn-input-preview",
    textPreview ? undefined : "turn-input-placeholder",
    expanded ? "turn-input-preview-expanded" : undefined,
  ].filter(Boolean).join(" ");
  const meta = [
    textInputs.length > 0 ? `${integer.format(textLength)} chars` : undefined,
    imageCount > 0
      ? `${imageCount} image${imageCount === 1 ? "" : "s"}`
      : undefined,
    otherCount > 0
      ? `${otherCount} attachment${otherCount === 1 ? "" : "s"}`
      : undefined,
    truncated ? "preview truncated" : undefined,
  ].filter(Boolean);

  return (
    <div className="turn-input-summary" aria-label="User prompt">
      <div className="turn-input-heading">
        <span className="turn-input-label">User prompt</span>
        {meta.length > 0 && (
          <span className="turn-input-meta">{meta.join(" · ")}</span>
        )}
      </div>
      <div className={previewClassName}>
        {textPreview || "Non-text input"}
      </div>
      {canExpand && (
        <button
          type="button"
          className="turn-input-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function AssistantResponse({ call }: { call: ModelCall }) {
  const [expanded, setExpanded] = useState(false);
  if (!call.responsePreview) return null;
  const canExpand = call.responsePreview.length > 360 || call.responseTruncated;
  const meta = [
    `Produced by Call ${call.callWithinTurn}`,
    call.responseOriginalLength !== undefined
      ? `${integer.format(call.responseOriginalLength)} chars`
      : undefined,
    call.responseTruncated ? "preview truncated" : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <section className="assistant-response" aria-label="Assistant response">
      <div className="assistant-response-heading">
        <span className="assistant-response-label">Assistant response</span>
        <span className="assistant-response-meta">{meta}</span>
      </div>
      <div
        className={`assistant-response-preview${
          expanded ? " assistant-response-preview-expanded" : ""
        }`}
      >
        {call.responsePreview}
      </div>
      {canExpand && (
        <button
          type="button"
          className="assistant-response-toggle"
          aria-expanded={expanded}
          onClick={() =>
            setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </section>
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

function CallTable({
  calls,
  session,
  expandedCallIDs,
  toggleCall,
  responseCallID,
  expandedSubagentIDs,
  toggleSubagent,
  nested = false,
}: {
  calls: ModelCall[];
  session: SessionDetail;
  expandedCallIDs: Set<string>;
  toggleCall: (id: string) => void;
  responseCallID?: string;
  expandedSubagentIDs: Set<string>;
  toggleSubagent: (id: string) => void;
  nested?: boolean;
}) {
  if (calls.length === 0) {
    return <p className="empty-turn">No completed model calls</p>;
  }

  return (
    <div className="call-table-wrap">
      <table className="data-table call-table">
        <colgroup>
          <col className="call-identity-column" />
          <col className="call-model-column" />
          <col className="call-elapsed-column" />
          <col className="call-outcome-column" />
          <col className="call-context-column" />
          <col className="call-input-column" />
          <col className="call-image-column" />
          <col className="call-cache-column" />
          <col className="call-output-column" />
          <col className="call-cost-column" />
        </colgroup>
        <thead>
          <tr>
            <th>{nested ? "Subagent call" : "Model call"}</th>
            <th>Model</th>
            <th>Elapsed</th>
            <th>Activity</th>
            <th>Context</th>
            <th>Volume</th>
            <th aria-label="Image input" />
            <th>Cache</th>
            <th>Output</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const expanded = expandedCallIDs.has(call.id);
            const callDuration = duration(call.startedAt, call.completedAt);
            const callContext = contextSize(call.tokens);
            const subagents = callSubagents(call, session);
            const cacheCalls = [call, ...callsFromSessionTrees(subagents)];
            const fullMisses = cacheCalls.filter((relatedCall) =>
              relatedCall.cacheAssessment?.status === "full-miss" &&
              isUnclassifiedMiss(relatedCall.cacheAssessment)
            );
            const partialMisses = cacheCalls.filter((relatedCall) =>
              relatedCall.cacheAssessment?.status === "partial-hit" &&
              isUnclassifiedMiss(relatedCall.cacheAssessment)
            );
            const ttlMisses = cacheCalls.filter((relatedCall) =>
              relatedCall.cacheAssessment?.cause === "ttl"
            );
            const thinkingChangeMisses = cacheCalls.filter((relatedCall) =>
              relatedCall.cacheAssessment?.cause === "thinking-change"
            );
            const modelChanges = cacheCalls.filter((relatedCall) =>
              isModelChangeMiss(relatedCall.cacheAssessment)
            );
            const compactions = cacheCalls.reduce(
              (total, relatedCall) =>
                total +
                (relatedCall.contextEventsBefore ?? []).filter((event) =>
                  event.type === "compaction"
                ).length,
              0,
            );
            const subagentTotals = aggregateSessionTrees(subagents);
            const hasSubagents = subagents.length > 0;
            const inclusiveComputed = rollupCosts([
              call.computedCost,
              ...(hasSubagents ? [subagentTotals.computedCost] : []),
            ]);
            const inclusiveComputedCost = inclusiveComputed.cost;
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
            const outcome = call.id === responseCallID
              ? "Assistant response"
              : call.preview ??
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
                  onClick={hasDetails ? () => toggleCall(call.id) : undefined}
                >
                  <td
                    className="call-identity"
                    title={fullTimestamp.format(call.startedAt)}
                  >
                    <span className="metric-stack">
                      <span className="call-identity-line">
                        <span
                          className="call-identity-marker"
                          aria-hidden="true"
                        >
                          {hasDetails ? (expanded ? "▾" : "▸") : ""}
                        </span>
                        <strong>
                          {nested ? "Subagent Call" : "Call"}{" "}
                          {call.callWithinTurn}
                        </strong>
                      </span>
                      <small>{sessionStarted.format(call.startedAt)}</small>
                    </span>
                  </td>
                  <td className="call-model-cell">
                    <span className="model-leading-layout">
                      <span className="model-leading-slot" aria-hidden="true" />
                      <span className="model-thinking-stack">
                        <span>{displayModelName(call.model)}</span>
                        <ThinkingLevel setting={call.reasoningSetting} />
                      </span>
                    </span>
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
                  <td className="image-input-cell">
                    <ImageInputIndicator count={call.activity.images ?? 0} />
                  </td>
                  <td className="call-cache-cell">
                    {(fullMisses.length > 0 || partialMisses.length > 0 ||
                      ttlMisses.length > 0 ||
                      thinkingChangeMisses.length > 0 ||
                      modelChanges.length > 0 || compactions > 0) && (
                      <span className="cache-issue-group">
                        {fullMisses.length > 0 && (
                          <CacheAssessmentBadge
                            assessment={fullMisses[0].cacheAssessment}
                          />
                        )}
                        {partialMisses.length > 0 && (
                          <CacheAssessmentBadge
                            assessment={partialMisses[0].cacheAssessment}
                          />
                        )}
                        <TtlMissBadge count={ttlMisses.length} />
                        <ThinkingChangeBadge
                          count={thinkingChangeMisses.length}
                        />
                        <ModelChangeBadge count={modelChanges.length} />
                        <CompactionBadge count={compactions} />
                      </span>
                    )}
                  </td>
                  <td>
                    <OutputMetric
                      output={call.tokens.output}
                      reasoning={call.tokens.reasoning}
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
                                        <span className="tool-details-preview">
                                          {toolTargetPreview(
                                            tool.inputPreview,
                                          ) ??
                                            "—"}
                                        </span>
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
                            launcher={call.activity.tools.find((tool) =>
                              tool.childSessionID === child.id
                            )}
                            expanded={expandedSubagentIDs.has(child.id)}
                            onToggle={() => toggleSubagent(child.id)}
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
}: {
  session: SessionDetail;
  nested?: boolean;
}) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedCallIDs, setExpandedCallIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedSubagentIDs, setExpandedSubagentIDs] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleTurn(number: number) {
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }
  function toggleCall(id: string) {
    setExpandedCallIDs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSubagent(id: string) {
    setExpandedSubagentIDs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className={nested ? "breakdown nested-breakdown" : "breakdown"}>
      <div className="turn-table-wrap">
        <table className="data-table turn-table">
          <colgroup>
            <col className="turn-column" />
            <col className="turn-model-column" />
            <col className="turn-elapsed-column" />
            <col className="turn-activity-column" />
            <col className="turn-context-column" />
            <col className="turn-input-column" />
            <col className="turn-image-column" />
            <col className="turn-cache-column" />
            <col className="turn-output-column" />
            <col className="turn-cost-column" />
          </colgroup>
          <thead>
            <tr>
              <th>{nested ? "Subagent turn" : "Turn"}</th>
              <th>Model</th>
              <th>Elapsed</th>
              <th>Activity</th>
              <th>Context</th>
              <th>Volume</th>
              <th aria-label="Image input" />
              <th>Cache</th>
              <th>Output</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {session.turns.map((turn) => {
              const metrics = turnMetrics(turn.calls);
              const responseCall = terminalResponseCall(turn.calls);
              const context = contextRange(turn.calls);
              const open = expandedTurns.has(turn.number);
              const subs = turnSubagents(turn, session);
              const nestedMetrics = aggregateSessionTrees(subs);
              const toolCalls = turn.calls.reduce(
                (total, call) => total + call.activity.tools.length,
                0,
              );
              const inputImages = turn.calls.reduce(
                (total, call) => total + (call.activity.images ?? 0),
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
              const turnModels = [
                ...new Set(turn.calls.map((call) => call.model)),
              ];
              const directInput = metrics.uncachedInput + metrics.cacheRead +
                (metrics.cacheWrite ?? 0);
              const nestedInput = nestedMetrics.uncachedInput +
                nestedMetrics.cacheRead + nestedMetrics.cacheWrite;
              const inclusiveComputed = rollupCosts([
                metrics.computedCost,
                nestedMetrics.computedCost,
              ]);
              const inclusiveComputedCost = inclusiveComputed.cost;
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
                    <td
                      className="turn-label"
                      title={fullTimestamp.format(turn.startedAt)}
                    >
                      <span className="metric-stack turn-identity">
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
                          <strong>
                            {nested ? "Subagent Turn" : "Turn"} {turn.number}
                          </strong>
                          {turn.branchNumber !== undefined && (
                            <span
                              className="turn-branch-indicator"
                              aria-label={`Branch ${turn.branchNumber}`}
                              title={`Branch ${turn.branchNumber}`}
                            >
                              <Split size={11} aria-hidden="true" />
                              {turn.branchNumber}
                            </span>
                          )}
                        </span>
                        <small>{sessionStarted.format(turn.startedAt)}</small>
                      </span>
                    </td>
                    <td className="turn-model-cell">
                      <span className="model-leading-layout">
                        <span
                          className="model-leading-slot"
                          aria-hidden="true"
                        />
                        <span className="model-thinking-stack">
                          {turnModels.length > 0
                            ? <ModelSummary models={turnModels} />
                            : <span className="muted">—</span>}
                          <ThinkingLevel setting={turn.reasoningSetting} />
                        </span>
                      </span>
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
                    <td className="image-input-cell">
                      <ImageInputIndicator count={inputImages} />
                    </td>
                    <td className="turn-cache-cell">
                      <TurnCacheStatus turn={turn} subagents={subs} />
                    </td>
                    <td>
                      <OutputMetric
                        output={metrics.output + nestedMetrics.output}
                        reasoning={metrics.reasoning + nestedMetrics.reasoning}
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
                      <td colSpan={10}>
                        <div className="turn-detail">
                          <TurnInputSummary inputs={turn.inputs} />
                          <CallTable
                            calls={turn.calls}
                            session={session}
                            expandedCallIDs={expandedCallIDs}
                            toggleCall={toggleCall}
                            responseCallID={responseCall?.id}
                            expandedSubagentIDs={expandedSubagentIDs}
                            toggleSubagent={toggleSubagent}
                            nested={nested}
                          />
                          {responseCall && (
                            <AssistantResponse call={responseCall} />
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
    </div>
  );
}

type SessionsPanelProps = {
  data?: SessionListResponse;
  loadingSessions: boolean;
  refreshing: boolean;
  refreshData: () => Promise<void>;
  selectedMissFilters?: SessionMissFilter[];
  harness: "all" | SessionSummary["harness"];
  harnesses: SessionSummary["harness"][];
  error?: string;
  expandedIDs: Set<string>;
  toggleSession: (id: string) => Promise<void>;
  details: Record<string, SessionDetail>;
  loadMoreRef: { current: HTMLDivElement | null };
  loadingMore: boolean;
  loadMoreError?: string;
  loadNextPage: () => Promise<void>;
  showLoadMoreButton?: boolean;
  onHarnessChange: (harness: "all" | SessionSummary["harness"]) => void;
  onMissFiltersChange: (filters?: SessionMissFilter[]) => void;
  onOpenSession: (session: SessionSummary) => void;
};

export function SessionsPanel({
  data,
  loadingSessions,
  refreshing,
  refreshData,
  selectedMissFilters,
  harness,
  harnesses,
  error,
  expandedIDs,
  toggleSession,
  details,
  loadMoreRef,
  loadingMore,
  loadMoreError,
  loadNextPage,
  showLoadMoreButton = true,
  onHarnessChange,
  onMissFiltersChange,
  onOpenSession,
}: SessionsPanelProps) {
  const [generateTitles, setGenerateTitles] = useState(false);
  const [titleSettingLoading, setTitleSettingLoading] = useState(true);
  const [titleSettingError, setTitleSettingError] = useState<string>();
  const [titleConfirmationOpen, setTitleConfirmationOpen] = useState(false);
  const titleConfirmationButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    getTitleGenerationSetting().then((enabled) => {
      if (active) setGenerateTitles(enabled);
    }).catch((reason) => {
      if (active) {
        setTitleSettingError(
          reason instanceof Error
            ? reason.message
            : "Unable to load title setting",
        );
      }
    }).finally(() => {
      if (active) setTitleSettingLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!titleConfirmationOpen) return;
    titleConfirmationButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setTitleConfirmationOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [titleConfirmationOpen]);

  async function changeTitleGeneration(enabled: boolean) {
    const previous = generateTitles;
    setGenerateTitles(enabled);
    setTitleSettingLoading(true);
    setTitleSettingError(undefined);
    try {
      await setTitleGenerationSetting(enabled);
    } catch (reason) {
      setGenerateTitles(previous);
      setTitleSettingError(
        reason instanceof Error
          ? reason.message
          : "Unable to save title setting",
      );
    } finally {
      setTitleSettingLoading(false);
    }
  }

  return (
    <section className="sessions-panel">
      <div className="panel-heading">
        <div>
          <h2>Recent sessions</h2>
          {data && (
            <span className="session-count">
              {integer.format(data.pagination.totalItems)}
              <span className="session-count-unit">sessions</span>
              {loadingSessions && " · Updating…"}
            </span>
          )}
        </div>
        <div className="session-filters">
          <label className="session-title-generation-control">
            <input
              type="checkbox"
              checked={generateTitles}
              disabled={titleSettingLoading}
              onChange={(event) => {
                if (event.target.checked) {
                  setTitleConfirmationOpen(true);
                } else {
                  void changeTitleGeneration(false);
                }
              }}
            />
            <span>Generate titles</span>
          </label>
          <button
            type="button"
            className="session-refresh"
            onClick={refreshData}
            disabled={refreshing}
            aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
            title="Import changed sessions and reload"
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
          <SessionMissFilterControl
            selected={selectedMissFilters}
            onChange={onMissFiltersChange}
          />
          <label className="session-control session-harness-control">
            <span className="session-control-label">Harness</span>
            <select
              value={harness}
              onChange={(event) =>
                onHarnessChange(event.target.value as typeof harness)}
            >
              <HarnessOptions harnesses={harnesses} />
            </select>
          </label>
        </div>
      </div>
      {titleConfirmationOpen && (
        <div
          className="title-confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setTitleConfirmationOpen(false);
            }
          }}
        >
          <section
            className="title-confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="title-confirmation-heading"
          >
            <h2 id="title-confirmation-heading">Enable title generation?</h2>
            <p>
              Uses Codex with GPT-5.6 Luna (low reasoning) to title up to 25
              recent sessions, then new sessions going forward. Minimal usage
              costs may apply.
            </p>
            <div className="title-confirmation-actions">
              <button
                type="button"
                onClick={() => setTitleConfirmationOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                ref={titleConfirmationButtonRef}
                onClick={() => {
                  setTitleConfirmationOpen(false);
                  void changeTitleGeneration(true);
                }}
              >
                Enable
              </button>
            </div>
          </section>
        </div>
      )}
      {(error || titleSettingError) && (
        <div className="error">{error ?? titleSettingError}</div>
      )}
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
                <col className="session-image-column" />
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
                  <th aria-label="Image input" />
                  <th title="Full and partial cache misses">Cache</th>
                  <th>Output</th>
                  <th title="Computed cost; ! if reported is non-zero and differs">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((session) => {
                  const span = sessionSpan(session);
                  const sessionStart = span?.start ?? session.startedAt;
                  const sessionLocation = session.workingDirectory;
                  const sessionLocationTitle = sessionLocation === undefined
                    ? undefined
                    : `Working directory: ${sessionLocation}`;
                  const tokens = session.inclusiveTokens ?? session.tokens;
                  const imageInputs = session.inclusiveImageInputs ?? 0;
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
                          expandedIDs.has(session.id) ? " row-open" : ""
                        }`}
                        role="link"
                        tabIndex={0}
                        aria-label={`Open session: ${session.title}`}
                        onClick={() => onOpenSession(session)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
                          event.preventDefault();
                          onOpenSession(session);
                        }}
                      >
                        <td className="session-cell">
                          <div className="session-identity">
                            <button
                              type="button"
                              className="session-expand-button"
                              aria-label={`${
                                expandedIDs.has(session.id)
                                  ? "Collapse"
                                  : "Expand"
                              } ${session.title} inline`}
                              aria-expanded={expandedIDs.has(session.id)}
                              aria-controls={`session-detail-${session.id}`}
                              title={`${
                                expandedIDs.has(session.id)
                                  ? "Collapse"
                                  : "Expand"
                              } inline`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleSession(session.id);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {expandedIDs.has(session.id)
                                ? <ChevronDown size={15} />
                                : <ChevronRight size={15} />}
                            </button>
                            <div className="session-copy">
                              <strong
                                className="session-title"
                                title={session.title}
                              >
                                {session.title}
                              </strong>
                              {sessionLocation !== undefined && (
                                <small
                                  className={session.workingDirectory !==
                                      undefined
                                    ? "session-working-directory"
                                    : "session-source-path"}
                                  title={sessionLocationTitle}
                                >
                                  {sessionLocation}
                                </small>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="model-leading-layout">
                            <HarnessIcon harness={session.harness} />
                            <span className="session-model-details">
                              <ModelSummary models={session.models} />
                              <SessionThinkingSummary
                                thinking={session.thinking}
                                modelCalls={session.modelCalls}
                              />
                            </span>
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
                          <span className="metric-stack session-elapsed">
                            <span>{span?.label ?? "—"}</span>
                            {sessionStart !== undefined && (
                              <small
                                className="session-started"
                                title={`Started ${
                                  fullTimestamp.format(sessionStart)
                                }`}
                              >
                                {sessionStarted.format(sessionStart)}
                              </small>
                            )}
                          </span>
                        </td>
                        <td title="Inclusive of direct and subagent turns and calls">
                          <span className="session-activity-layout">
                            <span className="metric-stack">
                              <span>
                                {session.inclusiveUserTurns ??
                                  session.userTurns} turns
                              </span>
                              <span>
                                {session.inclusiveModelCalls ??
                                  session.modelCalls} calls
                                {session.forkCount !== undefined && (
                                  <>· {session.forkCount + 1} branches</>
                                )}
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
                        <td className="image-input-cell">
                          <ImageInputIndicator count={imageInputs} />
                        </td>
                        <td>
                          <SessionCacheStatus
                            summary={session.cacheSummary}
                            issues={session.cacheIssues}
                            compactionCount={session.compactionCount}
                          />
                        </td>
                        <td>
                          <OutputMetric
                            output={tokens.output}
                            reasoning={tokens.reasoning}
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
                      {expandedIDs.has(session.id) && (
                        <tr
                          id={`session-detail-${session.id}`}
                          className="detail-row"
                        >
                          <td colSpan={10}>
                            {details[session.id]
                              ? (
                                <SessionBreakdown
                                  session={details[session.id]}
                                />
                              )
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
            {showLoadMoreButton && !loadingMore && !loadMoreError &&
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
  );
}
