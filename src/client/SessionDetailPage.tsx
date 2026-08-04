import {
  createContext,
  type CSSProperties,
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
  CircleAlert,
  FileText,
  Image,
  Sparkles,
  TerminalSquare,
  User,
  Wrench,
  X,
} from "lucide-react";
import type {
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";
import { canonicalModelId, displayModelName } from "../shared/modelNames.ts";
import { rollupCosts } from "../shared/costMetrics.ts";
import {
  computeModelCallCost,
  counterfactualModelIDs,
} from "../shared/modelPricing.ts";
import { getSession } from "./api.ts";
import claudeCodeIcon from "./assets/icons/claudecode-color.svg";
import codexIcon from "./assets/icons/codex-logo-light.svg";
import openCodeIcon from "./assets/icons/opencode-logo-light.svg";
import piIcon from "./assets/icons/pi-logo.svg";
import "./SessionDetailPage.css";

const route = getRouteApi("/sessions/$harness/$sessionId");

type PathMode = "absolute" | "relative";
type ColorMetric = "none" | "time" | "cost" | "input" | "output";
type CostScenario = "recorded" | string;

const TurnCollapseContext = createContext<{
  collapsedTurnIDs: Set<string>;
  turnColors: Map<string, string>;
  toggleTurn: (id: string) => void;
}>({
  collapsedTurnIDs: new Set(),
  turnColors: new Map(),
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
  maximumFractionDigits: 4,
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

function harnessName(harness: SessionDetail["harness"]) {
  if (harness === "claude-code") return "Claude Code";
  if (harness === "codex") return "Codex";
  if (harness === "pi") return "PI";
  return "OpenCode";
}

function HarnessMark({ harness }: { harness: SessionDetail["harness"] }) {
  const src = harness === "claude-code"
    ? claudeCodeIcon
    : harness === "codex"
    ? codexIcon
    : harness === "pi"
    ? piIcon
    : openCodeIcon;
  return <img className="sd-harness-mark" src={src} alt="" />;
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

function DetailMetric({ label, value, detail }: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="sd-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
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
        <ChevronDown className="sd-disclosure-chevron" size={14} />
      </button>
      <div className="sd-disclosure-grid">
        <div>
          <div className="sd-disclosure-content">{children}</div>
        </div>
      </div>
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
  if (metric === "cost") return "Cost";
  if (metric === "input") return "Input processed";
  if (metric === "output") return "Output";
  return "Time spent";
}

function breadcrumbMetric(
  calls: ModelCall[],
  duration: number,
  metric: ColorMetric,
  model: CostScenario,
  thinking: string,
) {
  const cost = scenarioCost(calls, model, thinking).cost ?? 0;
  const input = calls.reduce((sum, call) => sum + call.tokens.processed, 0);
  const output = calls.reduce(
    (sum, call) => sum + call.tokens.output + call.tokens.reasoning,
    0,
  );
  const value = metric === "cost"
    ? cost
    : metric === "input"
    ? input
    : metric === "output"
    ? output
    : duration;
  const formattedValue = metric === "cost"
    ? money.format(cost)
    : metric === "input" || metric === "output"
    ? `${compact.format(value)} tokens`
    : elapsed(0, duration) ?? "Unavailable";
  return { value, formattedValue };
}

function breadcrumbEntries(
  session: SessionDetail,
  metric: ColorMetric,
  model: CostScenario,
  thinking: string,
  collapsedTurnIDs: Set<string>,
): BreadcrumbEntry[] {
  return session.turns.flatMap((turn) => {
    const childIDs = new Set(
      turn.calls.flatMap((call) =>
        call.activity.tools.flatMap((tool) =>
          tool.childSessionID ? [tool.childSessionID] : []
        )
      ),
    );
    const children = session.subagents.filter((child) =>
      childIDs.has(child.id)
    );
    const calls = [...turn.calls, ...children.flatMap(callsInTree)];
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
}: {
  session: SessionDetail;
  metric: ColorMetric;
  model: CostScenario;
  thinking: string;
}) {
  const { collapsedTurnIDs } = useContext(TurnCollapseContext);
  const entries = breadcrumbEntries(
    session,
    metric,
    model,
    thinking,
    collapsedTurnIDs,
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

function cacheLabel(call: ModelCall) {
  const assessment = call.cacheAssessment;
  if (!assessment) return undefined;
  if (assessment.cause === "ttl") return "TTL miss";
  if (assessment.cause === "thinking-change") return "Thinking change";
  if (assessment.cause === "compaction") return "Compaction miss";
  if (assessment.status === "full-miss") return "Full miss";
  if (assessment.status === "partial-hit") return "Partial hit";
  if (assessment.status === "hit") return "Cache hit";
  return undefined;
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
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(tool.inputPreview || tool.outputPreview || child);
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
        <strong>{tool.name}</strong>
        {target && <code>{target}</code>}
        <small>
          {elapsed(tool.startedAt, tool.completedAt) ?? tool.status}
        </small>
        {hasDetails && <ChevronDown size={13} />}
      </button>
      {hasDetails && (
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

function ReasoningDisclosure({ call }: { call: ModelCall }) {
  const [open, setOpen] = useState(false);
  const hasReasoning = call.activity.hasReasoning ||
    call.tokens.reasoning > 0 ||
    call.reasoningSetting !== undefined;
  if (!hasReasoning) return null;
  const callDuration = elapsed(call.startedAt, call.completedAt);
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((current) => !current)}
      icon={<Sparkles size={15} />}
      label={callDuration ? `Thought for ${callDuration}` : "Reasoning trace"}
      className="sd-thinking"
    >
      <div className="sd-thinking-trace">
        <span>
          <Brain size={13} />
          {integer.format(call.tokens.reasoning)} reasoning tokens
        </span>
        {call.reasoningSetting && (
          <span>
            <Sparkles size={13} />Thinking: {call.reasoningSetting.settingValue}
          </span>
        )}
        <span>
          <TerminalSquare size={13} />
          {displayModelName(call.model)}
        </span>
        <small>Reasoning content is not retained by this harness.</small>
      </div>
    </Disclosure>
  );
}

function ContextEvents({ call }: { call: ModelCall }) {
  const events = call.contextEventsBefore ?? [];
  if (events.length === 0) return null;
  return (
    <div className="sd-context-events">
      {events.map((event) => (
        <span key={`${event.sourceOrder}-${event.type}`}>
          <CircleAlert size={12} />
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
      ))}
    </div>
  );
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
  const input = contextSize(call.tokens);
  const assessment = cacheLabel(call);
  return (
    <section
      className="sd-call"
      id={callAnchor(session.id, turnNumber, call.id)}
    >
      <div className="sd-call-heading">
        <span className="sd-agent-avatar">
          <Bot size={13} />
        </span>
        <strong>{displayModelName(call.model)}</strong>
        <span>Call {call.callWithinTurn}</span>
        <span>
          {elapsed(call.startedAt, call.completedAt) ?? "Timing unavailable"}
        </span>
        {effort && <em className="sd-call-effort">{effort}</em>}
        {assessment && <b>{assessment}</b>}
      </div>
      <div className="sd-call-body">
        <ContextEvents call={call} />
        <ReasoningDisclosure call={call} />
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
          <span>{compact.format(call.tokens.output)} output</span>
          <span>
            {call.computedCost === undefined
              ? "Unpriced"
              : money.format(call.computedCost)}
          </span>
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
  const { collapsedTurnIDs, toggleTurn, turnColors } = useContext(
    TurnCollapseContext,
  );
  const id = turnAnchor(session.id, turn.number);
  const collapsed = collapsedTurnIDs.has(id);
  const turnColor = turnColors.get(id);
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
  const [open, setOpen] = useState(false);
  const calls = callsInTree(session).length;
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((current) => !current)}
      icon={<Bot size={14} />}
      label={session.agent ?? "Subagent"}
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

function SessionTranscript({
  session,
  depth = 0,
  pathMode,
  rootDirectory,
}: {
  session: SessionDetail;
  depth?: number;
  pathMode: PathMode;
  rootDirectory?: string;
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
  return (
    <div className={`sd-transcript${depth > 0 ? " is-nested" : ""}`}>
      {session.turns.map((turn) => (
        <TurnBlock
          key={turn.number}
          turn={turn}
          session={session}
          depth={depth}
          pathMode={pathMode}
          rootDirectory={rootDirectory}
        />
      ))}
      {unlinkedSubagents.map((child) => (
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

function Metadata({
  session,
  pathMode,
  colorMetric,
  model,
  thinking,
  estimatedCost,
  estimateIncomplete,
  actualCost,
  onPathModeChange,
  onColorMetricChange,
  onModelChange,
  onThinkingChange,
}: {
  session: SessionDetail;
  pathMode: PathMode;
  colorMetric: ColorMetric;
  model: CostScenario;
  thinking: string;
  estimatedCost?: number;
  estimateIncomplete: boolean;
  actualCost?: number;
  onPathModeChange: (value: PathMode) => void;
  onColorMetricChange: (value: ColorMetric) => void;
  onModelChange: (value: CostScenario) => void;
  onThinkingChange: (value: string) => void;
}) {
  const tokens = inclusiveTokens(session);
  const calls = callsInTree(session);
  const cacheInput = tokens.uncachedInput + tokens.cacheRead +
    (tokens.cacheWrite ?? 0);
  const reuse = cacheInput === 0 ? undefined : tokens.cacheRead / cacheInput;
  const cacheMisses =
    calls.filter((call) =>
      call.cacheAssessment?.status === "partial-hit" ||
      call.cacheAssessment?.status === "full-miss"
    ).length;
  const observedThinking = [
    ...(session.thinking?.values ?? []),
    ...calls.flatMap((call) =>
      call.reasoningSetting ? [call.reasoningSetting.settingValue] : []
    ),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const openAIModels = counterfactualModelIDs.filter((value) =>
    value.startsWith("gpt-")
  );
  const anthropicModels = counterfactualModelIDs.filter((value) =>
    value.startsWith("claude-")
  );
  const otherModels = counterfactualModelIDs.filter((value) =>
    !value.startsWith("gpt-") && !value.startsWith("claude-")
  );
  const delta = estimatedCost === undefined || actualCost === undefined
    ? undefined
    : estimatedCost - actualCost;
  return (
    <aside className="sd-metadata">
      <section>
        <h2>Run</h2>
        <MetadataRow label="Harness">
          {harnessName(session.harness)}
        </MetadataRow>
        <MetadataRow label="Agent">{session.agent ?? "Default"}</MetadataRow>
        <MetadataRow label="Session ID" mono>{session.id}</MetadataRow>
        {session.workingDirectory && (
          <MetadataRow label="Working directory" mono>
            {session.workingDirectory}
          </MetadataRow>
        )}
        {session.sourcePath && (
          <MetadataRow label="Source" mono>{session.sourcePath}</MetadataRow>
        )}
      </section>
      <section>
        <h2>Models</h2>
        <div className="sd-model-list">
          {session.models.map((model) => (
            <span key={model}>{displayModelName(model)}</span>
          ))}
        </div>
      </section>
      <section>
        <h2>Context</h2>
        <MetadataRow label="Latest">
          {session.contextLatest === undefined
            ? "Unavailable"
            : compact.format(session.contextLatest)}
        </MetadataRow>
        <MetadataRow label="Peak">
          {session.contextPeak === undefined
            ? "Unavailable"
            : compact.format(session.contextPeak)}
        </MetadataRow>
        <MetadataRow label="Token reuse">
          {reuse === undefined ? "Unavailable" : `${(reuse * 100).toFixed(1)}%`}
        </MetadataRow>
        <MetadataRow label="Cache misses">
          {integer.format(cacheMisses)}
        </MetadataRow>
      </section>
      <section>
        <h2>View</h2>
        <label className="sd-setting">
          <span>Paths</span>
          <span className="sd-setting-segmented">
            {(["absolute", "relative"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={pathMode === value ? "is-active" : undefined}
                aria-pressed={pathMode === value}
                onClick={() => onPathModeChange(value)}
              >
                {value === "absolute" ? "Full" : "Relative"}
              </button>
            ))}
          </span>
        </label>
        <label className="sd-setting">
          <span>Turn color</span>
          <select
            value={colorMetric}
            onChange={(event) =>
              onColorMetricChange(event.target.value as ColorMetric)}
          >
            <option value="none">None</option>
            <option value="time">Time spent</option>
            <option value="cost">Cost</option>
            <option value="input">Input processed</option>
            <option value="output">Output</option>
          </select>
        </label>
      </section>
      <section>
        <h2>Cost scenario</h2>
        <label className="sd-setting">
          <span>Model</span>
          <select
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="recorded">Recorded models</option>
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
        <label className="sd-setting">
          <span>Thinking</span>
          <select
            value={thinking}
            onChange={(event) => onThinkingChange(event.target.value)}
          >
            <option value="recorded">
              Recorded{session.thinking?.latest
                ? ` (${session.thinking.latest})`
                : ""}
            </option>
            <option value="off">Off</option>
            {observedThinking.filter((value) => value !== "off").map((
              value,
            ) => (
              <option key={value} value={`level:${value}`}>
                {value} (same tokens)
              </option>
            ))}
          </select>
        </label>
        <div className="sd-cost-scenario-result">
          <span>Estimated cost</span>
          <strong>
            {estimatedCost === undefined
              ? "Unavailable"
              : money.format(estimatedCost)}
          </strong>
          {delta !== undefined && Math.abs(delta) > 0.00005 && (
            <small className={delta > 0 ? "is-higher" : "is-lower"}>
              {delta > 0 ? "+" : "−"}
              {money.format(Math.abs(delta))} vs recorded
            </small>
          )}
          {estimateIncomplete && <small>Some calls could not be priced</small>}
        </div>
        <p className="sd-scenario-note">
          Non-off thinking levels retain the recorded reasoning tokens.
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

function DetailNavigation({ backHref }: { backHref: string }) {
  return (
    <nav className="sd-detail-nav" aria-label="Session navigation">
      <a className="sd-back" href={backHref}>
        <ArrowLeft size={14} />Sessions
      </a>
    </nav>
  );
}

export function SessionDetailPage() {
  const { harness, sessionId } = route.useParams();
  const { misses, paths, color, model, thinking } = route.useSearch();
  const navigate = route.useNavigate();
  const [session, setSession] = useState<SessionDetail>();
  const [error, setError] = useState<string>();
  const [collapsedTurnIDs, setCollapsedTurnIDs] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let active = true;
    setSession(undefined);
    setError(undefined);
    getSession(sessionId, harness).then((result) => {
      if (active) {
        setSession(result);
        setCollapsedTurnIDs(new Set());
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

  const backQuery = new URLSearchParams({ harness });
  if (misses) backQuery.set("misses", misses);
  const backHref = `/?${backQuery}`;
  if (!session) {
    return (
      <main className="session-detail-page">
        <DetailNavigation backHref={backHref} />
        <div className="sd-shell">
          {error ? <div className="sd-error">{error}</div> : <LoadingSession />}
        </div>
      </main>
    );
  }

  const tree = sessionTree(session);
  const calls = callsInTree(session);
  const tokens = inclusiveTokens(session);
  const bounds = sessionBounds(session);
  const computed = rollupCosts(tree.map((item) => item.computedCost)).cost;
  const cost = session.inclusiveComputedCost ?? computed;
  const subagents = tree.length - 1;
  const selectedModel = model === "recorded" ||
      counterfactualModelIDs.includes(
        model as typeof counterfactualModelIDs[number],
      )
    ? model
    : "recorded";
  const estimate = scenarioCost(calls, selectedModel, thinking);
  const scenarioChanged = selectedModel !== "recorded" ||
    thinking !== "recorded";
  const estimatedCost = scenarioChanged ? estimate.cost : cost;
  const costDelta = estimatedCost === undefined || cost === undefined
    ? undefined
    : estimatedCost - cost;
  const scenarioDetail = scenarioChanged
    ? [
      selectedModel === "recorded"
        ? "Recorded models"
        : displayModelName(selectedModel),
      thinking === "off"
        ? "thinking off"
        : thinking.startsWith("level:")
        ? `thinking ${thinking.slice("level:".length)}`
        : undefined,
      costDelta === undefined
        ? undefined
        : `${costDelta >= 0 ? "+" : "−"}${money.format(Math.abs(costDelta))}`,
    ].filter(Boolean).join(" · ")
    : subagents > 0
    ? `${subagents} subagent${subagents === 1 ? "" : "s"}`
    : undefined;
  const rootBreadcrumbs = breadcrumbEntries(
    session,
    color,
    selectedModel,
    thinking,
    collapsedTurnIDs,
  ).filter((entry) => entry.depth === 0);
  const rootValues = rootBreadcrumbs.map((entry) => entry.value);
  const turnColors = new Map(
    color === "none" ? [] : rootBreadcrumbs.map((entry) => [
      entry.id,
      breadcrumbColor(entry.value, rootValues, true),
    ]),
  );
  return (
    <main className="session-detail-page">
      <DetailNavigation backHref={backHref} />
      <div className="sd-shell">
        <header className="sd-session-header">
          <div className="sd-session-title-row">
            <span className="sd-session-harness">
              <HarnessMark harness={session.harness} />
            </span>
            <div>
              <span className="sd-kicker">
                {harnessName(session.harness)} session
              </span>
              <h1>{session.title}</h1>
            </div>
          </div>
          <div className="sd-session-badges">
            <span>
              <Check size={12} />Archived
            </span>
            {session.thinking?.latest && (
              <span>
                <Sparkles size={12} />Thinking {session.thinking.latest}
              </span>
            )}
          </div>
        </header>

        <div className="sd-metrics">
          <DetailMetric
            label="Elapsed"
            value={elapsed(bounds.start, bounds.end) ?? "Unavailable"}
            detail={bounds.start === undefined
              ? undefined
              : timestamp.format(bounds.start)}
          />
          <DetailMetric
            label="Activity"
            value={`${integer.format(calls.length)} calls`}
            detail={`${
              integer.format(
                tree.reduce((sum, item) => sum + item.turns.length, 0),
              )
            } turns`}
          />
          <DetailMetric
            label="Input processed"
            value={compact.format(tokens.processed)}
            detail={`${compact.format(tokens.cacheRead)} cached`}
          />
          <DetailMetric
            label="Output"
            value={compact.format(tokens.output)}
            detail={tokens.reasoning > 0
              ? `${compact.format(tokens.reasoning)} reasoning`
              : undefined}
          />
          <DetailMetric
            label={scenarioChanged ? "Estimated cost" : "Cost"}
            value={estimatedCost === undefined
              ? "Unpriced"
              : money.format(estimatedCost)}
            detail={scenarioDetail}
          />
        </div>

        <TurnCollapseContext.Provider
          value={{
            collapsedTurnIDs,
            turnColors,
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
              model={selectedModel}
              thinking={thinking}
            />
            <SessionTranscript
              session={session}
              pathMode={paths}
              rootDirectory={session.workingDirectory}
            />
            <Metadata
              session={session}
              pathMode={paths}
              colorMetric={color}
              model={selectedModel}
              thinking={thinking}
              estimatedCost={estimatedCost}
              estimateIncomplete={scenarioChanged && estimate.hasUnpricedCost}
              actualCost={cost}
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
              onThinkingChange={(value) =>
                navigate({
                  search: (current) => ({ ...current, thinking: value }),
                  replace: true,
                  resetScroll: false,
                })}
            />
          </div>
        </TurnCollapseContext.Provider>
      </div>
    </main>
  );
}
