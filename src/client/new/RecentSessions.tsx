import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  SessionDetail,
  SessionListResponse,
  SessionMissFilter,
  SessionSummary,
} from "../../shared/sessionSchemas.ts";
import { parseSessionMissFilters } from "../../shared/sessionSchemas.ts";
import { getSession, getSessions, syncSessions } from "../api.ts";
import { SessionsPanel } from "../SessionsPanel.tsx";
import type { OverviewHarness } from "./OverviewToolbar.tsx";
import {
  overviewReturnScrollKey,
  saveOverviewReturnScroll,
} from "./overviewReturnScroll.ts";
import "./RecentSessions.css";

const route = getRouteApi("/");

type RecentSessionsProps = {
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  misses?: string;
  onHarnessChange: (harness: OverviewHarness) => void;
  onMissesChange: (misses?: string) => void;
};

export function RecentSessions({
  harness,
  harnesses,
  misses,
  onHarnessChange,
  onMissesChange,
}: RecentSessionsProps) {
  const navigate = route.useNavigate();
  const missFilters = parseSessionMissFilters(misses);
  const selectedMissFilters = missFilters;
  const missFilterKey = missFilters === undefined
    ? "all"
    : missFilters.length === 0
    ? "none"
    : missFilters.join(",");
  const [data, setData] = useState<SessionListResponse>();
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [expandedIDs, setExpandedIDs] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const harnessRef = useRef(harness);
  const missFilterRef = useRef(missFilterKey);
  const restoredScrollRef = useRef(false);
  harnessRef.current = harness;
  missFilterRef.current = missFilterKey;
  const [returnScrollY] = useState<number | undefined>(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(overviewReturnScrollKey) ?? "null",
      );
      return saved?.href === globalThis.location.href &&
          Number.isFinite(saved.scrollY)
        ? saved.scrollY
        : undefined;
    } catch {
      return undefined;
    }
  });

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
      if (active) setData(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load sessions",
        );
      }
    }).finally(() => {
      if (active) setLoadingSessions(false);
    });
    return () => {
      active = false;
    };
  }, [harness, missFilterKey]);

  async function refreshData() {
    setRefreshing(true);
    setError(undefined);
    try {
      await syncSessions();
      const result = await getSessions(1, harness, missFilters);
      setData(result);
      setExpandedIDs(new Set());
      setDetails({});
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to refresh sessions",
      );
    } finally {
      setRefreshing(false);
    }
  }

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
    const summary = data?.items.find((session) => session.id === id);
    if (!summary) return;
    try {
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
      const next = await getSessions(
        nextPage,
        requestedHarness,
        requestedMissFilters,
      );
      if (
        harnessRef.current !== requestedHarness ||
        missFilterRef.current !== requestedMissFilterKey
      ) return;
      setData((current) => {
        if (!current) return next;
        const seen = new Set(
          current.items.map((session) => `${session.harness}:${session.id}`),
        );
        return {
          ...next,
          items: [
            ...current.items,
            ...next.items.filter((session) =>
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
        if (entry.isIntersecting) void loadNextPage();
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

  function changeMissFilters(filters?: SessionMissFilter[]) {
    onMissesChange(
      filters === undefined
        ? undefined
        : filters.length === 0
        ? "none"
        : filters.join(","),
    );
  }

  function openSession(session: SessionListResponse["items"][number]) {
    saveOverviewReturnScroll();
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
    });
  }

  useEffect(() => {
    if (!data || returnScrollY === undefined || restoredScrollRef.current) {
      return;
    }
    restoredScrollRef.current = true;
    try {
      sessionStorage.removeItem(overviewReturnScrollKey);
    } catch {
      // The saved position is only a progressive enhancement.
    }
    const restore = () => globalThis.scrollTo(0, returnScrollY);
    const frame = requestAnimationFrame(restore);
    const timer = globalThis.setTimeout(restore, 500);
    return () => {
      cancelAnimationFrame(frame);
      globalThis.clearTimeout(timer);
    };
  }, [data, returnScrollY]);

  return (
    <div
      className="new-recent-sessions"
      data-screenshot-exclude
    >
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
        showLoadMoreButton={false}
        onHarnessChange={onHarnessChange}
        onMissFiltersChange={changeMissFilters}
        onOpenSession={openSession}
      />
    </div>
  );
}
