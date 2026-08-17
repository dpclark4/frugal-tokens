import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  ActivityOverviewResponse,
  SessionShapeResponse,
  SessionSummary,
  TtlMissMetrics,
  WorkRhythmOverviewResponse,
} from "../shared/sessionSchemas.ts";
import { getActivityOverview, getHarnesses, getWorkRhythm } from "./api.ts";
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

function WorkRhythmLoading({ failed = false }: { failed?: boolean }) {
  return (
    <DashboardSectionLoading
      title="Estimated work"
      className="work-rhythm-loading"
      failed={failed}
    />
  );
}

function DashboardSectionLoading({
  title,
  className,
  failed = false,
}: {
  title: string;
  className: string;
  failed?: boolean;
}) {
  return (
    <section
      className={`dashboard-section-loading ${className}${
        failed ? " is-error" : ""
      }`}
      role="status"
      aria-label={failed
        ? `${title} unavailable`
        : `Loading ${title.toLowerCase()}`}
    >
      <header>
        <h2>{title}</h2>
      </header>
      <div className="dashboard-loading-canvas" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
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
  const pendingScrollYRef = useRef<number | undefined>(undefined);
  const data = loadedOverview !== undefined &&
      loadedOverview.range === search.range &&
      loadedOverview.harness === search.harness
    ? loadedOverview.data
    : undefined;
  const workRhythmData = loadedWorkRhythm !== undefined &&
      loadedWorkRhythm.range === search.range &&
      loadedWorkRhythm.harness === search.harness
    ? loadedWorkRhythm.data
    : undefined;
  const sessionShapeIsCurrent = loadedSessionShape !== undefined &&
    loadedSessionShape.range === search.range &&
    loadedSessionShape.harness === search.harness;
  const cacheMissesAreCurrent = loadedCacheMisses !== undefined &&
    loadedCacheMisses.range === search.range &&
    loadedCacheMisses.harness === search.harness;
  const reportReady = Boolean(
    data && workRhythmData && sessionShapeIsCurrent && cacheMissesAreCurrent,
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
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load overview",
        );
      }
    });
    getWorkRhythm(search.range, search.harness).then((workRhythm) => {
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
    return () => {
      active = false;
    };
  }, [search.range, search.harness]);

  function update(next: Partial<typeof search>, replace = false) {
    const overviewWillReload =
      (next.harness !== undefined && next.harness !== search.harness) ||
      (next.range !== undefined && next.range !== search.range);
    if (overviewWillReload && screenshotRef.current) {
      pendingScrollYRef.current = globalThis.scrollY;
      screenshotRef.current.style.minHeight =
        `${screenshotRef.current.offsetHeight}px`;
    }
    navigate({
      search: { ...search, ...next },
      resetScroll: false,
      replace,
    });
  }

  function finishOverviewFilterTransition() {
    const scrollY = pendingScrollYRef.current;
    const overview = screenshotRef.current;
    if (scrollY === undefined || !overview) return;
    pendingScrollYRef.current = undefined;
    requestAnimationFrame(() => {
      overview.style.removeProperty("min-height");
      requestAnimationFrame(() => globalThis.scrollTo(0, scrollY));
    });
  }

  useEffect(() => {
    if (error) finishOverviewFilterTransition();
  }, [error]);

  async function copyReport() {
    if (
      !data || !workRhythmData || !loadedSessionShape ||
      !sessionShapeIsCurrent || !loadedCacheMisses || !cacheMissesAreCurrent
    ) return;
    try {
      const { buildOverviewReport } = await import("./overviewReport.ts");
      await copyText(buildOverviewReport({
        overview: data,
        workRhythmOverview: workRhythmData,
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
      const { copyElementScreenshot } = await import("./copyScreenshot.ts");
      await copyElementScreenshot(element);
      setScreenshotState("copied");
      globalThis.setTimeout(() => setScreenshotState("idle"), 2_000);
    } catch {
      setScreenshotState("error");
      globalThis.setTimeout(() => setScreenshotState("idle"), 3_000);
    }
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
          {workRhythmError && (
            <div className="new-overview-error">{workRhythmError}</div>
          )}

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
            {workRhythmData
              ? (
                <Suspense fallback={<WorkRhythmLoading />}>
                  <WorkRhythm
                    data={workRhythmData.workRhythm}
                    selectedDate={selectedDate!}
                    onSelect={(date) => update({ date })}
                  />
                </Suspense>
              )
              : <WorkRhythmLoading failed={Boolean(workRhythmError)} />}
          </div>

          {data
            ? (
              <Suspense
                fallback={
                  <DashboardSectionLoading
                    title="Spend"
                    className="spend-composition-loading"
                  />
                }
              >
                <SpendComposition data={data.spendComposition} />
              </Suspense>
            )
            : (
              <DashboardSectionLoading
                title="Spend"
                className="spend-composition-loading"
                failed={Boolean(error)}
              />
            )}

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
            {workRhythmData
              ? (
                <Suspense
                  fallback={
                    <DashboardSectionLoading
                      title="Session cost vs. active time"
                      className="new-placeholder-section diagnostics-loading"
                    />
                  }
                >
                  <SessionDiagnostics
                    data={workRhythmData.sessionDiagnostics}
                  />
                </Suspense>
              )
              : (
                <DashboardSectionLoading
                  title="Session cost vs. active time"
                  className="new-placeholder-section diagnostics-loading"
                  failed={Boolean(workRhythmError)}
                />
              )}
          </div>

          <RecentSessions
            harness={search.harness}
            harnesses={harnesses}
            misses={search.misses}
            onHarnessChange={(harness) => update({ harness })}
            onMissesChange={(misses) => update({ misses })}
            onLoadSettled={finishOverviewFilterTransition}
          />
        </section>
      </div>
    </main>
  );
}
