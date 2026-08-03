import "./OverviewToolbar.css";

export type OverviewRange = 30 | 90;
export type OverviewHarness = "all" | "claude-code" | "opencode" | "pi" | "codex";

type OverviewToolbarProps = {
  range: OverviewRange;
  harness: OverviewHarness;
  onRangeChange: (range: OverviewRange) => void;
  onHarnessChange: (harness: OverviewHarness) => void;
};

export function OverviewToolbar({
  range,
  harness,
  onRangeChange,
  onHarnessChange,
}: OverviewToolbarProps) {
  return (
    <div className="new-overview-toolbar">
      <span className="new-toolbar-label">Overview scope</span>
      <div className="new-overview-controls">
        <div className="segmented" aria-label="Overview range">
          {([30, 90] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={range === option ? "active" : undefined}
              aria-pressed={range === option}
              onClick={() => onRangeChange(option)}
            >
              {option}D
            </button>
          ))}
        </div>
        <label className="new-harness-control">
          <span>Harness</span>
          <select
            value={harness}
            onChange={(event) => onHarnessChange(event.target.value as OverviewHarness)}
          >
            <option value="all">All harnesses</option>
            <option value="claude-code">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="pi">PI</option>
            <option value="codex">Codex</option>
          </select>
        </label>
      </div>
    </div>
  );
}
