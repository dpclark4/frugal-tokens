import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  SessionDetail,
  SessionListResponse,
  SessionMissFilter,
} from "../../shared/sessionSchemas.ts";
import {
  parseSessionMissFilters,
  sessionMissFilterValues,
} from "../../shared/sessionSchemas.ts";
import { getSession, getSessions, syncSessions } from "../api.ts";
import { SessionsPanel } from "../SessionsPage.tsx";
import type { OverviewHarness } from "./OverviewToolbar.tsx";
import "./RecentSessions.css";

const route = getRouteApi("/new");

type RecentSessionsProps = {
  harness: OverviewHarness;
  misses?: string;
  onHarnessChange: (harness: OverviewHarness) => void;
  onMissesChange: (misses?: string) => void;
};

export function RecentSessions({
  harness,
  misses,
  onHarnessChange,
  onMissesChange,
}: RecentSessionsProps) {
  const navigate = route.useNavigate();
  const missFilters = parseSessionMissFilters(misses);
  const selectedMissFilters = missFilters ?? [...sessionMissFilterValues];
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

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    setExpandedIDs(new Set());
    setDetails({});
    setLoadingSessions(true);
    getSessions(1, harness, missFilters).then((result) => {
      if (active) setData(result);
    }).catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : "Unable to load sessions");
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
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to refresh sessions");
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
      setError(reason instanceof Error ? reason.message : "Unable to load session");
    }
  }

  async function loadNextPage() {
    if (!data || loadingMore || data.pagination.page >= data.pagination.totalPages) return;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const next = await getSessions(data.pagination.page + 1, harness, missFilters);
      setData((current) => current && ({ ...next, items: [...current.items, ...next.items] }));
    } catch (reason) {
      setLoadMoreError(reason instanceof Error ? reason.message : "Unable to load more sessions");
    } finally {
      setLoadingMore(false);
    }
  }

  function changeMissFilters(filters: SessionMissFilter[]) {
    onMissesChange(
      filters.length === sessionMissFilterValues.length
        ? undefined
        : filters.length === 0
        ? "none"
        : filters.join(","),
    );
  }

  return (
    <div className="new-recent-sessions">
      <SessionsPanel
      data={data}
      loadingSessions={loadingSessions}
      refreshing={refreshing}
      refreshData={refreshData}
      selectedMissFilters={selectedMissFilters}
      harness={harness}
      error={error}
      expandedIDs={expandedIDs}
      toggleSession={toggleSession}
      details={details}
      loadMoreRef={loadMoreRef}
      loadingMore={loadingMore}
      loadMoreError={loadMoreError}
      loadNextPage={loadNextPage}
      onHarnessChange={onHarnessChange}
      onMissFiltersChange={changeMissFilters}
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
    </div>
  );
}
