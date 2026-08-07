import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { ToolCallsResponse } from "../shared/sessionSchemas.ts";
import { getToolCalls } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";

const route = getRouteApi("/tool-calls");
const integer = new Intl.NumberFormat("en-US");
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
function duration(value?: number) {
  if (value === undefined) return "–";
  if (value < 1_000) return `${decimal.format(value)} ms`;
  if (value < 60_000) return `${decimal.format(value / 1_000)} sec`;
  return `${decimal.format(value / 60_000)} min`;
}

export function ToolCallsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<ToolCallsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getToolCalls(search.range, search.harness, search.expanded).then((result) => {
      if (active) setData(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load tool calls",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [search.range, search.harness, search.expanded]);

  function update(next: Partial<typeof search>) {
    navigate({ search: { ...search, ...next } });
  }

  return (
    <main>
      <SiteHeader active="tool-calls" />
      <section className="tool-calls-intro">
        <div>
          <h2>Tool call performance</h2>
        </div>
        <div className="tool-calls-controls">
          <button
            type="button"
            className={`expand-tools-button ${search.expanded ? "active" : ""}`}
            aria-pressed={search.expanded}
            onClick={() => update({ expanded: !search.expanded })}
          >
            Expand tools
          </button>
          <div className="segmented" aria-label="Tool call range">
            {([7, 30, 90] as const).map((range) => (
              <button
                key={range}
                type="button"
                className={search.range === range ? "active" : undefined}
                aria-pressed={search.range === range}
                onClick={() => update({ range })}
              >
                {range}D
              </button>
            ))}
          </div>
          <label>
            <span>Harness</span>
            <select
              value={search.harness}
              onChange={(event) =>
                update({ harness: event.target.value as typeof search.harness })}
            >
              <option value="all">All harnesses</option>
              <option value="claude-code">Claude Code</option>
              <option value="opencode">OpenCode</option>
              <option value="pi">PI</option>
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
            </select>
          </label>
        </div>
      </section>
      {error && <div className="error tool-calls-message">{error}</div>}
      {!data && !error && (
        <div className="tool-calls-message">Loading tool call metrics…</div>
      )}
      {data && (
        <section className="tool-calls-panel">
          {data.tools.length === 0
            ? <div className="tool-calls-message">No tool calls in this range.</div>
            : (
              <div className="tool-calls-table-wrap">
                <table className="tool-calls-table">
                  <colgroup>
                    <col className="tool-column" />
                    <col className="calls-column" />
                    <col className="ratio-column" />
                    {Array.from({ length: 6 }, (_, index) => (
                      <col className="runtime-column" key={index} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Tool</th>
                      <th
                        rowSpan={2}
                        title="Tool calls and distinct model calls containing the tool"
                      >
                        Calls
                      </th>
                      <th rowSpan={2}>
                        Calls /<br />model call
                      </th>
                      <th colSpan={3}>Tool runtime</th>
                      <th colSpan={3}>Associated model runtime</th>
                    </tr>
                    <tr>
                      <th>Median</th>
                      <th>Average</th>
                      <th>P95</th>
                      <th>Median</th>
                      <th>Average</th>
                      <th>P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tools.map((tool) => (
                      <tr key={tool.tool}>
                        <th scope="row">
                          <span className="tool-name" title={tool.tool}>
                            {tool.tool}
                          </span>
                        </th>
                        <td>
                          <span className="call-count-stack">
                            <strong>{integer.format(tool.count)} tool</strong>
                            <small>{integer.format(tool.modelCalls)} model</small>
                          </span>
                        </td>
                        <td>{decimal.format(tool.callsPerModelCall)}</td>
                        <td>{duration(tool.toolRuntime?.median)}</td>
                        <td>{duration(tool.toolRuntime?.average)}</td>
                        <td>{duration(tool.toolRuntime?.p95)}</td>
                        <td>{duration(tool.modelRuntime?.median)}</td>
                        <td>{duration(tool.modelRuntime?.average)}</td>
                        <td>{duration(tool.modelRuntime?.p95)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      )}
    </main>
  );
}
