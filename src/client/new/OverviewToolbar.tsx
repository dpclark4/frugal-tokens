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

type OverviewToolbarProps = {
  range: OverviewRange;
  harness: OverviewHarness;
  harnesses: SessionSummary["harness"][];
  onRangeChange: (range: OverviewRange) => void;
  onHarnessChange: (harness: OverviewHarness) => void;
};

export function OverviewToolbar({
  range,
  harness,
  harnesses,
  onRangeChange,
  onHarnessChange,
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
    </div>
  );
}
