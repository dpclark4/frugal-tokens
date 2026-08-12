import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { Check, Share } from "lucide-react";
import type {
  OverviewResponse,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  TtlMissMetrics,
  UsageResponse,
} from "../shared/sessionSchemas.ts";
import { parseSessionMissFilters } from "../shared/sessionSchemas.ts";
import {
  getHarnesses,
  getOverview,
  getSession,
  getSessions,
  syncSessions,
} from "./api.ts";
import { SessionsPanel } from "./SessionsPanel.tsx";
import { TtlMissCard } from "./TtlMissCard.tsx";
import { UsageChart } from "./UsageChart.tsx";
import { SiteHeader } from "./SiteHeader.tsx";
import { buildHomepageReport, type ReportRange } from "./shareReport.ts";

const route = getRouteApi("/old");

async function copyToClipboard(value: string) {
  if (navigator.clipboard && globalThis.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

type Range = 7 | 30 | 90 | "all";

export function SessionsPage() {
  const { harness, misses } = route.useSearch();
  const navigate = route.useNavigate();
  const missFilters = parseSessionMissFilters(misses);
  const selectedMissFilters = missFilters;
  const missFilterKey = missFilters === undefined
    ? "all"
    : missFilters.length === 0
    ? "none"
    : missFilters.join(",");
  const [data, setData] = useState<SessionListResponse>();
  const [harnesses, setHarnesses] = useState<SessionSummary["harness"][]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [overview, setOverview] = useState<OverviewResponse>();
  const [overviewError, setOverviewError] = useState<string>();
  const [overviewRange, setOverviewRange] = useState<Range>(30);
  const [shareCacheMisses, setShareCacheMisses] = useState<TtlMissMetrics>();
  const [shareUsage, setShareUsage] = useState<UsageResponse>();
  const [shareUsageRange, setShareUsageRange] = useState<ReportRange>(30);
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [expandedIDs, setExpandedIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const harnessRef = useRef(harness);
  const missFilterRef = useRef(missFilterKey);
  harnessRef.current = harness;
  missFilterRef.current = missFilterKey;

  useEffect(() => {
    let active = true;
    getHarnesses().then((result) => {
      if (active) setHarnesses(result);
    }).catch(() => {
      // The all-harness view remains usable if filter discovery fails.
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setOverview(undefined);
    setOverviewError(undefined);
    getOverview(overviewRange, harness).then((result) =>
      active && setOverview(result)
    )
      .catch((reason) => {
        if (active) {
          setOverviewError(
            reason instanceof Error
              ? reason.message
              : "Unable to load overview",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [harness, overviewRange]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setLoadMoreError(undefined);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setExpandedIDs(new Set());
    setDetails({});
    setLoadingSessions(true);
    getSessions(1, harness, missFilters).then((result) => {
      if (!active) return;
      setData(result);
    })
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
      )
      .finally(() => {
        if (active) setLoadingSessions(false);
      });
    return () => {
      active = false;
    };
  }, [harness, missFilterKey]);

  async function loadNextPage() {
    if (
      !data || loadingSessions || loadingMoreRef.current ||
      data.pagination.page >= data.pagination.totalPages
    ) return;
    const requestedHarness = harness;
    const requestedMissFilterKey = missFilterKey;
    const requestedMissFilters = missFilters;
    const nextPage = data.pagination.page + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const result = await getSessions(
        nextPage,
        requestedHarness,
        requestedMissFilters,
      );
      if (
        harnessRef.current !== requestedHarness ||
        missFilterRef.current !== requestedMissFilterKey
      ) return;
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
      if (
        harnessRef.current === requestedHarness &&
        missFilterRef.current === requestedMissFilterKey
      ) {
        setLoadMoreError(
          reason instanceof Error
            ? reason.message
            : "Unable to load more sessions",
        );
      }
    } finally {
      if (
        harnessRef.current === requestedHarness &&
        missFilterRef.current === requestedMissFilterKey
      ) {
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
  }, [
    data?.pagination.page,
    data?.pagination.totalPages,
    harness,
    loadingSessions,
    missFilterKey,
  ]);

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

  async function shareReport() {
    if (!overview || !shareCacheMisses || !shareUsage) return;
    try {
      await copyToClipboard(buildHomepageReport({
        overview,
        cacheMisses: shareCacheMisses,
        usage: shareUsage,
        overviewRange,
        usageRange: shareUsageRange,
        harness,
      }));
      setShareState("copied");
      globalThis.setTimeout(() => setShareState("idle"), 2_000);
    } catch {
      setShareState("error");
      globalThis.setTimeout(() => setShareState("idle"), 3_000);
    }
  }

  async function refreshData() {
    setRefreshing(true);
    setError(undefined);
    try {
      await syncSessions();
      globalThis.location.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to refresh sessions",
      );
      setRefreshing(false);
    }
  }

  return (
    <main>
      <SiteHeader
        active="old"
        action={
          <button
            type="button"
            className={`share-report-button${
              shareState === "error" ? " error" : ""
            }`}
            onClick={shareReport}
            disabled={!overview || !shareCacheMisses || !shareUsage}
            aria-label={shareState === "copied"
              ? "Report copied"
              : "Copy Markdown report"}
            title={shareState === "copied"
              ? "Markdown report copied"
              : shareState === "error"
              ? "Unable to copy report"
              : "Copy Markdown report"}
          >
            {shareState === "copied"
              ? <Check size={16} aria-hidden="true" />
              : <Share size={16} aria-hidden="true" />}
          </button>
        }
      />

      <div className="homepage-metrics">
        <TtlMissCard
          harness={harness}
          overview={overview}
          overviewError={overviewError}
          range={overviewRange}
          onRangeChange={setOverviewRange}
          onMetricsChange={setShareCacheMisses}
        />
        <UsageChart
          harness={harness}
          onDataChange={setShareUsage}
          onRangeChange={setShareUsageRange}
        />
      </div>

      <SessionsPanel
        data={data}
        loadingSessions={loadingSessions}
        refreshing={refreshing}
        refreshData={refreshData}
        selectedMissFilters={selectedMissFilters}
        harness={harness}
        harnesses={harnesses}
        error={error}
        expandedIDs={expandedIDs}
        toggleSession={toggleSession}
        details={details}
        loadMoreRef={loadMoreRef}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        loadNextPage={loadNextPage}
        onMissFiltersChange={(filters) =>
          navigate({
            search: {
              harness,
              misses: filters === undefined
                ? undefined
                : filters.length === 0
                ? "none"
                : filters.join(","),
            },
            resetScroll: false,
          })}
        onHarnessChange={(nextHarness) =>
          navigate({
            search: { harness: nextHarness, misses: misses || undefined },
            resetScroll: false,
          })}
        onOpenSession={(session) =>
          navigate({
            to: "/sessions/$harness/$sessionId",
            params: { harness: session.harness, sessionId: session.id },
            search: {
              misses: misses || undefined,
              paths: "relative",
              color: "time",
              model: "recorded",
              thinking: "recorded",
            },
          })}
      />
    </main>
  );
}
