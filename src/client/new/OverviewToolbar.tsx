import { useEffect, useRef, useState } from "react";
import { Check, FileText, Image, Share2 } from "lucide-react";
import type { SessionSummary } from "../../shared/sessionSchemas.ts";
import { HarnessOptions } from "../HarnessOptions.tsx";
import "./OverviewToolbar.css";

export type OverviewRange = 30 | 90;
export type OverviewHarness =
  | "all"
  | "claude-code"
  | "opencode"
  | "pi"
  | "codex"
  | "cursor";
export type ScreenshotState = "idle" | "capturing" | "copied" | "error";
export type CopyReportState = "idle" | "copied" | "error";

function GitHubIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297 24 5.67 18.627.297 12 .297Z" />
    </svg>
  );
}

type OverviewToolbarProps = {
  range: OverviewRange;
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  onRangeChange: (range: OverviewRange) => void;
  onHarnessChange: (harness: OverviewHarness) => void;
  screenshotState: ScreenshotState;
  screenshotDisabled?: boolean;
  onScreenshot: () => void;
  copyReportState: CopyReportState;
  copyReportDisabled?: boolean;
  onCopyReport: () => void;
};

export function OverviewToolbar({
  range,
  harness,
  harnesses,
  onRangeChange,
  onHarnessChange,
  screenshotState,
  screenshotDisabled = false,
  onScreenshot,
  copyReportState,
  copyReportDisabled = false,
  onCopyReport,
}: OverviewToolbarProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const shareCopied = copyReportState === "copied" ||
    screenshotState === "copied";
  const shareError = copyReportState === "error" || screenshotState === "error";

  useEffect(() => {
    if (!shareOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!shareRef.current?.contains(event.target as Node)) {
        setShareOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [shareOpen]);

  return (
    <div className="new-overview-controls">
      <label className="new-range-control">
        <select
          aria-label="Overview range"
          value={range}
          onChange={(event) =>
            onRangeChange(Number(event.target.value) as OverviewRange)}
        >
          <option value={30}>30D</option>
          <option value={90}>90D</option>
        </select>
      </label>
      <label className="new-harness-control">
        <select
          aria-label="Harness"
          value={harness}
          onChange={(event) =>
            onHarnessChange(event.target.value as OverviewHarness)}
        >
          <HarnessOptions harnesses={harnesses} />
        </select>
      </label>
      <div className="overview-share" ref={shareRef}>
        <button
          type="button"
          className={`overview-action-button${shareError ? " error" : ""}`}
          aria-haspopup="menu"
          aria-expanded={shareOpen}
          aria-label={shareCopied
            ? "Overview copied"
            : shareError
            ? "Unable to copy overview"
            : "Share overview"}
          onClick={() => setShareOpen((open) => !open)}
          onDoubleClick={() =>
            globalThis.dispatchEvent(
              new Event("frugal-tokens:toggle-secondary-pages"),
            )}
        >
          {shareCopied
            ? <Check size={16} aria-hidden="true" />
            : <Share2 size={16} aria-hidden="true" />}
        </button>
        {shareOpen && (
          <div className="overview-share-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={copyReportDisabled}
              onClick={() => {
                setShareOpen(false);
                onCopyReport();
              }}
            >
              <FileText size={15} aria-hidden="true" />
              Copy as markdown
            </button>
            <button
              type="button"
              role="menuitem"
              data-screenshot-control
              disabled={screenshotDisabled || screenshotState === "capturing"}
              onClick={() => {
                setShareOpen(false);
                onScreenshot();
              }}
            >
              <Image size={15} aria-hidden="true" />
              Copy as image
            </button>
          </div>
        )}
      </div>
      <a
        className="overview-action-button"
        href="https://github.com/dpclark4/frugal-tokens"
        target="_blank"
        rel="noreferrer"
        aria-label="View Frugal Tokens on GitHub"
      >
        <GitHubIcon />
      </a>
    </div>
  );
}
