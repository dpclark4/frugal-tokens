import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  SessionListResponse,
  SessionMissFilter,
  SessionSummary,
} from "../../shared/sessionSchemas.ts";
import { parseSessionMissFilters } from "../../shared/sessionSchemas.ts";
import { getSessions, syncSessions } from "../api.ts";
import type { OverviewHarness } from "./OverviewToolbar.tsx";
import { RecentSessionsTable } from "./RecentSessionsTable.tsx";
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
  page: number;
  onHarnessChange: (harness: OverviewHarness) => void;
  onMissesChange: (misses?: string) => void;
  onPageChange: (page: number) => void;
  onLoadSettled?: () => void;
};

export function RecentSessions({
  harness,
  harnesses,
  misses,
  page,
  onHarnessChange,
  onMissesChange,
  onPageChange,
  onLoadSettled,
}: RecentSessionsProps) {
  const navigate = route.useNavigate();
  const missFilters = parseSessionMissFilters(misses);
  const missFilterKey = missFilters === undefined
    ? "all"
    : missFilters.length === 0
    ? "none"
    : missFilters.join(",");
  const [data, setData] = useState<SessionListResponse>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const restoredScrollRef = useRef(false);
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

  async function loadPage(page: number, clear = false) {
    const request = ++requestRef.current;
    setError(undefined);
    setLoading(true);
    if (clear) setData(undefined);
    try {
      const result = await getSessions(page, harness, missFilters, 15);
      if (request === requestRef.current) setData(result);
    } catch (reason) {
      if (request === requestRef.current) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load sessions",
        );
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void loadPage(page, true).finally(() => {
      if (active) onLoadSettled?.();
    });
    return () => {
      active = false;
      requestRef.current += 1;
    };
  }, [harness, missFilterKey, page]);

  async function refreshData() {
    setRefreshing(true);
    setError(undefined);
    try {
      await syncSessions();
      await loadPage(page);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to refresh sessions",
      );
    } finally {
      setRefreshing(false);
    }
  }

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
      ref={rootRef}
      data-screenshot-exclude
    >
      <RecentSessionsTable
        data={data}
        loading={loading}
        refreshing={refreshing}
        error={error}
        selectedMissFilters={missFilters}
        harness={harness}
        harnesses={harnesses}
        onRefresh={refreshData}
        onHarnessChange={onHarnessChange}
        onMissFiltersChange={changeMissFilters}
        onOpenSession={openSession}
        onPageChange={(nextPage) => {
          rootRef.current?.scrollIntoView({ block: "start" });
          onPageChange(nextPage);
        }}
      />
    </div>
  );
}
