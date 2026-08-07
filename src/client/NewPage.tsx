import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import { getActivityOverview } from "./api.ts";
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

const route = getRouteApi("/new");

export function NewPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<ActivityOverviewResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    let request = 0;

    function load(clearExisting = false) {
      const currentRequest = ++request;
      if (clearExisting) {
        setData(undefined);
        setError(undefined);
      }
      getActivityOverview(search.range, search.harness).then((result) => {
        if (active && currentRequest === request) {
          setData(result);
          setError(undefined);
        }
      }).catch((reason) => {
        if (active && currentRequest === request) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load overview",
          );
        }
      });
    }

    function refreshVisibleOverview() {
      if (document.visibilityState === "visible") load();
    }

    load(true);
    const refreshInterval = window.setInterval(refreshVisibleOverview, 30_000);
    window.addEventListener("focus", refreshVisibleOverview);
    document.addEventListener("visibilitychange", refreshVisibleOverview);
    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", refreshVisibleOverview);
      document.removeEventListener("visibilitychange", refreshVisibleOverview);
    };
  }, [search.range, search.harness]);

  function update(next: Partial<typeof search>) {
    navigate({ search: { ...search, ...next }, resetScroll: false });
  }

  return (
    <main className="new-page">
      <SiteHeader
        active="new"
        action={
          <OverviewToolbar
            range={search.range}
            harness={search.harness}
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

        <div className="new-placeholder-grid">
          <CacheOverview range={search.range} harness={search.harness} />
          <HarnessOverview range={search.range} harness={search.harness} />
        </div>

        <RecentSessions
          harness={search.harness}
          misses={search.misses}
          onHarnessChange={(harness) => update({ harness })}
          onMissesChange={(misses) => update({ misses })}
        />
      </section>
    </main>
  );
}
