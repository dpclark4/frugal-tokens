import { lazy, Suspense, useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  ActivityOverviewResponse,
  SessionSummary,
} from "../shared/sessionSchemas.ts";
import { getActivityOverview, getHarnesses } from "./api.ts";
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
  const [error, setError] = useState<string>();
  const [harnesses, setHarnesses] = useState<SessionSummary["harness"][]>([]);
  const data = loadedOverview?.data;

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
    getActivityOverview(search.range, search.harness).then((result) => {
      if (active) {
        setLoadedOverview({
          range: search.range,
          harness: search.harness,
          data: result,
        });
        setError(undefined);
      }
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

  const selectedDate = data
    ? calendarDate(search.date, data.workRhythm.range)
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

        <div className="new-overview-grid">
          <div className="new-overview-left">
            <UsageOverview data={data} />
            <SessionShape range={search.range} harness={search.harness} />
          </div>
          {data && (
            <Suspense fallback={null}>
              <WorkRhythm
                data={data.workRhythm}
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
              <Suspense fallback={null}>
                <SessionDiagnostics data={data.sessionDiagnostics} />
              </Suspense>
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
