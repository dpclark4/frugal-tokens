import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  ActivityOverviewResponse,
  SessionShapeResponse,
  SessionSummary,
  TtlMissMetrics,
} from "../shared/sessionSchemas.ts";
import { getActivityOverview, getHarnesses } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";
import "./NewPage.css";
import {
  type CopyReportState,
  OverviewToolbar,
  type ScreenshotState,
} from "./new/OverviewToolbar.tsx";
import { UsageOverview } from "./new/UsageOverview.tsx";
import { SessionShape } from "./new/SessionShape.tsx";
import { CacheOverview } from "./new/CacheOverview.tsx";
import { RecentSessions } from "./new/RecentSessions.tsx";
import { copyElementScreenshot } from "./copyScreenshot.ts";
import { buildOverviewReport } from "./overviewReport.ts";

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

async function copyText(value: string) {
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
  const [screenshotState, setScreenshotState] = useState<ScreenshotState>(
    "idle",
  );
  const [copyReportState, setCopyReportState] = useState<CopyReportState>(
    "idle",
  );
  const [loadedSessionShape, setLoadedSessionShape] = useState<{
    range: 30 | 90;
    harness: string;
    data: SessionShapeResponse;
  }>();
  const [loadedCacheMisses, setLoadedCacheMisses] = useState<{
    range: 30 | 90;
    harness: string;
    data: TtlMissMetrics;
  }>();
  const screenshotRef = useRef<HTMLDivElement>(null);
  const data = loadedOverview?.range === search.range &&
      loadedOverview.harness === search.harness
    ? loadedOverview.data
    : undefined;
  const sessionShapeIsCurrent = loadedSessionShape?.range === search.range &&
    loadedSessionShape.harness === search.harness;
  const cacheMissesAreCurrent = loadedCacheMisses?.range === search.range &&
    loadedCacheMisses.harness === search.harness;
  const reportReady = Boolean(
    data && sessionShapeIsCurrent && cacheMissesAreCurrent,
  );

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

  async function copyReport() {
    if (
      !data || !loadedSessionShape || !sessionShapeIsCurrent ||
      !loadedCacheMisses || !cacheMissesAreCurrent
    ) return;
    try {
      await copyText(buildOverviewReport({
        overview: data,
        sessionShape: loadedSessionShape.data,
        cacheMisses: loadedCacheMisses.data,
        harness: search.harness,
      }));
      setCopyReportState("copied");
      globalThis.setTimeout(() => setCopyReportState("idle"), 2_000);
    } catch {
      setCopyReportState("error");
      globalThis.setTimeout(() => setCopyReportState("idle"), 3_000);
    }
  }

  async function copyScreenshot() {
    const element = screenshotRef.current;
    if (!element || screenshotState === "capturing") return;
    setScreenshotState("capturing");
    try {
      await copyElementScreenshot(element);
      setScreenshotState("copied");
      globalThis.setTimeout(() => setScreenshotState("idle"), 2_000);
    } catch {
      setScreenshotState("error");
      globalThis.setTimeout(() => setScreenshotState("idle"), 3_000);
    }
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
            copyReportState={copyReportState}
            copyReportDisabled={!reportReady || Boolean(error)}
            onCopyReport={copyReport}
            screenshotState={screenshotState}
            screenshotDisabled={!data || Boolean(error)}
            onScreenshot={copyScreenshot}
          />
        }
      />

      <div className="new-overview-screenshot" ref={screenshotRef}>
        <section className="new-overview-panel">
          {error && <div className="new-overview-error">{error}</div>}

          <div className="new-overview-grid">
            <div className="new-overview-left">
              <UsageOverview data={data} />
              <SessionShape
                range={search.range}
                harness={search.harness}
                onDataChange={(sessionShape) =>
                  setLoadedSessionShape(
                    sessionShape
                      ? {
                        range: search.range,
                        harness: search.harness,
                        data: sessionShape,
                      }
                      : undefined,
                  )}
              />
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
                <CacheOverview
                  range={search.range}
                  harness={search.harness}
                  onDataChange={(cacheMisses) =>
                    setLoadedCacheMisses(
                      cacheMisses
                        ? {
                          range: search.range,
                          harness: search.harness,
                          data: cacheMisses,
                        }
                        : undefined,
                    )}
                />
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
      </div>
    </main>
  );
}
