import {
  createContext,
  type CSSProperties,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { getRouteApi } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  Gauge,
  Image,
  Minimize2,
  Moon,
  Sparkles,
  Split,
  Sun,
  TriangleAlert,
  User,
  Wrench,
  X,
} from "lucide-react";
import type {
  ConversationBranch,
  CostScenarioResponse,
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { contextRange, contextSize } from "../shared/contextMetrics.ts";
import { canonicalModelId, displayModelName } from "../shared/modelNames.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import { summarizeWorkTime } from "../shared/workTime.ts";
import {
  computeModelCallCost,
  counterfactualModelIDs,
} from "../shared/modelPricing.ts";
import {
  getSession,
  getSessionCostScenario,
  openSessionInGhostty,
} from "./api.ts";
import { harnessIcon, harnessName } from "./harness.ts";
import { modelIcon } from "./modelIcons.ts";
import { costsMismatch, CostWarning } from "./CostWarning.tsx";
import ghosttyIcon from "./assets/icons/ghostty.png";
import "./SessionDetailPage.css";

const route = getRouteApi("/sessions/$harness/$sessionId");

type PathMode = "absolute" | "relative";
type ColorMetric = "none" | "time" | "cost";
type CostScenario = "recorded" | string;
type SessionTheme = "dark" | "light";

const SESSION_THEME_KEY = "frugal-tokens:session-theme";

const TurnCollapseContext = createContext<{
  collapsedTurnIDs: Set<string>;
  turnColors: Map<string, string>;
  model: CostScenario;
  thinking: string;
  focusedCallAnchor?: string;
  toggleTurn: (id: string) => void;
}>({
  collapsedTurnIDs: new Set(),
  turnColors: new Map(),
  model: "recorded",
  thinking: "recorded",
  focusedCallAnchor: undefined,
  toggleTurn: () => {},
});

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const integer = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const timestamp = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const workBlockDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const workBlockTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function elapsed(startedAt?: number, completedAt?: number) {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const milliseconds = completedAt - startedAt;
  if (milliseconds <= 0) return undefined;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function estimatedActiveDuration(milliseconds: number) {
  if (milliseconds <= 0) return undefined;
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `~${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

function sessionWorkTime(session: SessionDetail) {
  const executionIntervals = session.turns.flatMap((turn) => {
    const calls = turn.calls.filter((call) =>
      !call.id.startsWith("context-operation:") &&
      !call.id.startsWith("unmeasured:")
    );
    if (calls.length === 0) return [];
    return [{
      startedAt: turn.startedAt,
      executionEndAt: Math.max(
        turn.startedAt,
        ...calls.map((call) => call.completedAt ?? call.startedAt),
      ),
    }];
  });
  return summarizeWorkTime(executionIntervals);
}

type WorkTimeSummary = ReturnType<typeof sessionWorkTime>;

function HarnessMark({ harness }: { harness: SessionDetail["harness"] }) {
  return (
    <img
      className={`sd-harness-mark${harness === "pi" ? " is-pi" : ""}`}
      src={harnessIcon(harness)}
      alt=""
    />
  );
}

function ModelMark({ model }: { model: string }) {
  const icon = modelIcon(model);
  return icon
    ? (
      <img
        className={`sd-model-mark is-${icon.provider}`}
        src={icon.source}
        alt=""
      />
    )
    : <Bot size={13} />;
}

function sessionTree(session: SessionDetail): SessionDetail[] {
  return [session, ...session.subagents.flatMap(sessionTree)];
}

function callsInTree(session: SessionDetail) {
  return sessionTree(session).flatMap((item) =>
    item.turns.flatMap((turn) => turn.calls)
  );
}

function sessionBounds(session: SessionDetail) {
  const tree = sessionTree(session);
  const starts = tree.flatMap((item) => [
    ...(item.startedAt === undefined ? [] : [item.startedAt]),
    ...item.turns.map((turn) => turn.startedAt),
  ]);
  const ends = tree.flatMap((item) => [
    ...(item.endedAt === undefined ? [] : [item.endedAt]),
    ...item.turns.flatMap((turn) =>
      turn.calls.map((call) => call.completedAt ?? call.startedAt)
    ),
  ]);
  return {
    start: starts.length === 0 ? undefined : Math.min(...starts),
    end: ends.length === 0 ? undefined : Math.max(...ends),
  };
}

function inclusiveTokens(session: SessionDetail): TokenUsage {
  if (session.inclusiveTokens) return session.inclusiveTokens;
  const tree = sessionTree(session);
  return {
    uncachedInput: tree.reduce(
      (sum, item) => sum + item.tokens.uncachedInput,
      0,
    ),
    cacheRead: tree.reduce((sum, item) => sum + item.tokens.cacheRead, 0),
    cacheWrite: tree.reduce(
      (sum, item) => sum + (item.tokens.cacheWrite ?? 0),
      0,
    ),
    cacheWrite5m: tree.reduce(
      (sum, item) => sum + (item.tokens.cacheWrite5m ?? 0),
      0,
    ),
    cacheWrite1h: tree.reduce(
      (sum, item) => sum + (item.tokens.cacheWrite1h ?? 0),
      0,
    ),
    freshPrompt: tree.reduce((sum, item) => sum + item.tokens.freshPrompt, 0),
    output: tree.reduce((sum, item) => sum + item.tokens.output, 0),
    reasoning: tree.reduce((sum, item) => sum + item.tokens.reasoning, 0),
    processed: tree.reduce((sum, item) => sum + item.tokens.processed, 0),
  };
}

function relativePathText(
  value: string,
  rootDirectory: string | undefined,
  pathMode: PathMode,
) {
  if (pathMode === "absolute" || !rootDirectory) return value;
  const root = rootDirectory.replace(/\/+$/, "");
  const candidates = new Set([root]);
  if (root.startsWith("~/")) {
    const suffix = root.slice(2);
    let offset = 0;
    while (offset < value.length) {
      const index = value.indexOf(suffix, offset);
      if (index < 0) break;
      let start = index;
      while (
        start > 0 && !['"', "'", " ", "\n", "\t"].includes(value[start - 1])
      ) start--;
      const candidate = value.slice(start, index + suffix.length);
      if (candidate.includes("/")) candidates.add(candidate);
      offset = index + suffix.length;
    }
  }
  let result = value;
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(`${candidate}/`, "").replaceAll(candidate, ".");
  }
  return result;
}

function scenarioTokens(
  tokens: TokenUsage,
  targetModel: string,
  thinking: string,
  sourceProvider: string,
): TokenUsage {
  const reasoning = thinking === "off" ? 0 : tokens.reasoning;
  if (
    canonicalModelId(targetModel).startsWith("claude-") ||
    !sourceProvider.toLowerCase().includes("anthropic") ||
    tokens.cacheWrite === undefined
  ) return { ...tokens, reasoning };
  const cacheWrite = tokens.cacheWrite;
  return {
    uncachedInput: tokens.uncachedInput + cacheWrite,
    cacheRead: tokens.cacheRead,
    freshPrompt: tokens.freshPrompt,
    output: tokens.output,
    reasoning,
    processed: tokens.processed,
  };
}

function scenarioCallCost(
  call: ModelCall,
  model: CostScenario,
  thinking: string,
) {
  const targetModel = model === "recorded" ? call.model : model;
  return computeModelCallCost(
    scenarioTokens(call.tokens, targetModel, thinking, call.provider),
    targetModel,
    call.startedAt,
    call.provider,
  );
}

function scenarioCost(
  calls: ModelCall[],
  model: CostScenario,
  thinking: string,
) {
  return rollupCosts(
    calls.map((call) => scenarioCallCost(call, model, thinking)),
  );
}

function turnAnchor(sessionID: string, turn: number) {
  return `turn-${encodeURIComponent(sessionID)}-${turn}`;
}

function callAnchor(sessionID: string, turn: number, callID: string) {
  return `${turnAnchor(sessionID, turn)}-call-${encodeURIComponent(callID)}`;
}

function subagentLaunchTurnPath(
  session: SessionDetail,
  targetSessionID: string,
): string[] | undefined {
  if (session.id === targetSessionID) return [];
  for (const child of session.subagents) {
    const childPath = subagentLaunchTurnPath(child, targetSessionID);
    if (childPath === undefined) continue;
    const launchTurn = session.turns.find((turn) =>
      turn.calls.some((call) =>
        call.activity.tools.some((tool) => tool.childSessionID === child.id)
      )
    );
    return launchTurn
      ? [turnAnchor(session.id, launchTurn.number), ...childPath]
      : childPath;
  }
  return undefined;
}

function sessionTurnIDs(session: SessionDetail) {
  return sessionTree(session).flatMap((item) =>
    item.turns.map((turn) => turnAnchor(item.id, turn.number))
  );
}

function defaultCollapsedTurnIDs(session: SessionDetail) {
  const turns = sessionTurnIDs(session);
  const collapsed = new Set(turns);
  const hashTarget = globalThis.location.hash.slice(1);
  const targetedTurn = turns.find((id) =>
    hashTarget === id || hashTarget.startsWith(`${id}-call-`)
  );
  const latestTurn = session.turns.at(-1);
  const initiallyExpanded = targetedTurn ??
    (latestTurn ? turnAnchor(session.id, latestTurn.number) : undefined);
  if (initiallyExpanded) collapsed.delete(initiallyExpanded);
  return collapsed;
}

function DetailMetric({ label, value, detail, detailTitle }: {
  label: string;
  value: ReactNode;
  detail?: string;
  detailTitle?: string;
}) {
  return (
    <div className="sd-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small title={detailTitle}>{detail}</small>}
    </div>
  );
}

function CostIntegrityValue({
  reported,
  computed,
}: {
  reported?: number;
  computed?: number;
}) {
  const missingComputed = computed === undefined && reported !== undefined;
  const mismatch = costsMismatch(reported, computed);
  const warning = missingComputed || mismatch;
  const value = missingComputed
    ? money.format(reported)
    : computed === undefined
    ? "Unpriced"
    : money.format(computed);
  return (
    <span className={`sd-cost-value${warning ? " is-warning" : ""}`}>
      <CostWarning reported={reported} computed={computed} />
      <span>{value}</span>
    </span>
  );
}

function ExpandableText({
  text,
  truncated = false,
  mono = false,
  threshold = 420,
}: {
  text: string;
  truncated?: boolean;
  mono?: boolean;
  threshold?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > threshold;
  return (
    <div className={`sd-expandable-text${mono ? " is-mono" : ""}`}>
      <div className={expanded ? "is-expanded" : undefined}>{text}</div>
      <span className="sd-text-actions">
        {canExpand && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
        {truncated && <small>Archive preview truncated</small>}
      </span>
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  icon,
  label,
  meta,
  children,
  className = "",
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`sd-disclosure ${className}${open ? " is-open" : ""}`}>
      <button type="button" aria-expanded={open} onClick={onToggle}>
        {icon}
        <span className="sd-disclosure-label">{label}</span>
        {meta && <span className="sd-disclosure-meta">{meta}</span>}
        <ChevronRight className="sd-disclosure-chevron" size={14} />
      </button>
      {open && (
        <div className="sd-disclosure-grid">
          <div>
            <div className="sd-disclosure-content">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

type BreadcrumbEntry = {
  id: string;
  label: string;
  description: string;
  depth: 0 | 1;
  value: number;
  formattedValue: string;
};

function breadcrumbDescription(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 95)}…`;
}

function breadcrumbMetricLabel(metric: ColorMetric) {
  return metric === "cost" ? "Cost" : "Time";
}

function breadcrumbMetric(
  calls: ModelCall[],
  duration: number,
  metric: ColorMetric,
  model: CostScenario,
  thinking: string,
) {
  const cost = scenarioCost(calls, model, thinking).cost ?? 0;
  const value = metric === "cost" ? cost : duration;
  const formattedValue = metric === "cost"
    ? money.format(cost)
    : elapsed(0, duration) ?? "Unavailable";
  return { value, formattedValue };
}

function linkedSubagentsForTurn(
  turn: SessionDetail["turns"][number],
  session: SessionDetail,
) {
  const childIDs = new Set(
    turn.calls.flatMap((call) =>
      call.activity.tools.flatMap((tool) =>
        tool.childSessionID ? [tool.childSessionID] : []
      )
    ),
  );
  return session.subagents.filter((child) => childIDs.has(child.id));
}

function callsForTurn(
  turn: SessionDetail["turns"][number],
  session: SessionDetail,
) {
  const subagents = linkedSubagentsForTurn(turn, session);
  return {
    subagents,
    calls: [...turn.calls, ...subagents.flatMap(callsInTree)],
  };
}

function turnSummary(
  turn: SessionDetail["turns"][number],
  session: SessionDetail,
  model: CostScenario,
  thinking: string,
) {
  const { calls, subagents } = callsForTurn(turn, session);
  const end = calls.reduce(
    (latest, call) => Math.max(latest, call.completedAt ?? call.startedAt),
    turn.startedAt,
  );
  const cost = model === "recorded" && thinking === "recorded"
    ? rollupCosts(calls.map((call) => call.computedCost))
    : scenarioCost(calls, model, thinking);
  const input = calls.reduce(
    (total, call) => total + contextSize(call.tokens),
    0,
  );
  const cacheRead = calls.reduce(
    (total, call) => total + call.tokens.cacheRead,
    0,
  );
  return {
    elapsed: elapsed(turn.startedAt, end),
    calls: turn.calls.length,
    tools: turn.calls.reduce(
      (total, call) => total + call.activity.tools.length,
      0,
    ),
    subagents: subagents.length,
    context: contextRange(turn.calls),
    input,
    cacheRead,
    uncachedInput: calls.reduce(
      (total, call) => total + call.tokens.uncachedInput,
      0,
    ),
    cacheWrite: calls.reduce(
      (total, call) => total + (call.tokens.cacheWrite ?? 0),
      0,
    ),
    reuse: input === 0 ? undefined : cacheRead / input,
    output: calls.reduce((total, call) => total + call.tokens.output, 0),
    reasoning: calls.reduce(
      (total, call) => total + call.tokens.reasoning,
      0,
    ),
    cost,
  };
}

function breadcrumbEntries(
  session: SessionDetail,
  metric: ColorMetric,
  model: CostScenario,
  thinking: string,
  collapsedTurnIDs: Set<string>,
  visibleTurnNumbers?: Set<number>,
): BreadcrumbEntry[] {
  const turns = visibleTurnNumbers
    ? session.turns.filter((turn) => visibleTurnNumbers.has(turn.number))
    : session.turns;
  return turns.flatMap((turn) => {
    const { calls } = callsForTurn(turn, session);
    const end = calls.reduce(
      (latest, call) => Math.max(latest, call.completedAt ?? call.startedAt),
      turn.startedAt,
    );
    const duration = Math.max(0, end - turn.startedAt);
    const turnMetric = breadcrumbMetric(
      calls,
      duration,
      metric,
      model,
      thinking,
    );
    const id = turnAnchor(session.id, turn.number);
    const turnEntry = {
      id,
      label: `Turn ${turn.number}`,
      description: breadcrumbDescription(
        (turn.inputs ?? []).find((input) => input.kind === "text")?.preview,
        `${turn.calls.length} direct model call${
          turn.calls.length === 1 ? "" : "s"
        }`,
      ),
      depth: 0 as const,
      ...turnMetric,
    };
    if (collapsedTurnIDs.has(id)) return [turnEntry];
    return [
      turnEntry,
      ...turn.calls.map((call) => {
        const callDuration = Math.max(
          0,
          (call.completedAt ?? call.startedAt) - call.startedAt,
        );
        return {
          id: callAnchor(session.id, turn.number, call.id),
          label: `Turn ${turn.number}, call ${call.callWithinTurn}`,
          description: breadcrumbDescription(
            call.preview,
            `${
              displayModelName(call.model)
            } · ${call.activity.tools.length} tool call${
              call.activity.tools.length === 1 ? "" : "s"
            }`,
          ),
          depth: 1 as const,
          ...breadcrumbMetric(
            [call],
            callDuration,
            metric,
            model,
            thinking,
          ),
        };
      }),
    ];
  });
}

function breadcrumbColor(value: number, values: number[], enabled: boolean) {
  if (!enabled) return "var(--sd-ink-3)";
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const ratio = maximum === minimum
    ? 0.5
    : (value - minimum) / (maximum - minimum);
  return `hsl(${Math.round(142 - ratio * 142)} 62% 52%)`;
}

function SessionNavigator({
  session,
  metric,
  model,
  thinking,
  visibleTurnNumbers,
}: {
  session: SessionDetail;
  metric: ColorMetric;
  model: CostScenario;
  thinking: string;
  visibleTurnNumbers?: Set<number>;
}) {
  const { collapsedTurnIDs } = useContext(TurnCollapseContext);
  const entries = breadcrumbEntries(
    session,
    metric,
    model,
    thinking,
    collapsedTurnIDs,
    visibleTurnNumbers,
  );
  const navRef = useRef<HTMLDivElement>(null);
  const [activeID, setActiveID] = useState(entries[0]?.id);
  const [preview, setPreview] = useState<{
    entry: BreadcrumbEntry;
    top: number;
    color: string;
  }>();
  const entryKey = entries.map((entry) => entry.id).join("|");

  useEffect(() => {
    if (!activeID || entries.some((entry) => entry.id === activeID)) return;
    const parent = entries.find((entry) =>
      entry.depth === 0 && activeID.startsWith(entry.id)
    );
    setActiveID(parent?.id ?? entries[0]?.id);
  }, [entryKey, activeID]);

  useEffect(() => {
    const transcript = document.querySelector<HTMLElement>(
      ".sd-layout > .sd-transcript",
    );
    const depthByID = new Map(entries.map((entry) => [entry.id, entry.depth]));
    const elements = entries.flatMap((entry) => {
      const element = document.getElementById(entry.id);
      return element ? [element] : [];
    });
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (observations) => {
        const visible = observations.filter((item) => item.isIntersecting)
          .sort((a, b) =>
            (depthByID.get(b.target.id) ?? 0) -
              (depthByID.get(a.target.id) ?? 0) ||
            Math.abs(a.boundingClientRect.top) -
              Math.abs(b.boundingClientRect.top)
          );
        if (visible[0]) setActiveID(visible[0].target.id);
      },
      { root: transcript, rootMargin: "-18% 0px -70%", threshold: 0 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [entryKey]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !activeID) return;
    const button = [...nav.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.dataset.target === activeID,
    );
    if (!button) return;
    const top = button.offsetTop - nav.clientHeight / 2 +
      button.offsetHeight / 2;
    nav.scrollTo({ top, behavior: "smooth" });
  }, [activeID]);

  function showPreview(entry: BreadcrumbEntry, button: HTMLButtonElement) {
    const nav = navRef.current;
    if (!nav) return;
    const buttonBounds = button.getBoundingClientRect();
    const navBounds = nav.getBoundingClientRect();
    const top = Math.max(
      8,
      Math.min(
        nav.clientHeight - 96,
        buttonBounds.top - navBounds.top + buttonBounds.height / 2 - 36,
      ),
    );
    setPreview({
      entry,
      top,
      color: breadcrumbColor(
        entry.value,
        entries.filter((candidate) => candidate.depth === entry.depth).map(
          (candidate) => candidate.value,
        ),
        metric !== "none",
      ),
    });
  }

  return (
    <nav className="sd-session-nav" aria-label="Session turns">
      <div ref={navRef} className="sd-session-nav-scroll">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`is-depth-${entry.depth}${
              activeID === entry.id ? " is-active" : ""
            }`}
            data-target={entry.id}
            style={{
              backgroundColor: breadcrumbColor(
                entry.value,
                entries.filter((candidate) => candidate.depth === entry.depth)
                  .map((candidate) => candidate.value),
                metric !== "none",
              ),
            }}
            aria-label={`${entry.label}, ${entry.formattedValue}`}
            onPointerEnter={(event) => showPreview(entry, event.currentTarget)}
            onPointerLeave={() => setPreview(undefined)}
            onFocus={(event) => showPreview(entry, event.currentTarget)}
            onBlur={() => setPreview(undefined)}
            onClick={() => {
              setActiveID(entry.id);
              const target = document.getElementById(entry.id);
              const transcript = target?.closest<HTMLElement>(".sd-transcript");
              if (!target || !transcript) return;
              const top = transcript.scrollTop +
                target.getBoundingClientRect().top -
                transcript.getBoundingClientRect().top - 16;
              transcript.scrollTo({
                behavior: "smooth",
                top,
              });
            }}
          />
        ))}
      </div>
      {preview && (
        <div className="sd-crumb-popover" style={{ top: preview.top }}>
          <span style={{ backgroundColor: preview.color }} />
          <div>
            <strong>{preview.entry.label}</strong>
            <p>{preview.entry.description}</p>
            <small>
              {breadcrumbMetricLabel(metric)} · {preview.entry.formattedValue}
            </small>
          </div>
        </div>
      )}
    </nav>
  );
}

type CacheMissKind =
  | "compaction"
  | "ttl"
  | "thinking-change"
  | "model-change"
  | "full-miss"
  | "partial-miss";

type CallOccurrence = {
  session: SessionDetail;
  turn: SessionDetail["turns"][number];
  call: ModelCall;
  jumpTarget?: "call" | "turn";
};

type CacheMissOccurrence = CallOccurrence & {
  kind: CacheMissKind;
};

function cacheMissKind(call: ModelCall): CacheMissKind | undefined {
  const assessment = call.cacheAssessment;
  if (!assessment) return undefined;
  if (assessment.cause === "compaction") return "compaction";
  if (assessment.cause === "ttl") return "ttl";
  if (assessment.cause === "thinking-change") return "thinking-change";
  if (assessment.reason === "model-change") return "model-change";
  if (assessment.status === "full-miss") return "full-miss";
  if (assessment.status === "partial-hit") return "partial-miss";
  return undefined;
}

function CacheMissIcon(
  { kind, size = 13 }: { kind: CacheMissKind; size?: number },
) {
  if (kind === "compaction") {
    return <Minimize2 size={size} aria-hidden="true" />;
  }
  if (kind === "ttl") return <Clock3 size={size} aria-hidden="true" />;
  if (kind === "thinking-change") {
    return <Brain size={size} aria-hidden="true" />;
  }
  if (kind === "model-change") {
    return <Split size={size} aria-hidden="true" />;
  }
  return <TriangleAlert size={size} aria-hidden="true" />;
}

function cacheMissLabel(kind: CacheMissKind) {
  if (kind === "compaction") return "Compaction";
  if (kind === "ttl") return "TTL miss";
  if (kind === "thinking-change") return "Thinking change";
  if (kind === "model-change") return "Model change";
  if (kind === "full-miss") return "Full miss";
  return "Partial miss";
}

function CacheIssue({
  call,
  previousMessageAt,
}: {
  call: ModelCall;
  previousMessageAt?: number;
}) {
  const kind = cacheMissKind(call);
  if (!kind) return null;
  const timeSinceLastMessage = kind === "ttl"
    ? elapsed(previousMessageAt, call.startedAt)
    : undefined;
  return (
    <>
      <span
        className="sd-cache-issue"
        title={cacheMissLabel(kind)}
      >
        <CacheMissIcon kind={kind} />
        {cacheMissLabel(kind)}
      </span>
      {timeSinceLastMessage && (
        <span
          className="sd-cache-gap"
          title={previousMessageAt === undefined
            ? undefined
            : `Previous message: ${fullTimestamp.format(previousMessageAt)}`}
        >
          Time since last message: {timeSinceLastMessage}
        </span>
      )}
    </>
  );
}

function CacheMissBadges({
  session,
  onJumpToCall,
}: {
  session: SessionDetail;
  onJumpToCall: (occurrence: CacheMissOccurrence) => void;
}) {
  const [openKind, setOpenKind] = useState<CacheMissKind>();
  const containerRef = useRef<HTMLDivElement>(null);
  const occurrences = sessionTree(session).flatMap((item) =>
    item.turns.flatMap((turn) =>
      turn.calls.flatMap((call) => {
        const kind = cacheMissKind(call);
        return kind ? [{ kind, session: item, turn, call }] : [];
      })
    )
  );
  const kinds: CacheMissKind[] = [
    "compaction",
    "ttl",
    "thinking-change",
    "model-change",
    "full-miss",
    "partial-miss",
  ];
  const groups = kinds.map((kind) => ({
    kind,
    occurrences: occurrences.filter((occurrence) => occurrence.kind === kind),
  })).filter((group) => group.occurrences.length > 0);
  const openGroup = groups.find((group) => group.kind === openKind);

  useEffect(() => {
    if (!openKind) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpenKind(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenKind(undefined);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openKind]);

  if (groups.length === 0) return null;
  return (
    <div className="sd-cache-misses" ref={containerRef}>
      <div className="sd-cache-miss-list">
        {groups.map((group) => (
          <button
            key={group.kind}
            type="button"
            className="sd-cache-miss-row"
            aria-expanded={openKind === group.kind}
            aria-controls={`cache-miss-${group.kind}`}
            onClick={() =>
              setOpenKind((current) =>
                current === group.kind ? undefined : group.kind
              )}
          >
            <CacheMissIcon kind={group.kind} size={12} />
            <span>{cacheMissLabel(group.kind)}</span>
            <strong>{group.occurrences.length}</strong>
          </button>
        ))}
      </div>
      {openGroup && (
        <div
          className="sd-cache-miss-popover"
          id={`cache-miss-${openGroup.kind}`}
          role="dialog"
          aria-label={`${cacheMissLabel(openGroup.kind)} calls`}
        >
          <header>
            <span>
              <CacheMissIcon kind={openGroup.kind} />{" "}
              {cacheMissLabel(openGroup.kind)}
            </span>
            <strong>{openGroup.occurrences.length}</strong>
          </header>
          <div>
            {openGroup.occurrences.map((occurrence) => {
              const input = contextSize(occurrence.call.tokens);
              const reuse = input === 0
                ? undefined
                : occurrence.call.tokens.cacheRead / input;
              return (
                <button
                  key={`${occurrence.session.id}-${occurrence.call.id}`}
                  type="button"
                  onClick={() => {
                    setOpenKind(undefined);
                    onJumpToCall(occurrence);
                  }}
                >
                  <span>
                    {occurrence.session.id === session.id
                      ? "Turn"
                      : "Subagent turn"} {occurrence.turn.number} · Call{" "}
                    {occurrence.call.callWithinTurn}
                  </span>
                  <small>
                    {displayModelName(occurrence.call.model)}
                    {reuse === undefined
                      ? ""
                      : ` · ${(reuse * 100).toFixed(1)}% reused`}
                  </small>
                  {occurrence.call.cacheMissCost !== undefined && (
                    <small className="sd-cache-miss-cost">
                      {money.format(occurrence.call.cacheMissCost)}
                    </small>
                  )}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function toolTarget(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      for (
        const key of [
          "description",
          "prompt",
          "task",
          "command",
          "filePath",
          "name",
          "path",
          "pattern",
          "query",
        ]
      ) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (typeof candidate === "string") return candidate;
      }
    }
  } catch {
    return value;
  }
  return undefined;
}

function ToolEvent({
  tool,
  child,
  depth,
  pathMode,
  rootDirectory,
}: {
  tool: ModelCall["activity"]["tools"][number];
  child?: SessionDetail;
  depth: number;
  pathMode: PathMode;
  rootDirectory?: string;
}) {
  const { focusedCallAnchor } = useContext(TurnCollapseContext);
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(tool.inputPreview || tool.outputPreview || child);
  useEffect(() => {
    if (
      child && focusedCallAnchor &&
      sessionTree(child).some((item) =>
        item.turns.some((turn) =>
          turn.calls.some((call) =>
            callAnchor(item.id, turn.number, call.id) === focusedCallAnchor
          )
        )
      )
    ) setOpen(true);
  }, [child, focusedCallAnchor]);
  const failed = ["error", "failed", "cancelled"].includes(
    tool.status.toLowerCase(),
  );
  const inputPreview = tool.inputPreview === undefined
    ? undefined
    : relativePathText(tool.inputPreview, rootDirectory, pathMode);
  const outputPreview = tool.outputPreview === undefined
    ? undefined
    : relativePathText(tool.outputPreview, rootDirectory, pathMode);
  const target = toolTarget(inputPreview);
  const childCalls = child === undefined ? 0 : callsInTree(child).length;
  const duration = elapsed(tool.startedAt, tool.completedAt) ?? tool.status;
  return (
    <div className={`sd-tool-event${open ? " is-open" : ""}`}>
      <button
        type="button"
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        onClick={() => hasDetails && setOpen((current) => !current)}
      >
        <span className={`sd-tool-status${failed ? " is-failed" : ""}`}>
          {failed ? <X size={12} /> : <Check size={12} />}
        </span>
        {child
          ? (
            <strong className="sd-subagent-tool-label">
              <Bot size={13} />
              {child.agent ?? "Subagent"}
              <span>subagent</span>
            </strong>
          )
          : <strong>{tool.name}</strong>}
        {child
          ? (
            <span className="sd-subagent-tool-title" title={child.title}>
              {child.title}
            </span>
          )
          : target && <code>{target}</code>}
        <small>
          {child && `${childCalls} call${childCalls === 1 ? "" : "s"} · `}
          {duration}
        </small>
        {hasDetails && <ChevronRight size={13} />}
      </button>
      {hasDetails && open && (
        <div className="sd-tool-detail-grid">
          <div>
            <div className="sd-tool-detail">
              {inputPreview && (
                <section>
                  <span>Input</span>
                  <ExpandableText text={inputPreview} mono threshold={260} />
                </section>
              )}
              {outputPreview && (
                <section>
                  <span>Output</span>
                  <ExpandableText text={outputPreview} mono threshold={260} />
                </section>
              )}
              {child && (
                <SubagentDisclosure
                  session={child}
                  depth={depth + 1}
                  pathMode={pathMode}
                  rootDirectory={rootDirectory}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolGroup({
  call,
  session,
  depth,
  pathMode,
  rootDirectory,
}: {
  call: ModelCall;
  session: SessionDetail;
  depth: number;
  pathMode: PathMode;
  rootDirectory?: string;
}) {
  const [open, setOpen] = useState(true);
  if (call.activity.tools.length === 0) return null;
  const childByID = new Map(
    session.subagents.map((child) => [child.id, child]),
  );
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((current) => !current)}
      icon={<Wrench size={13} />}
      label={`${call.activity.tools.length} tool call${
        call.activity.tools.length === 1 ? "" : "s"
      }`}
      className="sd-tool-group"
    >
      <div className="sd-tool-list">
        {call.activity.tools.map((tool, index) => (
          <ToolEvent
            key={`${tool.name}-${index}`}
            tool={tool}
            child={tool.childSessionID
              ? childByID.get(tool.childSessionID)
              : undefined}
            depth={depth}
            pathMode={pathMode}
            rootDirectory={rootDirectory}
          />
        ))}
      </div>
    </Disclosure>
  );
}

function ReasoningSummary({ call }: { call: ModelCall }) {
  const hasReasoning = call.activity.hasReasoning ||
    call.tokens.reasoning > 0 ||
    call.reasoningSetting !== undefined;
  if (!hasReasoning) return null;
  const callDuration = elapsed(call.startedAt, call.completedAt);
  return (
    <div className="sd-thinking-summary">
      <Sparkles size={15} />
      <span>{callDuration ? `Thought for ${callDuration}` : "Thought"}</span>
    </div>
  );
}

function ContextEvents({ call }: { call: ModelCall }) {
  const events = call.contextEventsBefore ?? [];
  if (events.length === 0) return null;
  return (
    <div className="sd-context-events">
      {events.map((event) => {
        const summary = event.compaction?.checkpointItems.find((item) =>
          item.kind === "summary" && item.contentAvailability === "plaintext" &&
          item.contentPreview !== undefined
        );
        return (
          <div
            className="sd-context-event"
            key={`${event.sourceOrder}-${event.type}`}
          >
            <span>
              <Minimize2 size={12} />
              {event.type === "compaction" ? "Context compacted" : event.type}
              {event.compaction?.preContextTokens !== undefined &&
                event.compaction.postContextTokens !== undefined && (
                <small>
                  {compact.format(event.compaction.preContextTokens)} →{" "}
                  {compact.format(
                    event.compaction.postContextTokens,
                  )}
                </small>
              )}
            </span>
            {summary && (
              <pre className="sd-compaction-summary">
                {summary.contentPreview}{summary.truncated ? "…" : ""}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function previousComparableCallStartedAt(
  session: SessionDetail,
  currentCall: ModelCall,
) {
  let previousStartedAt: number | undefined;
  for (const turn of session.turns) {
    for (const call of turn.calls) {
      if (call === currentCall) return previousStartedAt;
      if (contextSize(call.tokens) > 0) previousStartedAt = call.startedAt;
    }
  }
  return undefined;
}

function CallBlock({
  call,
  session,
  turnNumber,
  effort,
  depth,
  pathMode,
  rootDirectory,
}: {
  call: ModelCall;
  session: SessionDetail;
  turnNumber: number;
  effort?: string;
  depth: number;
  pathMode: PathMode;
  rootDirectory?: string;
}) {
  const { focusedCallAnchor } = useContext(TurnCollapseContext);
  const input = contextSize(call.tokens);
  const reuse = input === 0 ? undefined : call.tokens.cacheRead / input;
  const id = callAnchor(session.id, turnNumber, call.id);
  const launchedSubagents = new Set(
    call.activity.tools.flatMap((tool) =>
      tool.childSessionID ? [tool.childSessionID] : []
    ),
  ).size;
  const previousMessageAt = call.cacheAssessment?.cause === "ttl"
    ? previousComparableCallStartedAt(session, call)
    : undefined;
  return (
    <section
      className={`sd-call${focusedCallAnchor === id ? " is-targeted" : ""}`}
      id={id}
      tabIndex={-1}
    >
      <div className="sd-call-heading">
        <span className="sd-agent-avatar">
          <ModelMark model={call.model} />
        </span>
        <strong>{displayModelName(call.model)}</strong>
        <span>Call {call.callWithinTurn}</span>
        <span>
          {elapsed(call.startedAt, call.completedAt) ?? "Timing unavailable"}
        </span>
        {effort && (
          <em className="sd-call-effort" title={`Thinking level: ${effort}`}>
            <Gauge size={11} />
            {effort}
          </em>
        )}
        {launchedSubagents > 0 && (
          <span
            className="sd-call-subagent"
            title={`Launched ${launchedSubagents} subagent${
              launchedSubagents === 1 ? "" : "s"
            }`}
          >
            <Bot size={11} />
            {launchedSubagents === 1
              ? "Subagent"
              : `${launchedSubagents} subagents`}
          </span>
        )}
        <CacheIssue call={call} previousMessageAt={previousMessageAt} />
      </div>
      <div className="sd-call-body">
        <ContextEvents call={call} />
        <ReasoningSummary call={call} />
        <ToolGroup
          call={call}
          session={session}
          depth={depth}
          pathMode={pathMode}
          rootDirectory={rootDirectory}
        />
        {call.responsePreview && (
          <div className="sd-assistant-copy">
            <ExpandableText
              text={call.responsePreview}
              truncated={call.responseTruncated}
              threshold={560}
            />
          </div>
        )}
        <div className="sd-call-stats">
          <span>{compact.format(input)} context</span>
          <span>{compact.format(call.tokens.cacheRead)} cached</span>
          {reuse !== undefined && (
            <span>{(reuse * 100).toFixed(1)}% reused</span>
          )}
          <span>{compact.format(call.tokens.output)} output</span>
          {call.tokens.reasoning > 0 && (
            <span>{compact.format(call.tokens.reasoning)} reasoning</span>
          )}
          <CostIntegrityValue
            reported={call.reportedCost}
            computed={call.computedCost}
          />
        </div>
      </div>
    </section>
  );
}

function TurnBlock({
  turn,
  session,
  depth,
  pathMode,
  rootDirectory,
}: {
  turn: SessionDetail["turns"][number];
  session: SessionDetail;
  depth: number;
  pathMode: PathMode;
  rootDirectory?: string;
}) {
  const {
    collapsedTurnIDs,
    model,
    thinking,
    toggleTurn,
    turnColors,
  } = useContext(TurnCollapseContext);
  const id = turnAnchor(session.id, turn.number);
  const collapsed = collapsedTurnIDs.has(id);
  const turnColor = turnColors.get(id);
  const summary = turnSummary(turn, session, model, thinking);
  const text = (turn.inputs ?? []).filter((input) => input.kind === "text")
    .map((input) => input.preview).filter((value): value is string =>
      Boolean(value)
    )
    .join("\n");
  const images = (turn.inputs ?? []).filter((input) => input.kind === "image");
  const attachments = (turn.inputs ?? []).filter((input) =>
    input.kind !== "text" && input.kind !== "image"
  );
  const textTruncated = (turn.inputs ?? []).some((input) =>
    input.kind === "text" && input.truncated
  );
  return (
    <article
      className={`sd-turn${collapsed ? " is-collapsed" : ""}`}
      id={id}
      style={turnColor
        ? ({ "--sd-turn-color": turnColor } as CSSProperties)
        : undefined}
    >
      <div className="sd-user-message">
        <span className="sd-user-avatar">
          <User size={13} />
        </span>
        <div>
          <header>
            <strong>You</strong>
            <span>Turn {turn.number}</span>
            {turn.branchNumber !== undefined && (
              <span
                className="sd-branch-indicator"
                aria-label={`Branch ${turn.branchNumber}`}
                title={`Branch ${turn.branchNumber}`}
              >
                <Split size={11} aria-hidden="true" />
                {turn.branchNumber}
              </span>
            )}
            {summary.elapsed !== undefined && (
              <span
                className="sd-turn-duration"
                aria-label={`Turn duration: ${summary.elapsed}`}
                title="Turn duration"
              >
                · {summary.elapsed}
              </span>
            )}
            <time title={fullTimestamp.format(turn.startedAt)}>
              {timestamp.format(turn.startedAt)}
            </time>
            <button
              type="button"
              className="sd-turn-toggle"
              aria-expanded={!collapsed}
              aria-label={`${
                collapsed ? "Expand" : "Collapse"
              } turn ${turn.number}`}
              onClick={() => toggleTurn(id)}
            >
              <ChevronDown size={14} />
            </button>
          </header>
          <div className="sd-turn-summary" aria-label="Turn summary">
            <span
              className="sd-turn-metric sd-turn-activity"
              title="Direct activity"
            >
              <strong>
                {summary.calls} call{summary.calls === 1 ? "" : "s"}
              </strong>
              {(summary.tools > 0 || summary.subagents > 0) && (
                <small>
                  {[
                    summary.tools > 0
                      ? `${summary.tools} tool${summary.tools === 1 ? "" : "s"}`
                      : undefined,
                    summary.subagents > 0
                      ? `${summary.subagents} subagent${
                        summary.subagents === 1 ? "" : "s"
                      }`
                      : undefined,
                  ].filter(Boolean).join(" · ")}
                </small>
              )}
            </span>
            <span
              className="sd-turn-metric sd-turn-context"
              title="Context in the latest direct model request"
            >
              <strong>
                {summary.context.latest === undefined
                  ? "—"
                  : compact.format(summary.context.latest.size)}
              </strong>{" "}
              context
              {summary.context.first !== undefined && (
                <small>
                  {compact.format(summary.context.first.size)} start
                </small>
              )}
            </span>
            <span
              className="sd-turn-metric sd-turn-input"
              title="Processed input, including linked subagents"
            >
              <strong>{compact.format(summary.input)}</strong> input
              <small>
                {[
                  `${compact.format(summary.uncachedInput)} uncached`,
                  summary.reuse === undefined
                    ? "Reuse unavailable"
                    : `${(summary.reuse * 100).toFixed(1)}% reused`,
                  summary.cacheWrite > 0
                    ? `${compact.format(summary.cacheWrite)} written`
                    : undefined,
                ].filter(Boolean).join(" · ")}
              </small>
            </span>
            <span
              className="sd-turn-metric sd-turn-output"
              title="Output tokens, including linked subagents"
            >
              <strong>{compact.format(summary.output)}</strong> output
              {summary.reasoning > 0 && (
                <small>{compact.format(summary.reasoning)} reasoning</small>
              )}
            </span>
            <span
              className="sd-turn-metric sd-turn-cost"
              title={summary.cost.hasUnpricedCost
                ? "Known cost; some calls could not be priced"
                : "Computed cost, including linked subagents"}
            >
              <strong>
                {summary.cost.cost === undefined
                  ? "Unpriced"
                  : `${money.format(summary.cost.cost)}${
                    summary.cost.hasUnpricedCost ? "+" : ""
                  }`}
              </strong>
            </span>
          </div>
          {collapsed
            ? (
              <p className="sd-turn-collapsed-preview">
                {text || "Non-text input"}
              </p>
            )
            : text
            ? (
              <ExpandableText
                text={text}
                truncated={textTruncated}
                threshold={520}
              />
            )
            : <p className="sd-non-text-input">Non-text input</p>}
          {!collapsed && (images.length > 0 || attachments.length > 0) && (
            <div className="sd-input-chips">
              {images.map((input, index) => (
                <span key={`image-${index}`}>
                  <Image size={12} />
                  {input.mimeType ?? "Image"}
                </span>
              ))}
              {attachments.map((input, index) => (
                <span key={`${input.kind}-${index}`}>
                  <FileText size={12} />
                  {input.kind}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="sd-turn-detail-grid">
          <div>
            <div className="sd-agent-sequence">
              {turn.calls.map((call) => (
                <CallBlock
                  key={call.id}
                  call={call}
                  session={session}
                  turnNumber={turn.number}
                  effort={call.reasoningSetting?.settingValue ??
                    turn.reasoningSetting?.settingValue}
                  depth={depth}
                  pathMode={pathMode}
                  rootDirectory={rootDirectory}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function SubagentDisclosure({
  session,
  depth,
  pathMode,
  rootDirectory,
}: {
  session: SessionDetail;
  depth: number;
  pathMode: PathMode;
  rootDirectory?: string;
}) {
  const { focusedCallAnchor } = useContext(TurnCollapseContext);
  const [open, setOpen] = useState(false);
  const calls = callsInTree(session).length;
  useEffect(() => {
    if (
      focusedCallAnchor &&
      sessionTree(session).some((item) =>
        item.turns.some((turn) =>
          turn.calls.some((call) =>
            callAnchor(item.id, turn.number, call.id) === focusedCallAnchor
          )
        )
      )
    ) setOpen(true);
  }, [focusedCallAnchor, session]);
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((current) => !current)}
      icon={<Bot size={14} />}
      label={session.agent ? `${session.agent} subagent` : "Subagent"}
      meta={`${session.turns.length} turns · ${calls} calls`}
      className="sd-subagent-disclosure"
    >
      <div className="sd-subagent-heading">
        <strong>{session.title}</strong>
        <span>{session.models.map(displayModelName).join(" · ")}</span>
      </div>
      <SessionTranscript
        session={session}
        depth={depth}
        pathMode={pathMode}
        rootDirectory={rootDirectory}
      />
    </Disclosure>
  );
}

function branchDepth(
  branch: ConversationBranch,
  branches: Map<string, ConversationBranch>,
) {
  let depth = 0;
  let parentID = branch.parentID;
  const visited = new Set<string>();
  while (parentID && !visited.has(parentID)) {
    visited.add(parentID);
    const parent = branches.get(parentID);
    if (!parent) break;
    depth++;
    parentID = parent.parentID;
  }
  return depth;
}

function branchPathTurns(
  branch: ConversationBranch,
  branches: Map<string, ConversationBranch>,
  visited = new Set<string>(),
): number[] {
  if (visited.has(branch.id)) return branch.turnNumbers;
  visited.add(branch.id);
  const parent = branch.parentID ? branches.get(branch.parentID) : undefined;
  const ancestors = parent
    ? branchPathTurns(parent, branches, visited).filter((turn) =>
      branch.forkedFromTurn === undefined || turn <= branch.forkedFromTurn
    )
    : [];
  return [...new Set([...ancestors, ...branch.turnNumbers])].sort((a, b) =>
    a - b
  );
}

function orderedBranches(branches: ConversationBranch[]) {
  const children = Map.groupBy(branches, (branch) => branch.parentID ?? "");
  const ordered: ConversationBranch[] = [];
  const append = (branch: ConversationBranch) => {
    ordered.push(branch);
    for (const child of children.get(branch.id) ?? []) append(child);
  };
  for (const root of children.get("") ?? []) append(root);
  for (const branch of branches) {
    if (!ordered.some((item) => item.id === branch.id)) append(branch);
  }
  return ordered;
}

function branchCostForTurns(
  session: SessionDetail,
  turnNumbers: number[],
  model: CostScenario,
  thinking: string,
) {
  const selected = new Set(turnNumbers);
  const calls = session.turns.filter((turn) => selected.has(turn.number))
    .flatMap((turn) => callsForTurn(turn, session).calls);
  return model === "recorded" && thinking === "recorded"
    ? rollupCosts(calls.map((call) => call.computedCost))
    : scenarioCost(calls, model, thinking);
}

function branchCostText(cost: ReturnType<typeof rollupCosts>) {
  if (cost.cost === undefined) return "Unpriced";
  return `${money.format(cost.cost)}${cost.hasUnpricedCost ? "+" : ""}`;
}

function BranchControl({
  branches,
  session,
  model,
  thinking,
  selected,
  onSelect,
}: {
  branches: ConversationBranch[];
  session: SessionDetail;
  model: CostScenario;
  thinking: string;
  selected?: ConversationBranch;
  onSelect: (branchID?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const byID = new Map(branches.map((branch) => [branch.id, branch]));
  const ordered = orderedBranches(branches);
  const latestID = [...branches].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    ?.id;
  const allTurnNumbers = session.turns.map((turn) => turn.number);
  const allCost = branchCostForTurns(session, allTurnNumbers, model, thinking);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="sd-branch-control" ref={container}>
      <button
        type="button"
        className="sd-branch-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Transcript branch: ${
          selected?.label ?? "All events"
        }. Session totals remain full-session.`}
        title="Filters the transcript to a conversation path. Session totals remain full-session."
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected?.label ?? "All events"}</span>
        <ChevronDown size={13} aria-hidden="true" />
        <strong>{branches.length} branches</strong>
      </button>
      {open && (
        <div
          className="sd-branch-panel"
          role="dialog"
          aria-label="Conversation branches"
        >
          <div className="sd-branch-panel-heading">
            <strong>Conversation branches</strong>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
          <button
            type="button"
            className={`sd-branch-all${selected ? "" : " is-selected"}`}
            onClick={() => {
              onSelect(undefined);
              setOpen(false);
            }}
          >
            <span>
              <Check size={13} /> All events
            </span>
            <span className="sd-branch-all-metrics">
              <small>{allTurnNumbers.length} turns</small>
              <strong>{branchCostText(allCost)}</strong>
            </span>
          </button>
          <div className="sd-branch-map">
            {ordered.map((branch) => {
              const pathTurns = branchPathTurns(branch, byID);
              const segmentTurns = branch.turnNumbers;
              const depth = branchDepth(branch, byID);
              const siblings = branches.filter((item) =>
                item.parentID === branch.parentID
              );
              const isLastSibling = siblings.at(-1)?.id === branch.id;
              const segmentCost = branchCostForTurns(
                session,
                segmentTurns,
                model,
                thinking,
              );
              const pathCost = branchCostForTurns(
                session,
                pathTurns,
                model,
                thinking,
              );
              return (
                <button
                  type="button"
                  key={branch.id}
                  className={`sd-branch-path${
                    selected?.id === branch.id ? " is-selected" : ""
                  }`}
                  style={{
                    "--sd-branch-offset": `${depth * 12}px`,
                  } as CSSProperties}
                  onClick={() => {
                    onSelect(branch.id);
                    setOpen(false);
                  }}
                >
                  <span className="sd-branch-topology" aria-hidden="true">
                    {depth > 0 && <i>{isLastSibling ? "└" : "├"}─</i>}
                    {segmentTurns.map((turn, index) => (
                      <Fragment key={turn}>
                        {index > 0 && <b>—</b>}
                        <em>T{turn}</em>
                      </Fragment>
                    ))}
                  </span>
                  <span className="sd-branch-label" title={branch.label}>
                    {branch.label}
                    {branch.id === latestID && <small>Latest</small>}
                  </span>
                  <span className="sd-branch-stats">
                    <span>
                      {depth === 0
                        ? `${segmentTurns.length} turns`
                        : `${segmentTurns.length} new`}
                    </span>
                    {depth > 0 && <small>{pathTurns.length} total</small>}
                  </span>
                  <span className="sd-branch-cost">
                    <strong>{branchCostText(segmentCost)}</strong>
                    {depth > 0 && (
                      <small>{branchCostText(pathCost)} path</small>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionTranscript({
  session,
  depth = 0,
  pathMode,
  rootDirectory,
  visibleTurnNumbers,
  focusedBranch,
}: {
  session: SessionDetail;
  depth?: number;
  pathMode: PathMode;
  rootDirectory?: string;
  visibleTurnNumbers?: Set<number>;
  focusedBranch?: ConversationBranch;
}) {
  const launched = new Set(
    session.turns.flatMap((turn) =>
      turn.calls.flatMap((call) =>
        call.activity.tools.flatMap((tool) =>
          tool.childSessionID ? [tool.childSessionID] : []
        )
      )
    ),
  );
  const unlinkedSubagents = session.subagents.filter((child) =>
    !launched.has(child.id)
  );
  const shownTurns = visibleTurnNumbers
    ? session.turns.filter((turn) => visibleTurnNumbers.has(turn.number))
    : session.turns;
  const firstDivergentTurn = focusedBranch?.turnNumbers[0];
  return (
    <div className={`sd-transcript${depth > 0 ? " is-nested" : ""}`}>
      {shownTurns.map((turn) => (
        <Fragment key={turn.number}>
          {turn.number === firstDivergentTurn &&
            focusedBranch?.forkedFromTurn !== undefined && (
            <div className="sd-fork-divider">
              <span>Forked from Turn {focusedBranch.forkedFromTurn}</span>
            </div>
          )}
          <TurnBlock
            turn={turn}
            session={session}
            depth={depth}
            pathMode={pathMode}
            rootDirectory={rootDirectory}
          />
        </Fragment>
      ))}
      {!visibleTurnNumbers &&
        unlinkedSubagents.map((child) => (
          <SubagentDisclosure
            key={child.id}
            session={child}
            depth={depth + 1}
            pathMode={pathMode}
            rootDirectory={rootDirectory}
          />
        ))}
    </div>
  );
}

function MetadataRow({ label, children, mono = false }: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="sd-metadata-row">
      <span>{label}</span>
      <strong className={mono ? "is-mono" : undefined}>{children}</strong>
    </div>
  );
}

function workBlockTimeRange(start: number, end: number) {
  const startParts = workBlockTime.formatToParts(start);
  const endParts = workBlockTime.formatToParts(end);
  const startPeriod = startParts.find((part) => part.type === "dayPeriod")
    ?.value;
  const endPeriod = endParts.find((part) => part.type === "dayPeriod")?.value;
  const formattedStart = startPeriod !== undefined && startPeriod === endPeriod
    ? startParts.filter((part) => part.type !== "dayPeriod").map((part) =>
      part.value
    ).join("").trim()
    : workBlockTime.format(start);
  return `${formattedStart}–${workBlockTime.format(end)}`;
}

function workBlockRange(start: number, end: number) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameDate = startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  const timeRange = workBlockTimeRange(start, end);
  if (sameDate) return `${workBlockDate.format(start)} · ${timeRange}`;
  return `${workBlockDate.format(start)}, ${
    timeRange.replace(
      "–",
      `–${workBlockDate.format(end)}, `,
    )
  }`;
}

function WorkBlocks({ workTime }: { workTime: WorkTimeSummary }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="sd-work-blocks" ref={containerRef}>
      <MetadataRow label="Work blocks">
        <button
          type="button"
          className="sd-work-block-trigger"
          aria-expanded={open}
          aria-controls="work-block-details"
          disabled={workTime.blocks === 0}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{integer.format(workTime.blocks)}</span>
          {workTime.blocks > 0 && <ChevronDown size={12} />}
        </button>
      </MetadataRow>
      {open && (
        <div
          className="sd-work-block-popover"
          id="work-block-details"
          role="dialog"
          aria-label="Estimated work blocks"
        >
          <header>
            <span>Estimated work blocks</span>
            <strong>{integer.format(workTime.blocks)}</strong>
          </header>
          <div className="sd-work-block-list">
            {workTime.intervals.map((interval, index) => (
              <div className="sd-work-block-item" key={interval.start}>
                <span>{index + 1}</span>
                <div>
                  <strong>
                    {workBlockRange(interval.start, interval.end)}
                  </strong>
                  <small>
                    {estimatedActiveDuration(interval.end - interval.start)}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function piSessionIDLabel(id: string) {
  const uuid = /_[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.exec(id);
  return uuid === null ? id : uuid[0].slice(1);
}

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

function SessionID({ session }: { session: SessionDetail }) {
  const [copied, setCopied] = useState(false);
  const label = session.harness === "pi"
    ? piSessionIDLabel(session.id)
    : session.id;

  async function copySessionID() {
    try {
      await copyText(session.id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="sd-session-id">
      <span className="sd-session-id-value" title={session.id}>{label}</span>
      <button
        type="button"
        className="sd-copy-button"
        aria-label={copied ? "Session ID copied" : "Copy full session ID"}
        title={copied ? "Copied" : "Copy full session ID"}
        onClick={() => void copySessionID()}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

function SubagentLinks({
  session,
  onJumpToCall,
}: {
  session: SessionDetail;
  onJumpToCall: (occurrence: CallOccurrence) => void;
}) {
  const subagents = sessionTree(session).slice(1);
  if (subagents.length === 0) return null;
  return (
    <section>
      <h2>Subagents</h2>
      <div className="sd-subagent-links">
        {subagents.map((subagent) => {
          const calls = callsInTree(subagent);
          const firstTurn = subagent.turns.find((turn) =>
            turn.calls.length > 0
          );
          const firstCall = firstTurn?.calls[0];
          const cost = subagent.inclusiveComputedCost ??
            rollupCosts(sessionTree(subagent).map((item) => item.computedCost))
              .cost;
          return (
            <button
              key={subagent.id}
              type="button"
              className="sd-subagent-link"
              disabled={!firstTurn || !firstCall}
              aria-label={`Jump to ${subagent.title}`}
              onClick={() => {
                if (firstTurn && firstCall) {
                  onJumpToCall({
                    session: subagent,
                    turn: firstTurn,
                    call: firstCall,
                    jumpTarget: "turn",
                  });
                }
              }}
            >
              <Bot size={14} aria-hidden="true" />
              <span>
                <strong title={subagent.title}>{subagent.title}</strong>
                <small>
                  {[
                    subagent.agent ?? "Subagent",
                    `${calls.length} call${calls.length === 1 ? "" : "s"}`,
                    cost === undefined ? undefined : money.format(cost),
                  ].filter(Boolean).join(" · ")}
                </small>
              </span>
              {firstCall && <ChevronRight size={13} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Metadata({
  session,
  pathMode,
  colorMetric,
  model,
  scenario,
  scenarioLoading,
  cacheTtl,
  actualCost,
  workTime,
  turnsExpanded,
  onToggleAllTurns,
  onPathModeChange,
  onColorMetricChange,
  onModelChange,
  onCacheTtlChange,
  onJumpToCall,
  canOpenInGhostty,
  ghosttyOpening,
  ghosttyError,
  onOpenInGhostty,
}: {
  session: SessionDetail;
  pathMode: PathMode;
  colorMetric: ColorMetric;
  model: CostScenario;
  scenario?: CostScenarioResponse;
  scenarioLoading: boolean;
  cacheTtl: "5m" | "1h";
  actualCost?: number;
  workTime: WorkTimeSummary;
  turnsExpanded: boolean;
  onToggleAllTurns: () => void;
  onPathModeChange: (value: PathMode) => void;
  onColorMetricChange: (value: ColorMetric) => void;
  onModelChange: (value: CostScenario) => void;
  onCacheTtlChange: (value: "5m" | "1h") => void;
  onJumpToCall: (occurrence: CallOccurrence) => void;
  canOpenInGhostty: boolean;
  ghosttyOpening: boolean;
  ghosttyError?: string;
  onOpenInGhostty: () => void;
}) {
  const calls = callsInTree(session);
  const context = contextRange(session.turns.flatMap((turn) => turn.calls));
  const contextStarting = context.first?.size;
  const contextLatest = context.latest?.size ?? session.contextLatest;
  const contextPeak = context.peak?.size ?? session.contextPeak;
  const contextInputs = sessionTree(session).flatMap((item) =>
    item.turns.flatMap((turn) => turn.inputs ?? [])
  );
  const imageInputs = calls.reduce(
    (total, call) => total + (call.activity.images ?? 0),
    0,
  );
  const fileInputs =
    contextInputs.filter((input) => input.kind === "file").length;
  const cacheMisses =
    calls.filter((call) =>
      call.cacheAssessment?.status === "partial-hit" ||
      call.cacheAssessment?.status === "full-miss"
    ).length;
  const directModels = new Set([
    ...session.models,
    ...session.turns.flatMap((turn) => turn.calls.map((call) => call.model)),
  ]);
  const models = [
    ...new Set([
      ...directModels,
      ...sessionTree(session).slice(1).flatMap((subagent) => [
        ...subagent.models,
        ...subagent.turns.flatMap((turn) =>
          turn.calls.map((call) => call.model)
        ),
      ]),
    ]),
  ];
  const thinkingByModel = new Map<string, string[]>();
  for (const item of sessionTree(session)) {
    for (const turn of item.turns) {
      for (const call of turn.calls) {
        const value = call.reasoningSetting?.settingValue ??
          turn.reasoningSetting?.settingValue;
        if (value === undefined) continue;
        const values = thinkingByModel.get(call.model) ?? [];
        if (!values.includes(value)) values.push(value);
        thinkingByModel.set(call.model, values);
      }
    }
  }
  const openAIModels = counterfactualModelIDs.filter((value) =>
    value.startsWith("gpt-")
  );
  const anthropicModels = counterfactualModelIDs.filter((value) =>
    value.startsWith("claude-")
  );
  const otherModels = counterfactualModelIDs.filter((value) =>
    !value.startsWith("gpt-") && !value.startsWith("claude-")
  );
  const delta = scenario === undefined || actualCost === undefined
    ? undefined
    : scenario.cost - actualCost;
  const isAnthropicScenario = model !== "recorded" &&
    canonicalModelId(model).startsWith("claude-");
  return (
    <aside className="sd-metadata">
      <section>
        <h2>Run</h2>
        {session.workingDirectory && (
          <MetadataRow label="Working directory" mono>
            {session.workingDirectory}
          </MetadataRow>
        )}
        <MetadataRow label="Harness">
          {harnessName(session.harness)}
        </MetadataRow>
        {session.agent && (
          <MetadataRow label="Agent type">{session.agent}</MetadataRow>
        )}
        <MetadataRow label="Session ID" mono>
          <SessionID session={session} />
        </MetadataRow>
        {canOpenInGhostty && (
          <button
            className="sd-launch-button"
            type="button"
            disabled={ghosttyOpening}
            onClick={onOpenInGhostty}
          >
            <img className="sd-ghostty-icon" src={ghosttyIcon} alt="" />
            {ghosttyOpening ? "Opening…" : "Open in Ghostty"}
          </button>
        )}
        {canOpenInGhostty && ghosttyError && (
          <div className="sd-launch-error" role="alert">{ghosttyError}</div>
        )}
      </section>
      <section>
        <h2>Models</h2>
        <div className="sd-model-list">
          {models.map((model) => {
            const thinkingValues = thinkingByModel.get(model) ?? [];
            return (
              <div className="sd-model-row" key={model}>
                <span className="sd-model-identity">
                  <ModelMark model={model} />
                  <span className="sd-model-name">
                    {displayModelName(model)}
                  </span>
                  {!directModels.has(model) && (
                    <span
                      className="sd-model-subagent-only"
                      aria-label="Used by subagents only"
                      title="Used by subagents only"
                    >
                      <Bot size={11} aria-hidden="true" />
                    </span>
                  )}
                </span>
                {thinkingValues.length > 0 && (
                  <span
                    className="sd-model-thinking"
                    title={`Thinking levels: ${thinkingValues.join(", ")}`}
                  >
                    <Gauge size={12} />
                    <span className="sd-model-levels">
                      {thinkingValues.map((value) => (
                        <span className="sd-model-level" key={value}>
                          {value}
                        </span>
                      ))}
                    </span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Context</h2>
        {(imageInputs > 0 || fileInputs > 0) && (
          <div className="sd-context-input-counts">
            {imageInputs > 0 && (
              <span
                aria-label={`${imageInputs} image input${
                  imageInputs === 1 ? "" : "s"
                }`}
                title={`${imageInputs} image input${
                  imageInputs === 1 ? "" : "s"
                }`}
              >
                <Image size={14} aria-hidden="true" />
                <strong>{integer.format(imageInputs)}</strong>
              </span>
            )}
            {fileInputs > 0 && (
              <span
                aria-label={`${fileInputs} file input${
                  fileInputs === 1 ? "" : "s"
                }`}
                title={`${fileInputs} file input${fileInputs === 1 ? "" : "s"}`}
              >
                <FileText size={14} aria-hidden="true" />
                <strong>{integer.format(fileInputs)}</strong>
              </span>
            )}
          </div>
        )}
        <MetadataRow label="Starting">
          {contextStarting === undefined
            ? "Unavailable"
            : compact.format(contextStarting)}
        </MetadataRow>
        <MetadataRow label="Latest">
          {contextLatest === undefined
            ? "Unavailable"
            : compact.format(contextLatest)}
        </MetadataRow>
        {contextPeak !== contextLatest && (
          <MetadataRow label="Peak">
            {contextPeak === undefined
              ? "Unavailable"
              : compact.format(contextPeak)}
          </MetadataRow>
        )}
        <MetadataRow label="Cache misses">
          {integer.format(cacheMisses)}
        </MetadataRow>
        <CacheMissBadges session={session} onJumpToCall={onJumpToCall} />
      </section>
      <section>
        <h2>Estimated work</h2>
        <MetadataRow label="Total">
          <span title="Estimated from interaction cadence. It may include up to five minutes before the first recorded turn and inferred work between nearby turns.">
            {estimatedActiveDuration(workTime.activeMilliseconds) ??
              "Unavailable"}
          </span>
        </MetadataRow>
        <WorkBlocks workTime={workTime} />
      </section>
      <SubagentLinks session={session} onJumpToCall={onJumpToCall} />
      <section>
        <h2>View</h2>
        <div className="sd-setting">
          <span>Turns</span>
          <button
            type="button"
            className="sd-setting-action"
            onClick={onToggleAllTurns}
          >
            {turnsExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
        <label className="sd-setting">
          <span>File paths</span>
          <span className="sd-setting-segmented">
            {(["absolute", "relative"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={pathMode === value ? "is-active" : undefined}
                aria-pressed={pathMode === value}
                onClick={() => onPathModeChange(value)}
              >
                {value === "absolute" ? "Absolute" : "Relative"}
              </button>
            ))}
          </span>
        </label>
        <div className="sd-setting">
          <span>Turn color</span>
          <span className="sd-setting-segmented is-three">
            {([
              ["none", "None"],
              ["time", "Time"],
              ["cost", "Cost"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={colorMetric === value ? "is-active" : undefined}
                aria-pressed={colorMetric === value}
                onClick={() => onColorMetricChange(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      </section>
      <section>
        <h2>Compare model pricing</h2>
        <label className="sd-setting">
          <span>Model</span>
          <select
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="recorded">Select a model</option>
            <optgroup label="OpenAI">
              {openAIModels.map((value) => (
                <option key={value} value={value}>
                  {displayModelName(value)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Anthropic">
              {anthropicModels.map((value) => (
                <option key={value} value={value}>
                  {displayModelName(value)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other">
              {otherModels.map((value) => (
                <option key={value} value={value}>
                  {displayModelName(value)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {isAnthropicScenario && (
          <label className="sd-setting">
            <span>Cache duration</span>
            <select
              value={cacheTtl}
              onChange={(event) =>
                onCacheTtlChange(event.target.value as "5m" | "1h")}
            >
              <option value="5m">5 minutes</option>
              <option value="1h">1 hour</option>
            </select>
          </label>
        )}
        {model !== "recorded" && (
          <div className="sd-cost-scenario-result">
            <span>Estimated root-session cost</span>
            <strong>
              <span>
                {scenarioLoading
                  ? "Estimating…"
                  : scenario === undefined
                  ? "Unavailable"
                  : money.format(scenario.cost)}
              </span>
              {delta !== undefined && Math.abs(delta) > 0.00005 && (
                <span
                  className={`sd-cost-scenario-delta ${
                    delta > 0 ? "is-higher" : "is-lower"
                  }`}
                  title={`${money.format(Math.abs(delta))} ${
                    delta > 0 ? "more" : "less"
                  } than recorded`}
                >
                  ({delta > 0 ? "+" : "−"}
                  {money.format(Math.abs(delta))})
                </span>
              )}
            </strong>
            {scenario && (
              <div className="sd-cost-breakdown">
                <span>
                  Input <b>{money.format(scenario.breakdown.input)}</b>
                </span>
                <span>
                  Cache reads{" "}
                  <b>{money.format(scenario.breakdown.cacheRead)}</b>
                </span>
                <span>
                  Cache writes{" "}
                  <b>{money.format(scenario.breakdown.cacheWrite)}</b>
                </span>
                <span>
                  Output <b>{money.format(scenario.breakdown.output)}</b>
                </span>
              </div>
            )}
            {scenario?.hasUnpricedCost && (
              <small>Some calls could not be priced</small>
            )}
          </div>
        )}
        <p className="sd-scenario-note">
          Use this as a directional estimate. Another model or thinking level
          may make different calls or produce different output. Subagents are
          excluded.
        </p>
      </section>
    </aside>
  );
}

function LoadingSession() {
  return (
    <div className="sd-loading">
      <span className="sd-pixel-loader" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </span>
      <span>Reading session</span>
    </div>
  );
}

function DetailNavigation({
  backHref,
  theme,
  onThemeChange,
}: {
  backHref: string;
  theme: SessionTheme;
  onThemeChange: (theme: SessionTheme) => void;
}) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <nav className="sd-detail-nav" aria-label="Session navigation">
      <a
        className="sd-back"
        href={backHref}
        onClick={(event) => {
          if (
            event.button !== 0 || event.metaKey || event.ctrlKey ||
            event.shiftKey || event.altKey
          ) {
            return;
          }
          if (globalThis.history.length <= 1) return;
          event.preventDefault();
          globalThis.history.back();
        }}
      >
        <ArrowLeft size={14} />Sessions
      </a>
      <button
        className="sd-theme-toggle"
        type="button"
        aria-label={`Use ${nextTheme} theme`}
        aria-pressed={theme === "light"}
        onClick={() => onThemeChange(nextTheme)}
      >
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    </nav>
  );
}

export function SessionDetailPage() {
  const { harness, sessionId } = route.useParams();
  const { misses, paths, color, model, cacheTtl, branch } = route.useSearch();
  const navigate = route.useNavigate();
  const selectedModel = model === "recorded" ||
      counterfactualModelIDs.includes(
        model as typeof counterfactualModelIDs[number],
      )
    ? model
    : "recorded";
  const thinking = "recorded";
  const selectedCacheTtl = cacheTtl ?? "5m";
  const [session, setSession] = useState<SessionDetail>();
  const [costScenario, setCostScenario] = useState<CostScenarioResponse>();
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [ghosttyOpening, setGhosttyOpening] = useState(false);
  const [ghosttyError, setGhosttyError] = useState<string>();
  const [theme, setTheme] = useState<SessionTheme>(() =>
    localStorage.getItem(SESSION_THEME_KEY) === "dark" ? "dark" : "light"
  );
  const [collapsedTurnIDs, setCollapsedTurnIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [focusedCallAnchor, setFocusedCallAnchor] = useState<string>();

  useEffect(() => {
    if (!focusedCallAnchor) return;
    const timeout = globalThis.setTimeout(
      () => setFocusedCallAnchor(undefined),
      3000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [focusedCallAnchor]);

  useEffect(() => {
    let active = true;
    setSession(undefined);
    setError(undefined);
    getSession(sessionId, harness).then((result) => {
      if (active) {
        setSession(result);
        setCollapsedTurnIDs(defaultCollapsedTurnIDs(result));
      }
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load session",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [harness, sessionId]);

  useEffect(() => {
    if (selectedModel === "recorded") {
      setCostScenario(undefined);
      setScenarioLoading(false);
      return;
    }
    let active = true;
    setCostScenario(undefined);
    setScenarioLoading(true);
    getSessionCostScenario(sessionId, harness, selectedModel, selectedCacheTtl)
      .then((result) => {
        if (active) setCostScenario(result);
      })
      .catch(() => {
        if (active) setCostScenario(undefined);
      })
      .finally(() => {
        if (active) setScenarioLoading(false);
      });
    return () => {
      active = false;
    };
  }, [harness, selectedCacheTtl, selectedModel, sessionId]);

  const backQuery = new URLSearchParams({ harness });
  if (misses) backQuery.set("misses", misses);
  const backHref = `/?${backQuery}`;

  function changeTheme(nextTheme: SessionTheme) {
    setTheme(nextTheme);
    localStorage.setItem(SESSION_THEME_KEY, nextTheme);
  }

  async function openInGhostty() {
    setGhosttyOpening(true);
    setGhosttyError(undefined);
    try {
      await openSessionInGhostty(sessionId, harness);
    } catch (reason) {
      setGhosttyError(
        reason instanceof Error ? reason.message : "Unable to open Ghostty",
      );
    } finally {
      setGhosttyOpening(false);
    }
  }
  if (!session) {
    return (
      <main className={`session-detail-page is-${theme}`}>
        <DetailNavigation
          backHref={backHref}
          theme={theme}
          onThemeChange={changeTheme}
        />
        <div className="sd-shell">
          {error ? <div className="sd-error">{error}</div> : <LoadingSession />}
        </div>
      </main>
    );
  }

  const rootSession = session;
  const tree = sessionTree(session);
  const branches = session.branches ?? [];
  const branchesByID = new Map(branches.map((item) => [item.id, item]));
  const selectedBranch = branch ? branchesByID.get(branch) : undefined;
  const visibleTurnNumbers = selectedBranch
    ? new Set(branchPathTurns(selectedBranch, branchesByID))
    : undefined;
  const turnIDs = sessionTurnIDs(session);
  const turnsExpanded = turnIDs.every((id) => !collapsedTurnIDs.has(id));
  const calls = callsInTree(session);
  const tokens = inclusiveTokens(session);
  const input = contextSize(tokens);
  const reuse = input === 0 ? undefined : tokens.cacheRead / input;
  const bounds = sessionBounds(session);
  const workTime = sessionWorkTime(session);
  const activeDuration = estimatedActiveDuration(workTime.activeMilliseconds);
  const turnCount = tree.reduce((sum, item) => sum + item.turns.length, 0);
  const toolCount = calls.reduce(
    (sum, call) => sum + call.activity.tools.length,
    0,
  );
  const rootCost = session.computedCost ?? rollupCosts(
    session.turns.flatMap((turn) =>
      turn.calls.map((call) => call.computedCost)
    ),
  ).cost;
  const computed = rollupCosts(tree.map((item) => item.computedCost)).cost;
  const cost = session.inclusiveComputedCost ?? computed;
  const reportedCosts = tree.map((item) => item.reportedCost);
  const reportedCost = reportedCosts.every((item) => item !== undefined)
    ? reportedCosts.reduce((total, item) => total + item!, 0)
    : undefined;
  const subagents = tree.length - 1;
  const subagentCost = rollupCosts(
    tree.slice(1).map((item) => item.computedCost),
  );
  const subagentMissCost = tree.slice(1).reduce(
    (sum, item) => sum + (item.cacheMissCost ?? 0),
    0,
  );
  const hasCacheMisses = calls.some((call) =>
    call.cacheAssessment?.status === "partial-hit" ||
    call.cacheAssessment?.status === "full-miss"
  );
  const totalMissCost = !hasCacheMisses ||
      session.inclusiveCacheMissCost === undefined
    ? undefined
    : `${money.format(session.inclusiveCacheMissCost)}${
      session.inclusiveHasUnpricedCacheMissCost ? "+" : ""
    }`;
  const subagentHasMisses = tree.slice(1).some((item) =>
    item.turns.some((turn) =>
      turn.calls.some((call) =>
        call.cacheAssessment?.status === "partial-hit" ||
        call.cacheAssessment?.status === "full-miss"
      )
    )
  );
  const subagentMissesUnpriced = tree.slice(1).some((item) =>
    item.hasUnpricedCacheMissCost
  );
  const costDetail = subagents > 0
    ? subagentCost.cost === undefined
      ? "Subagents unpriced"
      : `${money.format(subagentCost.cost)}${
        subagentCost.hasUnpricedCost ? "+" : ""
      } subagents${
        subagentHasMisses
          ? ` (${money.format(subagentMissCost)}${
            subagentMissesUnpriced ? "+" : ""
          } miss cost)`
          : ""
      }`
    : totalMissCost === undefined
    ? undefined
    : `${totalMissCost} miss cost`;
  const canOpenInGhostty = Boolean(
    (session.harness === "pi" || session.harness === "opencode" ||
      session.harness === "claude-code" || session.harness === "codex") &&
      session.workingDirectory &&
      (session.harness !== "pi" || session.sourcePath),
  );
  function jumpToCall(occurrence: CallOccurrence) {
    if (selectedBranch) {
      void navigate({
        search: (current) => ({ ...current, branch: undefined }),
        replace: true,
        resetScroll: false,
      });
    }
    const callID = callAnchor(
      occurrence.session.id,
      occurrence.turn.number,
      occurrence.call.id,
    );
    const targetID = occurrence.jumpTarget === "turn"
      ? turnAnchor(occurrence.session.id, occurrence.turn.number)
      : callID;
    setFocusedCallAnchor(callID);
    const turnsToExpand = [
      ...(subagentLaunchTurnPath(rootSession, occurrence.session.id) ?? []),
      turnAnchor(occurrence.session.id, occurrence.turn.number),
    ];
    setCollapsedTurnIDs((current) => {
      const next = new Set(current);
      turnsToExpand.forEach((id) => next.delete(id));
      return next;
    });
    let attempts = 0;
    const focusTarget = () => {
      const target = document.getElementById(targetID);
      const transcript = target?.closest<HTMLElement>(
        ".sd-transcript:not(.is-nested)",
      );
      if (target && transcript) {
        const top = transcript.scrollTop + target.getBoundingClientRect().top -
          transcript.getBoundingClientRect().top - 16;
        transcript.scrollTo({ behavior: "smooth", top });
        target.focus({ preventScroll: true });
      } else if (attempts++ < 20) {
        globalThis.setTimeout(focusTarget, 50);
      }
    };
    requestAnimationFrame(focusTarget);
  }

  const rootBreadcrumbs = breadcrumbEntries(
    session,
    color,
    "recorded",
    thinking,
    collapsedTurnIDs,
    visibleTurnNumbers,
  ).filter((entry) => entry.depth === 0);
  const rootValues = rootBreadcrumbs.map((entry) => entry.value);
  const turnColors = new Map(
    color === "none" ? [] : rootBreadcrumbs.map((entry) => [
      entry.id,
      breadcrumbColor(entry.value, rootValues, true),
    ]),
  );
  return (
    <main className={`session-detail-page is-${theme}`}>
      <DetailNavigation
        backHref={backHref}
        theme={theme}
        onThemeChange={changeTheme}
      />
      <div className="sd-shell">
        <header className="sd-session-header">
          <div className="sd-session-title-row">
            <span className="sd-session-harness">
              <HarnessMark harness={session.harness} />
            </span>
            <h1>{session.title}</h1>
          </div>
          {branches.length > 1 && (
            <BranchControl
              branches={branches}
              session={session}
              model="recorded"
              thinking={thinking}
              selected={selectedBranch}
              onSelect={(branchID) =>
                navigate({
                  search: (current) => ({ ...current, branch: branchID }),
                  replace: true,
                  resetScroll: false,
                })}
            />
          )}
        </header>

        <div className="sd-metrics">
          <DetailMetric
            label="Elapsed"
            value={elapsed(bounds.start, bounds.end) ?? "Unavailable"}
            detail={activeDuration === undefined
              ? undefined
              : `${activeDuration} estimated work · ${
                integer.format(workTime.blocks)
              } block${workTime.blocks === 1 ? "" : "s"}`}
            detailTitle="Estimated from interaction cadence. It may include up to five minutes before the first recorded turn and inferred work between nearby turns."
          />
          <DetailMetric
            label="Activity"
            value={`${integer.format(turnCount)} turns`}
            detail={`${integer.format(calls.length)} calls · ${
              integer.format(toolCount)
            } tools`}
          />
          <DetailMetric
            label="Processed input"
            value={compact.format(input)}
            detail={[
              session.harness === "claude-code"
                ? undefined
                : `${compact.format(tokens.uncachedInput)} uncached`,
              reuse === undefined
                ? "Reuse unavailable"
                : `${(reuse * 100).toFixed(1)}% reused`,
              (tokens.cacheWrite ?? 0) > 0
                ? `${compact.format(tokens.cacheWrite ?? 0)} written`
                : undefined,
            ].filter(Boolean).join(" · ")}
          />
          <DetailMetric
            label="Output"
            value={compact.format(tokens.output)}
            detail={tokens.reasoning > 0
              ? `${compact.format(tokens.reasoning)} reasoning`
              : undefined}
          />
          <DetailMetric
            label="Cost"
            value={
              <span className="sd-cost-total-line">
                <CostIntegrityValue
                  reported={session.inclusiveReportedCost ?? reportedCost}
                  computed={cost}
                />
                {totalMissCost !== undefined && subagents > 0 && (
                  <span className="sd-cost-miss-inline">
                    ({totalMissCost} miss cost)
                  </span>
                )}
              </span>
            }
            detail={costDetail}
          />
        </div>

        <TurnCollapseContext.Provider
          value={{
            collapsedTurnIDs,
            turnColors,
            model: "recorded",
            thinking,
            focusedCallAnchor,
            toggleTurn: (id) =>
              setCollapsedTurnIDs((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              }),
          }}
        >
          <div className="sd-layout">
            <SessionNavigator
              session={session}
              metric={color}
              model="recorded"
              thinking={thinking}
              visibleTurnNumbers={visibleTurnNumbers}
            />
            <SessionTranscript
              session={session}
              pathMode={paths}
              rootDirectory={session.workingDirectory}
              visibleTurnNumbers={visibleTurnNumbers}
              focusedBranch={selectedBranch}
            />
            <Metadata
              session={session}
              pathMode={paths}
              colorMetric={color}
              model={selectedModel}
              scenario={costScenario}
              scenarioLoading={scenarioLoading}
              cacheTtl={selectedCacheTtl}
              actualCost={rootCost}
              workTime={workTime}
              turnsExpanded={turnsExpanded}
              onToggleAllTurns={() =>
                setCollapsedTurnIDs(
                  turnsExpanded ? new Set(turnIDs) : new Set(),
                )}
              onPathModeChange={(value) =>
                navigate({
                  search: (current) => ({ ...current, paths: value }),
                  replace: true,
                  resetScroll: false,
                })}
              onColorMetricChange={(value) =>
                navigate({
                  search: (current) => ({ ...current, color: value }),
                  replace: true,
                  resetScroll: false,
                })}
              onModelChange={(value) =>
                navigate({
                  search: (current) => ({ ...current, model: value }),
                  replace: true,
                  resetScroll: false,
                })}
              onCacheTtlChange={(value) =>
                navigate({
                  search: (current) => ({ ...current, cacheTtl: value }),
                  replace: true,
                  resetScroll: false,
                })}
              onJumpToCall={jumpToCall}
              canOpenInGhostty={canOpenInGhostty}
              ghosttyOpening={ghosttyOpening}
              ghosttyError={ghosttyError}
              onOpenInGhostty={openInGhostty}
            />
          </div>
        </TurnCollapseContext.Provider>
      </div>
    </main>
  );
}
