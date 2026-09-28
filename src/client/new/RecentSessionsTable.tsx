import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Image,
  RefreshCw,
} from "lucide-react";
import type {
  SessionListResponse,
  SessionMissFilter,
  SessionSortDirection,
  SessionSortKey,
  SessionSummary,
} from "../../shared/sessionSchemas.ts";
import { displayModelName } from "../../shared/modelNames.ts";
import { rollupCosts } from "../../shared/costMetrics.ts";
import {
  getTitleGenerationSetting,
  setTitleGenerationSetting,
} from "../api.ts";
import { harnessIcon, harnessName } from "../harness.ts";
import type { OverviewHarness } from "./OverviewToolbar.tsx";
import "./RecentSessionsTable.css";
import { SessionOptions } from "../features/session-browser/SessionOptions.tsx";
import type {
  SessionDirectoryOption,
  SessionModelOption,
} from "../../shared/sessionBrowserSchemas.ts";

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const sessionActivity = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const sessionActivityWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const sessionSortDefaultDirection = {
  timestamp: "desc",
  activity: "desc",
  input: "desc",
  output: "desc",
  cost: "desc",
  cacheMisses: "desc",
} satisfies Record<SessionSortKey, SessionSortDirection>;

type RecentSessionsTableProps = {
  data?: SessionListResponse;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  selectedMissFilters?: SessionMissFilter[];
  selectedModels: string[];
  selectedDirectories: Array<string | null>;
  onDirectoriesChange: (directories: Array<string | null>) => void;
  modelOptions: SessionModelOption[];
  directoryOptions: SessionDirectoryOption[];
  modelOptionsLoading: boolean;
  modelOptionsError?: string;
  onModelsChange: (models: string[]) => void;
  onModelsRetry: () => void;
  onClearFilters: () => void;
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  sortBy?: SessionSortKey;
  sortDirection?: SessionSortDirection;
  onRefresh: () => Promise<void>;
  onHarnessChange: (harness: OverviewHarness) => void;
  onMissFiltersChange: (filters?: SessionMissFilter[]) => void;
  onSortChange: (
    sortBy?: SessionSortKey,
    sortDirection?: SessionSortDirection,
  ) => void;
  onOpenSession: (session: SessionSummary) => void;
  onPageChange: (page: number) => void;
};

function duration(start?: number, end?: number) {
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  const seconds = Math.round((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function HarnessMark({ harness }: { harness: SessionSummary["harness"] }) {
  const label = harnessName(harness);
  return (
    <span className={`recent-session-harness harness-${harness}`} title={label}>
      <img src={harnessIcon(harness)} alt={label} />
    </span>
  );
}

function cacheMissBreakdown(session: SessionSummary) {
  const groups = [
    {
      kind: "full",
      label: "Full miss",
      shortLabel: "Full",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.status === "full-miss" && issue.cause === undefined &&
        issue.reason !== "model-change",
    },
    {
      kind: "partial",
      label: "Partial miss",
      shortLabel: "Partial",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.status === "partial-hit" && issue.cause === undefined &&
        issue.reason !== "model-change",
    },
    {
      kind: "ttl",
      label: "TTL miss",
      shortLabel: "TTL",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.cause === "ttl",
    },
    {
      kind: "thinking",
      label: "Thinking change",
      shortLabel: "Thinking",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.cause === "thinking-change",
    },
    {
      kind: "model",
      label: "Model change",
      shortLabel: "Model",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.cause === undefined && issue.reason === "model-change",
    },
    {
      kind: "compaction",
      label: "Compaction",
      shortLabel: "Compaction",
      test: (issue: NonNullable<SessionSummary["cacheIssues"]>[number]) =>
        issue.cause === "compaction",
    },
  ];
  const issues = session.cacheIssues ?? [];
  return groups.flatMap((group) => {
    const matches = issues.filter(group.test);
    if (matches.length === 0) return [];
    const cost = rollupCosts(matches.map((issue) => issue.estimatedCost));
    return [{
      ...group,
      count: matches.length,
      cost: cost.cost,
      hasUnpricedCost: cost.hasUnpricedCost ||
        matches.some((issue) => issue.hasUnpricedCost),
    }];
  });
}

function CacheMissCost({
  cost,
  hasUnpricedCost,
}: {
  cost?: number;
  hasUnpricedCost: boolean;
}) {
  return (
    <strong className="recent-session-cache-tooltip-cost">
      <span>{hasUnpricedCost && cost !== undefined ? "*" : ""}</span>
      <span>{cost === undefined ? "N/A" : currency.format(cost)}</span>
    </strong>
  );
}

function CacheMissSummary({ session }: { session: SessionSummary }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = tooltip.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const left = Math.max(
        margin,
        Math.min(
          anchor.left + (anchor.width - width) / 2,
          globalThis.innerWidth - width - margin,
        ),
      );
      const fitsBelow = anchor.bottom + gap + height <=
        globalThis.innerHeight - margin;
      const top = fitsBelow ? anchor.bottom + gap : anchor.top - height - gap;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${
        Math.max(
          margin,
          Math.min(top, globalThis.innerHeight - height - margin),
        )
      }px`;
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (tooltipRef.current) observer.observe(tooltipRef.current);
    globalThis.addEventListener("resize", updatePosition);
    globalThis.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener("resize", updatePosition);
      globalThis.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const misses = session.cacheIssues?.length ?? 0;
  const breakdown = cacheMissBreakdown(session);
  const hasUnpricedCost = breakdown.some((group) => group.hasUnpricedCost);
  const totalCost = rollupCosts(breakdown.map((group) => group.cost)).cost;
  const showBreakdown = breakdown.length > 0 && breakdown.length <= 3;
  if (misses === 0) return null;
  return (
    <span
      className="recent-session-cache-summary"
      ref={triggerRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setHovered(false);
          setFocused(false);
        }
      }}
      tabIndex={0}
      aria-describedby={open ? tooltipId : undefined}
    >
      {showBreakdown
        ? (
          <span className="recent-session-cache-breakdown">
            {breakdown.map((group) => (
              <span
                className="recent-session-cache-breakdown-row"
                key={group.kind}
              >
                <span
                  className={`recent-session-cache-label is-${group.kind}`}
                >
                  {group.shortLabel}
                </span>
                <strong>×{integer.format(group.count)}</strong>
              </span>
            ))}
          </span>
        )
        : (
          <strong>
            {integer.format(misses)} {misses === 1 ? "miss" : "misses"}
          </strong>
        )}
      {open && createPortal(
        <span
          ref={tooltipRef}
          className="tooltip-surface recent-session-cache-tooltip"
          id={tooltipId}
          role="tooltip"
        >
          <span className="recent-session-cache-tooltip-heading">
            <strong>
              {integer.format(misses)} cache {misses === 1 ? "miss" : "misses"}
            </strong>
            <span>Est. cost</span>
          </span>
          <span className="recent-session-cache-tooltip-rows">
            {breakdown.map((group) => (
              <span
                className="recent-session-cache-tooltip-row"
                key={group.label}
              >
                <span>{group.label}</span>
                <strong>×{integer.format(group.count)}</strong>
                <CacheMissCost
                  cost={group.cost}
                  hasUnpricedCost={group.hasUnpricedCost}
                />
              </span>
            ))}
            {breakdown.length > 1 && (
              <span className="recent-session-cache-tooltip-row recent-session-cache-tooltip-total">
                <span>Total</span>
                <CacheMissCost
                  cost={totalCost}
                  hasUnpricedCost={hasUnpricedCost}
                />
              </span>
            )}
          </span>
          {hasUnpricedCost && totalCost !== undefined && (
            <span className="recent-session-cache-tooltip-note">
              * Excludes unpriced calls.
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  activeDirection,
  onSortChange,
  className,
}: {
  label: string;
  sortKey: SessionSortKey;
  activeKey?: SessionSortKey;
  activeDirection?: SessionSortDirection;
  onSortChange: (
    sortBy?: SessionSortKey,
    sortDirection?: SessionSortDirection,
  ) => void;
  className?: string;
}) {
  const active = (activeKey ?? "timestamp") === sortKey;
  const direction = active
    ? activeDirection ?? sessionSortDefaultDirection[sortKey]
    : undefined;

  function handleClick() {
    if (!active) {
      onSortChange(sortKey, sessionSortDefaultDirection[sortKey]);
      return;
    }
    onSortChange(sortKey, direction === "asc" ? "desc" : "asc");
  }

  return (
    <th
      className={className}
      aria-sort={direction === "asc"
        ? "ascending"
        : direction === "desc"
        ? "descending"
        : "none"}
    >
      <button
        type="button"
        className="recent-sessions-sort-button"
        onClick={handleClick}
      >
        <span>{label}</span>
        {active
          ? (
            direction === "asc"
              ? <ChevronUp size={12} aria-hidden="true" />
              : <ChevronDown size={12} aria-hidden="true" />
          )
          : (
            <ArrowUpDown
              size={12}
              aria-hidden="true"
              className="recent-sessions-sort-glyph-idle"
            />
          )}
      </button>
    </th>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: () => void;
}) {
  const tokens = session.inclusiveTokens ?? session.tokens;
  const imageInputs = session.inclusiveImageInputs ?? 0;
  const processed = tokens.uncachedInput + tokens.cacheRead +
    (tokens.cacheWrite ?? 0);
  const reused = processed === 0 ? undefined : tokens.cacheRead / processed;
  const turns = session.inclusiveUserTurns ?? session.userTurns;
  const calls = session.inclusiveModelCalls ?? session.modelCalls;
  const activityAt = session.updatedAt;
  const elapsed = duration(session.startedAt, session.endedAt);
  const model = session.models.at(-1);
  const displayModel = session.displayModel ??
    (model ? displayModelName(model) : undefined);
  const otherModels = Math.max(0, session.models.length - 1);
  const cost = session.inclusiveComputedCost ?? session.computedCost ??
    session.inclusiveReportedCost ?? session.reportedCost;
  const location = session.workingDirectory;
  const metadata = [
    location,
    (new Date(activityAt).getFullYear() === new Date().getFullYear()
      ? sessionActivity
      : sessionActivityWithYear).format(activityAt),
    elapsed,
  ].filter(Boolean).join(" · ");

  return (
    <tr
      className="recent-session-row"
      role="link"
      tabIndex={0}
      aria-label={`Open session: ${session.title}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <td className="recent-session-name-cell">
        <strong title={session.title}>{session.title}</strong>
        <small title={metadata}>{metadata}</small>
      </td>
      <td className="recent-session-model-cell">
        <div className="recent-session-model-layout">
          <HarnessMark harness={session.harness} />
          <span className="recent-session-model-copy">
            <span className="recent-session-model-name">
              <strong title={model}>
                {displayModel ?? "Unknown"}
              </strong>
              {otherModels > 0 && (
                <small title={session.models.join(", ")}>+{otherModels}</small>
              )}
            </span>
            <small>Thinking: {session.thinking?.latest ?? "unknown"}</small>
          </span>
        </div>
      </td>
      <td className="recent-session-activity-cell">
        <strong>{integer.format(turns)} turns</strong>
        <small>{integer.format(calls)} calls</small>
      </td>
      <td className="recent-session-usage-cell">
        <div className="recent-session-usage-layout">
          <span
            className={`recent-session-image-slot${
              imageInputs > 0 ? " has-images" : ""
            }`}
            title={imageInputs > 0
              ? `${integer.format(imageInputs)} image input${
                imageInputs === 1 ? "" : "s"
              } included`
              : undefined}
            aria-label={imageInputs > 0
              ? `${integer.format(imageInputs)} image input${
                imageInputs === 1 ? "" : "s"
              } included`
              : undefined}
            aria-hidden={imageInputs === 0 ? "true" : undefined}
          >
            {imageInputs > 0 && (
              <>
                <Image size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{integer.format(imageInputs)}</span>
              </>
            )}
          </span>
          <span className="recent-session-usage-copy">
            <strong
              title={`${integer.format(processed)} processed input tokens`}
            >
              {compact.format(processed)} processed
            </strong>
            <small>
              {compact.format(tokens.uncachedInput)} uncached
              {reused === undefined
                ? ""
                : ` · ${(reused * 100).toFixed(1)}% reused`}
            </small>
          </span>
        </div>
      </td>
      <td className="recent-session-output-cell">
        <strong title={`${integer.format(tokens.output)} output tokens`}>
          {compact.format(tokens.output)} output
        </strong>
        {tokens.reasoning > 0 && (
          <small>{compact.format(tokens.reasoning)} reasoning</small>
        )}
      </td>
      <td className="recent-session-cache-cell">
        <CacheMissSummary session={session} />
      </td>
      <td className="recent-session-cost-cell">
        <strong>{cost === undefined ? "—" : currency.format(cost)}</strong>
      </td>
    </tr>
  );
}

export function RecentSessionsTable({
  data,
  loading,
  refreshing,
  error,
  selectedMissFilters,
  selectedModels,
  selectedDirectories,
  onDirectoriesChange,
  modelOptions,
  directoryOptions,
  modelOptionsLoading,
  modelOptionsError,
  onModelsChange,
  onModelsRetry,
  onClearFilters,
  harness,
  harnesses,
  sortBy,
  sortDirection,
  onRefresh,
  onHarnessChange,
  onMissFiltersChange,
  onSortChange,
  onOpenSession,
  onPageChange,
}: RecentSessionsTableProps) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [generateTitles, setGenerateTitles] = useState(false);
  const [titleSettingLoading, setTitleSettingLoading] = useState(true);
  const [titleSettingError, setTitleSettingError] = useState<string>();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

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
    if (!confirmationOpen) return;
    confirmRef.current?.focus();
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmationOpen(false);
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [confirmationOpen]);

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

  const activeFilterCount = selectedModels.length + selectedDirectories.length +
    (harness === "all" ? 0 : 1) +
    (selectedMissFilters === undefined
      ? 0
      : Math.max(1, selectedMissFilters.length));
  const filterSummary = activeFilterCount > 0
    ? `${activeFilterCount} ${
      activeFilterCount === 1 ? "filter" : "filters"
    } applied`
    : undefined;
  const page = data?.pagination.page ?? 1;
  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <section className="recent-sessions-panel">
      <header className="recent-sessions-heading">
        <div>
          <h2>Recent sessions</h2>
          <div className="recent-sessions-count session-filter-summary">
            {data && (
              <span>{integer.format(data.pagination.totalItems)} sessions</span>
            )}
            {filterSummary && (
              <>
                {data && <span aria-hidden="true">·</span>}
                <span>{filterSummary}</span>
                <button
                  type="button"
                  className="session-filter-clear"
                  onClick={onClearFilters}
                >
                  Clear all
                </button>
              </>
            )}
          </div>
        </div>
        <div className="recent-sessions-controls">
          <button
            type="button"
            className="recent-sessions-refresh"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
            title="Import changed sessions and reload"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <SessionOptions
            open={optionsOpen}
            setOpen={setOptionsOpen}
            models={selectedModels}
            directories={selectedDirectories}
            onDirectoriesChange={onDirectoriesChange}
            harness={harness}
            harnesses={harnesses}
            misses={selectedMissFilters}
            options={modelOptions}
            directoryOptions={directoryOptions}
            loading={modelOptionsLoading}
            error={modelOptionsError}
            onModelsChange={onModelsChange}
            onHarnessChange={onHarnessChange}
            onMissesChange={onMissFiltersChange}
            onRetry={onModelsRetry}
            onClearFilters={onClearFilters}
          >
            <label className="recent-sessions-title-setting">
              <input
                type="checkbox"
                checked={generateTitles}
                disabled={titleSettingLoading}
                onChange={(event) => {
                  if (event.target.checked) setConfirmationOpen(true);
                  else void changeTitleGeneration(false);
                }}
              />
              <span>Generate titles</span>
            </label>
          </SessionOptions>
        </div>
      </header>

      {(error || titleSettingError) && (
        <div className="recent-sessions-error">
          {error ?? titleSettingError}
        </div>
      )}
      {!data && !error && (
        <div className="recent-sessions-loading">Reading local sessions…</div>
      )}
      {data && (
        <>
          <div
            className={`recent-sessions-table-wrap${
              loading ? " is-loading" : ""
            }`}
          >
            <table className="recent-sessions-table" aria-busy={loading}>
              <colgroup>
                <col className="recent-session-name-column" />
                <col className="recent-session-model-column" />
                <col className="recent-session-activity-column" />
                <col className="recent-session-usage-column" />
                <col className="recent-session-output-column" />
                <col className="recent-session-cache-column" />
                <col className="recent-session-cost-column" />
              </colgroup>
              <thead>
                <tr>
                  <SortableHeader
                    label="Session"
                    sortKey="timestamp"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                  />
                  <th scope="col">Model</th>
                  <SortableHeader
                    label="Activity"
                    sortKey="activity"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                  />
                  <SortableHeader
                    label="Input"
                    sortKey="input"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                  />
                  <SortableHeader
                    label="Output"
                    sortKey="output"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                  />
                  <SortableHeader
                    label="Cache misses"
                    sortKey="cacheMisses"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                    className="recent-session-cache-heading"
                  />
                  <SortableHeader
                    label="Cost"
                    sortKey="cost"
                    activeKey={sortBy}
                    activeDirection={sortDirection}
                    onSortChange={onSortChange}
                  />
                </tr>
              </thead>
              <tbody>
                {data.items.map((session) => (
                  <SessionRow
                    key={`${session.harness}:${session.id}`}
                    session={session}
                    onOpen={() => onOpenSession(session)}
                  />
                ))}
              </tbody>
            </table>
            {!loading && !error && data.items.length === 0 && (
              <div className="recent-sessions-empty" role="status">
                {data.pagination.totalItems > 0
                  ? "No sessions on this page"
                  : activeFilterCount > 0
                  ? "No sessions match these filters"
                  : "No sessions yet"}
              </div>
            )}
          </div>
          {totalPages > 1 && (
            <nav
              className="recent-sessions-pagination"
              aria-label="Session pages"
            >
              <button
                type="button"
                disabled={loading || page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                Previous
              </button>
              <span>
                Page {integer.format(page)} of {integer.format(totalPages)}
              </span>
              <button
                type="button"
                disabled={loading || page >= totalPages}
                onClick={() => onPageChange(page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}

      {confirmationOpen && (
        <div
          className="recent-sessions-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmationOpen(false);
            }
          }}
        >
          <section
            className="recent-sessions-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recent-sessions-dialog-title"
          >
            <h2 id="recent-sessions-dialog-title">Enable title generation?</h2>
            <p>
              Uses Codex with GPT-5.6 Luna (low reasoning) to title up to 25
              recent sessions, then new sessions going forward. Minimal usage
              costs may apply.
            </p>
            <div>
              <button type="button" onClick={() => setConfirmationOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                ref={confirmRef}
                onClick={() => {
                  setConfirmationOpen(false);
                  void changeTitleGeneration(true);
                }}
              >
                Enable
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
