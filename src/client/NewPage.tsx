import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import { getActivityOverview } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";
import "./NewPage.css";
import { OverviewToolbar } from "./new/OverviewToolbar.tsx";
import { UsageOverview } from "./new/UsageOverview.tsx";
import { SessionShape } from "./new/SessionShape.tsx";
import { ActivityCalendar } from "./new/ActivityCalendar.tsx";
import { SpendComposition } from "./new/SpendComposition.tsx";

const route = getRouteApi("/new");

export function NewPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<ActivityOverviewResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getActivityOverview(search.range, search.harness).then((result) => {
      if (active) setData(result);
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
      <SiteHeader active="new" />

      <section className="new-overview-panel">
        <OverviewToolbar
          range={search.range}
          harness={search.harness}
          onRangeChange={(range) => update({ range })}
          onHarnessChange={(harness) => update({ harness })}
        />

        {error && <div className="new-overview-error">{error}</div>}

        <div className="new-overview-grid">
          <div className="new-overview-left">
            <UsageOverview data={data} />
            <SessionShape />
          </div>
          <ActivityCalendar data={data} />
        </div>
      </section>

      <SpendComposition />
    </main>
  );
}
