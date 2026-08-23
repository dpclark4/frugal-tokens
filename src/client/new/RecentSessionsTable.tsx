import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Image, RefreshCw } from "lucide-react";
import type {
  SessionListResponse,
  SessionMissFilter,
  SessionSummary,
} from "../../shared/sessionSchemas.ts";
import { displayModelName } from "../../shared/modelNames.ts";
import {
  getTitleGenerationSetting,
  setTitleGenerationSetting,
} from "../api.ts";
import { harnessIcon, harnessName, parseHarnessFilter } from "../harness.ts";
import { HarnessOptions } from "../HarnessOptions.tsx";
import type { OverviewHarness } from "./OverviewToolbar.tsx";
import "./RecentSessionsTable.css";

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
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const missFilterOptions: Array<{
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

type RecentSessionsTableProps = {
  data?: SessionListResponse;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  selectedMissFilters?: SessionMissFilter[];
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  onRefresh: () => Promise<void>;
  onHarnessChange: (harness: OverviewHarness) => void;
  onMissFiltersChange: (filters?: SessionMissFilter[]) => void;
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

function SessionMissFilters({
  selected,
  onChange,
}: {
  selected?: SessionMissFilter[];
  onChange: (filters?: SessionMissFilter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const noFilter = selected === undefined;
  const selectedFilters = selected ?? [];
  const allSelected = selectedFilters.length === missFilterOptions.length;
  const label = noFilter
    ? "No filter"
    : allSelected
    ? "All"
    : selectedFilters.length === 0
    ? "None"
    : `${selectedFilters.length} selected`;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node && !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle(value: SessionMissFilter) {
    if (noFilter || allSelected) {
      onChange([value]);
      return;
    }
    const next = selectedFilters.includes(value)
      ? selectedFilters.filter((filter) => filter !== value)
      : [...selectedFilters, value];
    onChange(next.length ? next : undefined);
  }

  return (
    <div className="recent-sessions-filter" ref={rootRef}>
      <span className="recent-sessions-control-label">Cache misses</span>
      <button
        type="button"
        className="recent-sessions-filter-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="recent-sessions-filter-menu"
          role="dialog"
          aria-label="Session miss filters"
        >
          <label>
            <input
              type="checkbox"
              checked={noFilter}
              onChange={() => onChange(undefined)}
            />
            <span>No filter</span>
          </label>
          <div className="recent-sessions-filter-divider" role="separator" />
          {missFilterOptions.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selectedFilters.includes(option.value)}
                onChange={() => toggle(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
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
    const locations = matches.map((issue) =>
      `${issue.scope ? `${issue.scope}, ` : ""}turn ${issue.turn}`
    );
    return [{ ...group, count: matches.length, locations }];
  });
}

function CacheMissSummary({ session }: { session: SessionSummary }) {
  const tooltipId = useId();
  const misses = session.cacheIssues?.length ?? 0;
  const breakdown = cacheMissBreakdown(session);
  const showBreakdown = breakdown.length > 0 && breakdown.length <= 2;
  if (misses === 0) return null;
  return (
    <span
      className="recent-session-cache-summary"
      tabIndex={0}
      aria-describedby={tooltipId}
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
      <span
        className="tooltip-surface recent-session-cache-tooltip"
        id={tooltipId}
        role="tooltip"
      >
        <span className="recent-session-cache-tooltip-heading">
          <strong>
            {integer.format(misses)} cache {misses === 1 ? "miss" : "misses"}
          </strong>
        </span>
        <span className="recent-session-cache-tooltip-rows">
          {breakdown.map((group) => (
            <span
              className="recent-session-cache-tooltip-row"
              key={group.label}
            >
              <span>
                <span>{group.label}</span>
                <small>
                  {group.locations.slice(0, 3).join(" · ")}
                  {group.locations.length > 3
                    ? ` · +${group.locations.length - 3} more`
                    : ""}
                </small>
              </span>
              <strong>×{integer.format(group.count)}</strong>
            </span>
          ))}
        </span>
      </span>
    </span>
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
  const otherModels = Math.max(0, session.models.length - 1);
  const cost = session.inclusiveComputedCost ?? session.computedCost ??
    session.inclusiveReportedCost ?? session.reportedCost;
  const location = session.workingDirectory;
  const metadata = [
    location,
    sessionActivity.format(activityAt),
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
                {model ? displayModelName(model) : "Unknown"}
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
  harness,
  harnesses,
  onRefresh,
  onHarnessChange,
  onMissFiltersChange,
  onOpenSession,
  onPageChange,
}: RecentSessionsTableProps) {
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

  const page = data?.pagination.page ?? 1;
  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <section className="recent-sessions-panel">
      <header className="recent-sessions-heading">
        <div>
          <h2>Recent sessions</h2>
          {data && (
            <span className="recent-sessions-count">
              {integer.format(data.pagination.totalItems)} sessions
            </span>
          )}
        </div>
        <div className="recent-sessions-controls">
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
          <SessionMissFilters
            selected={selectedMissFilters}
            onChange={onMissFiltersChange}
          />
          <label className="recent-sessions-harness">
            <span className="recent-sessions-control-label">Harness</span>
            <select
              value={harness}
              onChange={(event) => {
                const selected = parseHarnessFilter(event.target.value);
                if (selected !== undefined) onHarnessChange(selected);
              }}
            >
              <HarnessOptions harnesses={harnesses} />
            </select>
          </label>
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
            <table className="recent-sessions-table">
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
                  <th>Session</th>
                  <th>Model</th>
                  <th>Activity</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th className="recent-session-cache-heading">
                    Cache misses
                  </th>
                  <th>Cost</th>
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
