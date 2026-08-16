import type {
  CostScenarioResponse,
  ModelCall,
  SessionDetail,
  TokenUsage,
} from "../shared/sessionSchemas.ts";
import { contextSize, hasInputContext } from "../shared/contextMetrics.ts";
import { canonicalModelId } from "../shared/modelNames.ts";
import {
  computeModelCallCostBreakdown,
  type ModelCallCostBreakdown,
  modelRateCard,
} from "../shared/modelPricing.ts";
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS } from "./cacheAnalysis.ts";

export type ScenarioCacheTtl = "5m" | "1h";

const emptyBreakdown = (): ModelCallCostBreakdown => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
});

function targetProvider(model: string) {
  const canonical = canonicalModelId(model);
  if (canonical.startsWith("claude-")) return "anthropic";
  if (canonical.startsWith("gpt-")) return "openai";
  return undefined;
}

function anthropicScenarioTokens(
  call: ModelCall,
  previous: ModelCall | undefined,
  cacheTtl: ScenarioCacheTtl,
): TokenUsage {
  const currentContext = contextSize(call.tokens);
  if (!hasInputContext(call.tokens) || currentContext === 0) return call.tokens;

  const ttl = cacheTtl === "1h" ? CACHE_TTL_1H_MS : CACHE_TTL_5M_MS;
  const gap = previous === undefined
    ? undefined
    : call.startedAt - previous.startedAt;
  const cacheAlive = previous !== undefined && gap !== undefined && gap >= 0 &&
    gap < ttl;
  const previousReusable = previous === undefined
    ? 0
    : previous.tokens.cacheRead + (previous.tokens.cacheWrite ?? 0);
  const expectedReusable = Math.min(previousReusable, currentContext);
  let cacheRead = previous === undefined
    ? Math.min(call.tokens.cacheRead, currentContext)
    : 0;
  if (cacheAlive) {
    const assessment = call.cacheAssessment;
    const preserveObservedMiss = assessment?.cause !== "ttl" &&
      assessment?.reason !== "model-change" &&
      (assessment?.status === "partial-hit" ||
        assessment?.status === "full-miss");
    cacheRead = preserveObservedMiss
      ? Math.min(call.tokens.cacheRead, expectedReusable)
      : expectedReusable;
  }
  const recordedAnthropic = call.provider.toLowerCase().includes("anthropic") ||
    canonicalModelId(call.model).startsWith("claude-");
  const uncachedInput = recordedAnthropic
    ? Math.min(call.tokens.uncachedInput, currentContext - cacheRead)
    : 0;
  const cacheWrite = Math.max(0, currentContext - cacheRead - uncachedInput);
  return {
    ...call.tokens,
    uncachedInput,
    cacheRead,
    cacheWrite,
    cacheWrite5m: cacheTtl === "5m" ? cacheWrite : 0,
    cacheWrite1h: cacheTtl === "1h" ? cacheWrite : 0,
  };
}

function genericScenarioTokens(call: ModelCall, model: string): TokenUsage {
  const rates = modelRateCard(model, call.startedAt, contextSize(call.tokens));
  const cacheWrite = call.tokens.cacheWrite ?? 0;
  if (
    cacheWrite === 0 || rates?.cacheWrite !== undefined ||
    rates?.cacheWrite5m !== undefined || rates?.cacheWrite1h !== undefined
  ) return call.tokens;
  return {
    ...call.tokens,
    uncachedInput: call.tokens.uncachedInput + cacheWrite,
    cacheWrite: undefined,
    cacheWrite5m: undefined,
    cacheWrite1h: undefined,
  };
}

function callsForScenario(
  session: SessionDetail,
  model: string,
  cacheTtl: ScenarioCacheTtl,
) {
  const calls = session.turns.flatMap((turn) => turn.calls);
  const scenarioCallsByID = new Map<string, ModelCall>();
  let sequentialPrevious: ModelCall | undefined;
  const anthropic = canonicalModelId(model).startsWith("claude-");
  const selectedWriteKey = cacheTtl === "1h" ? "cacheWrite1h" : "cacheWrite5m";
  const otherWriteKey = cacheTtl === "1h" ? "cacheWrite5m" : "cacheWrite1h";
  const preserveRecordedAnthropicBilling = anthropic && calls.length > 0 &&
    calls.every((call) =>
      canonicalModelId(call.model) === canonicalModelId(model)
    ) &&
    calls.some((call) => (call.tokens[selectedWriteKey] ?? 0) > 0) &&
    calls.every((call) =>
      (call.tokens.cacheWrite ?? 0) === 0 ||
      ((call.tokens[selectedWriteKey] ?? 0) === call.tokens.cacheWrite &&
        (call.tokens[otherWriteKey] ?? 0) === 0)
    );
  return calls.map((call) => {
    const previous = call.predecessorResolved
      ? call.previousCallID === undefined
        ? undefined
        : scenarioCallsByID.get(call.previousCallID)
      : sequentialPrevious;
    const tokens = preserveRecordedAnthropicBilling
      ? call.tokens
      : anthropic
      ? anthropicScenarioTokens(call, previous, cacheTtl)
      : genericScenarioTokens(call, model);
    const scenarioCall = { ...call, model, tokens };
    scenarioCallsByID.set(call.id, scenarioCall);
    if (hasInputContext(call.tokens)) sequentialPrevious = scenarioCall;
    return { call, tokens };
  });
}

export function estimateSessionCostScenario(
  session: SessionDetail,
  model: string,
  cacheTtl: ScenarioCacheTtl = "5m",
): CostScenarioResponse {
  const breakdown = emptyBreakdown();
  let hasUnpricedCost = false;
  for (const { call, tokens } of callsForScenario(session, model, cacheTtl)) {
    const cost = computeModelCallCostBreakdown(
      tokens,
      model,
      call.startedAt,
      targetProvider(model),
    );
    if (cost === undefined) {
      hasUnpricedCost = true;
      continue;
    }
    breakdown.input += cost.input;
    breakdown.cacheRead += cost.cacheRead;
    breakdown.cacheWrite += cost.cacheWrite;
    breakdown.output += cost.output;
  }
  return {
    model,
    ...(canonicalModelId(model).startsWith("claude-") ? { cacheTtl } : {}),
    cost: breakdown.input + breakdown.cacheRead + breakdown.cacheWrite +
      breakdown.output,
    hasUnpricedCost,
    breakdown,
  };
}
