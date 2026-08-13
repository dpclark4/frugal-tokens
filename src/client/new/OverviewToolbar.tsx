import { Camera, Check } from "lucide-react";
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

type OverviewToolbarProps = {
  range: OverviewRange;
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  onRangeChange: (range: OverviewRange) => void;
  onHarnessChange: (harness: OverviewHarness) => void;
  screenshotState: ScreenshotState;
  screenshotDisabled?: boolean;
  onScreenshot: () => void;
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
}: OverviewToolbarProps) {
  return (
    <div className="new-overview-controls">
      <div className="segmented" aria-label="Overview range">
        {([30, 90] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={range === option ? "active" : undefined}
            aria-pressed={range === option}
            onClick={() => onRangeChange(option)}
            onDoubleClick={option === 30
              ? () => window.dispatchEvent(
                new Event("frugal-tokens:toggle-secondary-pages"),
              )
              : undefined}
          >
            {option}D
          </button>
        ))}
      </div>
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
      <button
        type="button"
        className={`overview-screenshot-button${
          screenshotState === "error" ? " error" : ""
        }`}
        data-screenshot-control
        disabled={screenshotDisabled || screenshotState === "capturing"}
        onClick={onScreenshot}
        aria-label={screenshotState === "copied"
          ? "Overview screenshot copied"
          : "Copy overview screenshot"}
        title={screenshotState === "copied"
          ? "Overview screenshot copied"
          : screenshotState === "error"
          ? "Unable to copy overview screenshot"
          : "Copy overview screenshot"}
      >
        {screenshotState === "copied"
          ? <Check size={16} aria-hidden="true" />
          : <Camera size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
