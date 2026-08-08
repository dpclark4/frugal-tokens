import { useEffect, useState } from "react";
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
import { WorkRhythm } from "./new/WorkRhythm.tsx";
import { SpendComposition } from "./new/SpendComposition.tsx";
import { CacheOverview } from "./new/CacheOverview.tsx";
import { HarnessOverview } from "./new/HarnessOverview.tsx";
import { RecentSessions } from "./new/RecentSessions.tsx";

const route = getRouteApi("/");

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

  function update(next: Partial<typeof search>) {
    navigate({ search: { ...search, ...next }, resetScroll: false });
  }

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
          {data && <WorkRhythm data={data.workRhythm} />}
        </div>

        {data && <SpendComposition data={data.spendComposition} />}

        {data && (
          <>
            <div className="new-placeholder-grid">
              <CacheOverview range={search.range} harness={search.harness} />
              <HarnessOverview range={search.range} harness={search.harness} />
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
