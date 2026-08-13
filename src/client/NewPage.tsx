import { lazy, Suspense, useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  ActivityOverviewResponse,
  SessionSummary,
  WorkRhythmOverviewResponse,
} from "../shared/sessionSchemas.ts";
import { getActivityOverview, getHarnesses, getWorkRhythm } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";
import "./NewPage.css";
import { OverviewToolbar } from "./new/OverviewToolbar.tsx";
import { UsageOverview } from "./new/UsageOverview.tsx";
import { SessionShape } from "./new/SessionShape.tsx";
import { CacheOverview } from "./new/CacheOverview.tsx";
import { RecentSessions } from "./new/RecentSessions.tsx";

const route = getRouteApi("/");
const WorkRhythm = lazy(() =>
  import("./new/WorkRhythm.tsx").then(({ WorkRhythm }) => ({
    default: WorkRhythm,
  }))
);
const SpendComposition = lazy(() =>
  import("./new/SpendComposition.tsx").then(({ SpendComposition }) => ({
    default: SpendComposition,
  }))
);
const SessionDiagnostics = lazy(() =>
  import("./new/SessionDiagnostics.tsx").then(({ SessionDiagnostics }) => ({
    default: SessionDiagnostics,
  }))
);

function calendarDate(
  date: string | undefined,
  range: { start: string; end: string },
) {
  return date && date >= range.start && date <= range.end ? date : range.end;
}

export function NewPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [loadedOverview, setLoadedOverview] = useState<{
    range: 30 | 90;
    harness: string;
    data: ActivityOverviewResponse;
  }>();
  const [loadedWorkRhythm, setLoadedWorkRhythm] = useState<{
    range: 30 | 90;
    harness: string;
    data: WorkRhythmOverviewResponse;
  }>();
  const [error, setError] = useState<string>();
  const [workRhythmError, setWorkRhythmError] = useState<string>();
  const [harnesses, setHarnesses] = useState<SessionSummary["harness"][]>([]);
  const data = loadedOverview?.data;
  const workRhythmData = loadedWorkRhythm?.data;

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
    setError(undefined);
    setWorkRhythmError(undefined);
    setLoadedWorkRhythm(undefined);
    getActivityOverview(search.range, search.harness).then((result) => {
      if (!active) return;
      setLoadedOverview({
        range: search.range,
        harness: search.harness,
        data: result,
      });
      setError(undefined);
      return getWorkRhythm(search.range, search.harness).then((workRhythm) => {
        if (!active) return;
        setLoadedWorkRhythm({
          range: search.range,
          harness: search.harness,
          data: workRhythm,
        });
      }).catch((reason) => {
        if (active) {
          setWorkRhythmError(
            reason instanceof Error
              ? reason.message
              : "Unable to load estimated work",
          );
        }
      });
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load overview",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [search.range, search.harness]);

  function update(next: Partial<typeof search>, replace = false) {
    navigate({
      search: { ...search, ...next },
      resetScroll: false,
      replace,
    });
  }

  const selectedDate = workRhythmData
    ? calendarDate(search.date, workRhythmData.workRhythm.range)
    : undefined;

  useEffect(() => {
    if (!selectedDate || search.date === selectedDate) return;
    update({ date: selectedDate }, true);
  }, [search.date, selectedDate]);

  return (
    <main className="new-page">
      <SiteHeader
        active="overview"
        action={
          <OverviewToolbar
            range={search.range}
            harness={search.harness}
            harnesses={harnesses}
            onRangeChange={(range) => update({ range })}
            onHarnessChange={(harness) => update({ harness })}
          />
        }
      />

      <section className="new-overview-panel">
        {error && <div className="new-overview-error">{error}</div>}
        {workRhythmError && (
          <div className="new-overview-error">{workRhythmError}</div>
        )}

        <div className="new-overview-grid">
          <div className="new-overview-left">
            <UsageOverview data={data} />
            <SessionShape range={search.range} harness={search.harness} />
          </div>
          {workRhythmData && (
            <Suspense fallback={null}>
              <WorkRhythm
                data={workRhythmData.workRhythm}
                selectedDate={selectedDate!}
                onSelect={(date) => update({ date })}
              />
            </Suspense>
          )}
        </div>

        {data && (
          <Suspense fallback={null}>
            <SpendComposition data={data.spendComposition} />
          </Suspense>
        )}

        {data && (
          <>
            <div className="new-placeholder-grid">
              <CacheOverview range={search.range} harness={search.harness} />
              {workRhythmData && (
                <Suspense fallback={null}>
                  <SessionDiagnostics
                    data={workRhythmData.sessionDiagnostics}
                  />
                </Suspense>
              )}
            </div>

            <RecentSessions
              harness={search.harness}
              harnesses={harnesses}
              misses={search.misses}
              onHarnessChange={(harness) => update({ harness })}
              onMissesChange={(misses) => update({ misses })}
            />
          </>
        )}
      </section>
    </main>
  );
}
