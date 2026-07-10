import { Fragment, useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type {
  SessionDetail,
  SessionListResponse,
} from "../shared/sessionSchemas.ts";
import { getSession, getSessions } from "./api.ts";

const route = getRouteApi("/");
const integer = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function TokenValue({ value }: { value: number }) {
  return <span title={integer.format(value)}>{compact.format(value)}</span>;
}

function duration(startedAt?: number, completedAt?: number) {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const milliseconds = completedAt - startedAt;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${
    Math.round((milliseconds % 60_000) / 1_000)
  }s`;
}

function activitySummary(
  call: SessionDetail["turns"][number]["calls"][number],
) {
  const names = [...new Set(call.activity.tools.map((tool) => tool.name))];
  if (call.activity.tools.length > 0) {
    return `${call.activity.tools.length} ${
      call.activity.tools.length === 1 ? "tool" : "tools"
    } | ${names.join(", ")}`;
  }
  if (call.activity.finishReason === "stop") return "Final response";
  if (call.activity.hasText) return "Text response";
  if (call.activity.hasReasoning) return "Reasoning";
  return call.activity.finishReason ?? "Model call";
}

function SessionBreakdown({ session }: { session: SessionDetail }) {
  const [expandedCallID, setExpandedCallID] = useState<string>();
  return (
    <div className="breakdown">
      <div className="definition-note">
        <strong>Fresh prompt</strong>{" "}
        is uncached input plus reported cache writes.{" "}
        <strong>Processed tokens</strong>{" "}
        include fresh prompt, cache reads, output, and reasoning. A dash means
        no cache write was reported.
      </div>
      {session.turns.map((turn) => (
        <section className="turn" key={turn.number}>
          <header>
            <span>Turn {turn.number}</span>
            <span>
              {fullTimestamp.format(turn.startedAt)} | {turn.calls.length}{" "}
              {turn.calls.length === 1 ? "call" : "calls"}
            </span>
          </header>
          {turn.calls.length === 0
            ? <p className="empty-turn">No completed model calls</p>
            : (
              <div className="call-table-wrap">
                <table className="call-table">
                  <thead>
                    <tr>
                      <th>Call</th>
                      <th>Started</th>
                      <th>Activity</th>
                      <th>Model</th>
                      <th>Fresh prompt</th>
                      <th>Cache read</th>
                      <th>Reported write</th>
                      <th>Output</th>
                      <th>Reasoning</th>
                      <th>Processed</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {turn.calls.map((call) => {
                      const expanded = expandedCallID === call.id;
                      return (
                        <Fragment key={call.id}>
                          <tr>
                            <td>{call.callWithinTurn}</td>
                            <td title={fullTimestamp.format(call.startedAt)}>
                              {timeOnly.format(call.startedAt)}
                            </td>
                            <td className="activity-cell">
                              <button
                                type="button"
                                className="activity-button"
                                aria-expanded={expanded}
                                onClick={() =>
                                  setExpandedCallID(
                                    expanded ? undefined : call.id,
                                  )}
                              >
                                <span>{activitySummary(call)}</span>
                                <small>
                                  {expanded ? "Hide details" : "Show details"}
                                </small>
                              </button>
                            </td>
                            <td>
                              <span className="provider">{call.provider}</span>
                              {call.model}
                            </td>
                            <td>
                              <TokenValue value={call.tokens.freshPrompt} />
                            </td>
                            <td
                              className={call.tokens.cacheRead
                                ? "cache-hit"
                                : "muted"}
                            >
                              <TokenValue value={call.tokens.cacheRead} />
                            </td>
                            <td
                              className={call.tokens.cacheWrite === undefined
                                ? "muted"
                                : ""}
                            >
                              {call.tokens.cacheWrite === undefined
                                ? "-"
                                : <TokenValue value={call.tokens.cacheWrite} />}
                            </td>
                            <td>
                              <TokenValue value={call.tokens.output} />
                            </td>
                            <td>
                              <TokenValue value={call.tokens.reasoning} />
                            </td>
                            <td>
                              <TokenValue value={call.tokens.processed} />
                            </td>
                            <td>{dollars.format(call.reportedCost)}</td>
                          </tr>
                          {expanded && (
                            <tr className="activity-detail-row">
                              <td colSpan={11}>
                                <div className="activity-detail">
                                  <div className="activity-meta">
                                    <span className="activity-label">
                                      {call.activity.finishReason === "stop"
                                        ? "FINAL"
                                        : "MODEL CALL"}
                                    </span>
                                    {call.activity.hasReasoning && (
                                      <span className="activity-label">
                                        REASONING
                                      </span>
                                    )}
                                    {call.activity.hasText && (
                                      <span className="activity-label">
                                        TEXT
                                      </span>
                                    )}
                                    {duration(
                                      call.startedAt,
                                      call.completedAt,
                                    ) && (
                                      <span>
                                        Model duration {duration(
                                          call.startedAt,
                                          call.completedAt,
                                        )}
                                      </span>
                                    )}
                                    {call.activity.finishReason && (
                                      <span>
                                        Finished: {call.activity.finishReason}
                                      </span>
                                    )}
                                  </div>
                                  {call.activity.tools.length === 0
                                    ? (
                                      <p>
                                        No tool calls in this model invocation.
                                      </p>
                                    )
                                    : (
                                      <div className="tool-events">
                                        {call.activity.tools.map((
                                          tool,
                                          index,
                                        ) => (
                                          <div
                                            className="tool-event"
                                            key={`${tool.name}-${index}`}
                                          >
                                            <strong>{tool.name}</strong>
                                            <span
                                              className={`tool-status tool-status-${tool.status}`}
                                            >
                                              {tool.status}
                                            </span>
                                            <span>
                                              {duration(
                                                tool.startedAt,
                                                tool.completedAt,
                                              ) ?? "duration unavailable"}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      ))}
    </div>
  );
}

export function SessionsPage() {
  const { page } = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<SessionListResponse>();
  const [expandedID, setExpandedID] = useState<string>();
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getSessions(page).then((result) => active && setData(result)).catch(
      (reason) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load sessions",
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [page]);

  async function toggleSession(id: string) {
    if (expandedID === id) {
      setExpandedID(undefined);
      return;
    }
    setExpandedID(id);
    if (details[id]) return;
    try {
      const detail = await getSession(id);
      setDetails((current) => ({ ...current, [id]: detail }));
    } catch (reason) {
      setExpandedID(undefined);
      setError(
        reason instanceof Error ? reason.message : "Unable to load session",
      );
    }
  }

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Local OpenCode economics</p>
          <h1>Frugal Tokens</h1>
        </div>
        <p className="intro">
          See where tokens went, what was reused, and what each model call cost.
        </p>
      </header>

      <section className="sessions-panel">
        <div className="panel-heading">
          <div>
            <h2>Recent sessions</h2>
            <p>Ordered by latest activity</p>
          </div>
          {data && (
            <span className="session-count">
              {integer.format(data.pagination.totalItems)} sessions
            </span>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {!data && !error && (
          <div className="loading">Reading local sessions...</div>
        )}
        {data && (
          <>
            <div className="session-table-wrap">
              <table className="session-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Provider / model</th>
                    <th>Turns</th>
                    <th>Calls</th>
                    <th>Fresh prompt</th>
                    <th>Processed</th>
                    <th>Reported cost</th>
                    <th aria-label="Expand" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((session) => {
                    const expanded = expandedID === session.id;
                    return (
                      <Fragment key={session.id}>
                        <tr
                          className="session-row"
                          key={session.id}
                          onClick={() => toggleSession(session.id)}
                          aria-expanded={expanded}
                        >
                          <td>
                            <strong>{session.title}</strong>
                            <small className="session-id" title={session.id}>
                              {session.id}
                            </small>
                            <small className="updated-at">
                              {new Date(session.updatedAt).toLocaleString()}
                            </small>
                          </td>
                          <td>
                            <span className="provider">
                              {session.providers.join(", ") || "unknown"}
                            </span>
                            {session.models.join(", ") || "unknown"}
                          </td>
                          <td>{session.userTurns}</td>
                          <td>{session.modelCalls}</td>
                          <td>
                            <TokenValue value={session.tokens.freshPrompt} />
                          </td>
                          <td>
                            <TokenValue value={session.tokens.processed} />
                          </td>
                          <td>{dollars.format(session.reportedCost)}</td>
                          <td className="chevron">{expanded ? "−" : "+"}</td>
                        </tr>
                        {expanded && (
                          <tr
                            className="detail-row"
                            key={`${session.id}-detail`}
                          >
                            <td colSpan={8}>
                              {details[session.id]
                                ? (
                                  <SessionBreakdown
                                    session={details[session.id]}
                                  />
                                )
                                : (
                                  <div className="loading">
                                    Grouping model calls by turn...
                                  </div>
                                )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Session pages">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => navigate({ search: { page: page - 1 } })}
              >
                Previous
              </button>
              <span>Page {page} of {data.pagination.totalPages || 1}</span>
              <button
                type="button"
                disabled={page >= data.pagination.totalPages}
                onClick={() => navigate({ search: { page: page + 1 } })}
              >
                Next
              </button>
            </nav>
          </>
        )}
      </section>
    </main>
  );
}
