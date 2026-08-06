import { deepStrictEqual } from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { SessionSummary } from "../shared/sessionSchemas.ts";
import type { SessionRepository } from "./sessionRepository.ts";
import { ConversationCompatibilityRepository } from "./conversationCompatibilityRepository.ts";

export function assertLinearConversationParity(
  db: DatabaseSync,
  harness: SessionSummary["harness"],
) {
  const legacySessions = db.prepare(`
    SELECT ss.external_id, s.title, ss.working_directory, s.updated_at,
      s.started_at, s.ended_at, s.providers_json, s.models_json, s.user_turns,
      s.model_calls, s.reported_cost, s.uncached_input_tokens,
      s.cache_read_tokens, s.cache_write_tokens, s.cache_write_5m_tokens,
      s.cache_write_1h_tokens, s.fresh_prompt_tokens, s.output_tokens,
      s.reasoning_tokens, s.processed_tokens
    FROM sessions s
    JOIN source_sessions ss ON ss.id = s.source_session_id
    JOIN sources so ON so.id = ss.source_id
    WHERE so.harness = ?
    ORDER BY ss.external_id
  `).all(harness).map((row) => ({ ...row }));
  const v2Sessions = db.prepare(`
    SELECT c.external_id, c.title, c.working_directory, c.updated_at,
      c.started_at, c.ended_at, c.providers_json, c.models_json, cr.user_turns,
      cr.model_calls, cr.reported_cost, cr.uncached_input_tokens,
      cr.cache_read_tokens, cr.cache_write_tokens, cr.cache_write_5m_tokens,
      cr.cache_write_1h_tokens, cr.fresh_prompt_tokens, cr.output_tokens,
      cr.reasoning_tokens, cr.processed_tokens
    FROM conversations c
    JOIN sources so ON so.id = c.source_id
    JOIN conversation_rollups cr ON cr.conversation_id = c.id
    WHERE so.harness = ?
    ORDER BY c.external_id
  `).all(harness).map((row) => ({ ...row }));
  deepStrictEqual(v2Sessions, legacySessions);

  const legacyTurns = db.prepare(`
    SELECT ss.external_id, t.ordinal, t.started_at
    FROM turns t
    JOIN source_sessions ss ON ss.id = t.session_id
    JOIN sources so ON so.id = ss.source_id
    WHERE so.harness = ?
    ORDER BY ss.external_id, t.ordinal
  `).all(harness).map((row) => ({ ...row }));
  const v2Turns = db.prepare(`
    SELECT c.external_id, ct.ordinal, ct.started_at
    FROM conversation_turns ct
    JOIN conversations c ON c.id = ct.conversation_id
    JOIN sources so ON so.id = c.source_id
    WHERE so.harness = ?
    ORDER BY c.external_id, ct.ordinal
  `).all(harness).map((row) => ({ ...row }));
  deepStrictEqual(v2Turns, legacyTurns);

  const legacyCalls = db.prepare(`
    SELECT ss.external_id, t.ordinal AS turn_ordinal,
      mc.ordinal AS call_within_turn, mc.source_call_id, m.provider, m.name AS model,
      mc.started_at, mc.completed_at, mc.reported_cost,
      mc.uncached_input_tokens, mc.cache_read_tokens, mc.cache_write_tokens,
      mc.cache_write_5m_tokens, mc.cache_write_1h_tokens,
      mc.fresh_prompt_tokens, mc.output_tokens, mc.reasoning_tokens,
      mc.processed_tokens, mc.finish_reason, mc.images, mc.has_text,
      mc.has_reasoning
    FROM model_calls mc
    JOIN turns t ON t.id = mc.turn_id
    JOIN source_sessions ss ON ss.id = t.session_id
    JOIN sources so ON so.id = ss.source_id
    JOIN models m ON m.id = mc.model_id
    WHERE so.harness = ?
    ORDER BY ss.external_id, t.ordinal, mc.ordinal
  `).all(harness).map((row) => ({ ...row }));
  const v2Calls = db.prepare(`
    SELECT c.external_id, ct.ordinal AS turn_ordinal,
      cmc.call_within_turn, cmc.source_call_id, cmc.provider, cmc.model,
      cmc.started_at, cmc.completed_at, cmc.reported_cost,
      cmc.uncached_input_tokens, cmc.cache_read_tokens, cmc.cache_write_tokens,
      cmc.cache_write_5m_tokens, cmc.cache_write_1h_tokens,
      cmc.fresh_prompt_tokens, cmc.output_tokens, cmc.reasoning_tokens,
      cmc.processed_tokens, cmc.finish_reason, cmc.images, cmc.has_text,
      cmc.has_reasoning
    FROM conversation_model_calls cmc
    JOIN conversation_turns ct ON ct.id = cmc.turn_id
    JOIN conversations c ON c.id = cmc.conversation_id
    JOIN sources so ON so.id = c.source_id
    WHERE so.harness = ?
    ORDER BY c.external_id, ct.ordinal, cmc.call_within_turn
  `).all(harness).map((row) => ({ ...row }));
  deepStrictEqual(v2Calls, legacyCalls);

  const legacyTools = db.prepare(`
    SELECT ss.external_id, t.ordinal AS turn_ordinal,
      mc.ordinal AS call_within_turn, te.ordinal, te.source_tool_id, te.name,
      te.status, te.started_at, te.completed_at, te.input_preview,
      te.input_original_length, te.input_truncated, te.output_preview,
      te.output_original_length, te.output_truncated
    FROM tool_events te
    JOIN model_calls mc ON mc.id = te.model_call_id
    JOIN turns t ON t.id = mc.turn_id
    JOIN source_sessions ss ON ss.id = t.session_id
    JOIN sources so ON so.id = ss.source_id
    WHERE so.harness = ?
    ORDER BY ss.external_id, t.ordinal, mc.ordinal, te.ordinal
  `).all(harness).map((row) => ({ ...row }));
  const v2Tools = db.prepare(`
    SELECT c.external_id, ct.ordinal AS turn_ordinal,
      cmc.call_within_turn, cte.ordinal, cte.source_tool_id, cte.name,
      cte.status, cte.started_at, cte.completed_at, cte.input_preview,
      cte.input_original_length, cte.input_truncated, cte.output_preview,
      cte.output_original_length, cte.output_truncated
    FROM conversation_tool_events cte
    JOIN conversation_model_calls cmc ON cmc.id = cte.model_call_id
    JOIN conversation_turns ct ON ct.id = cmc.turn_id
    JOIN conversations c ON c.id = cmc.conversation_id
    JOIN sources so ON so.id = c.source_id
    WHERE so.harness = ?
    ORDER BY c.external_id, ct.ordinal, cmc.call_within_turn, cte.ordinal
  `).all(harness).map((row) => ({ ...row }));
  deepStrictEqual(v2Tools, legacyTools);
}

function withoutInternalIDs<T extends { internalID?: number }>(value: T) {
  const { internalID: _internalID, ...rest } = value;
  return rest;
}

export function assertConversationCompatibilityParity(
  db: DatabaseSync,
  legacy: SessionRepository,
  harness: SessionSummary["harness"],
  id: string,
) {
  const conversations = new ConversationCompatibilityRepository(db);
  const legacyList = legacy.listSessions(1, 1_000, harness);
  const conversationList = conversations.listSessions(1, 1_000, harness);
  deepStrictEqual(
    conversationList.items.map(withoutInternalIDs),
    legacyList.items.map(withoutInternalIDs),
  );
  deepStrictEqual(conversationList.pagination, legacyList.pagination);

  const legacyDetail = legacy.getSession(harness, id);
  const conversationDetail = conversations.getSession(harness, id);
  const normalizeDetail = (detail: typeof legacyDetail): unknown =>
    detail === undefined ? undefined : JSON.parse(JSON.stringify({
      ...withoutInternalIDs(detail),
      subagents: detail.subagents.map((child) => normalizeDetail(child)),
    }));
  deepStrictEqual(
    normalizeDetail(conversationDetail),
    normalizeDetail(legacyDetail),
  );

  const normalizeUsage = ({
    modelCallID: _modelCallID,
    previousModelCallID: _previousModelCallID,
    computedCost: _computedCost,
    ...call
  }: ReturnType<
    ConversationCompatibilityRepository["listUsageCalls"]
  >[number]) => call;
  deepStrictEqual(
    conversations.listUsageCalls(undefined, harness).map(normalizeUsage),
    legacy.listUsageCalls(undefined, harness),
  );

  const withoutModelCallID = <T extends { modelCallID: number }>(value: T) => {
    const { modelCallID: _modelCallID, ...rest } = value;
    return rest;
  };
  deepStrictEqual(
    conversations.listToolCalls(0, Number.MAX_SAFE_INTEGER, harness).map(
      withoutModelCallID,
    ),
    legacy.listToolCalls(0, Number.MAX_SAFE_INTEGER, harness).map(
      withoutModelCallID,
    ),
  );

  const normalizeMiss = <
    T extends {
      modelCallID: number;
      previousModelCallID?: number;
      turnID: number;
    },
  >(value: T) => {
    const {
      modelCallID: _modelCallID,
      previousModelCallID: _previousModelCallID,
      turnID: _turnID,
      ...rest
    } = value;
    return rest;
  };
  deepStrictEqual(
    conversations.listCacheMisses(undefined, harness).map(normalizeMiss),
    legacy.listCacheMisses(undefined, harness).map(normalizeMiss),
  );

  const normalizeRoot = <T extends { rootSessionID: number }>(value: T) => {
    const { rootSessionID: _rootSessionID, ...rest } = value;
    return rest;
  };
  deepStrictEqual(
    conversations.listOverviewRollups(0, harness).map(normalizeRoot),
    legacy.listOverviewRollups(0, harness).map(normalizeRoot),
  );
  deepStrictEqual(
    conversations.listSessionShapeRollups(0, harness).map(normalizeRoot),
    legacy.listSessionShapeRollups(0, harness).map(normalizeRoot),
  );
  deepStrictEqual(
    conversations.listUsageRollups(undefined, harness).map(normalizeRoot),
    legacy.listUsageRollups(undefined, harness).map(normalizeRoot),
  );
  const normalizeSubagentUsage = ({
    rootSessionID: _rootSessionID,
    subagentSessionID: _subagentSessionID,
    ...usage
  }: ReturnType<
    ConversationCompatibilityRepository["listSubagentUsage"]
  >[number]) => usage;
  deepStrictEqual(
    conversations.listSubagentUsage(undefined, harness).map(
      normalizeSubagentUsage,
    ),
    legacy.listSubagentUsage(undefined, harness).map(normalizeSubagentUsage),
  );
  deepStrictEqual(
    conversations.listInitialInputSamples(undefined, harness),
    legacy.listInitialInputSamples(undefined, harness),
  );
  deepStrictEqual(
    conversations.initialInputDistribution(0, harness),
    legacy.initialInputDistribution(0, harness),
  );
  const normalizeCosts = (
    summary: ReturnType<
      ConversationCompatibilityRepository["summarizeModelCallCosts"]
    >,
  ) =>
    harness !== "codex" ? summary : {
      totalCost: summary.totalCost,
      totalSessionCost: summary.totalSessionCost,
      sessions: summary.sessions.map((session) => ({
        harness: session.harness,
        rootID: session.rootID,
        sessionStartedAt: session.sessionStartedAt,
        rootCost: session.rootCost,
      })),
    };
  deepStrictEqual(
    normalizeCosts(conversations.summarizeModelCallCosts(0, harness)),
    normalizeCosts(legacy.summarizeModelCallCosts(0, harness)),
  );
}
