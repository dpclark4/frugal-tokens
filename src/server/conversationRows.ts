import type { SessionSummary, TokenUsage } from "../shared/sessionSchemas.ts";
import { compactHomePath } from "./database.ts";

export type ConversationRow = {
  id: number;
  source_id: number;
  external_id: string;
  public_id: string | null;
  harness: SessionSummary["harness"];
  title: string;
  agent: string | null;
  working_directory: string | null;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  providers_json: string;
  models_json: string;
  user_turns: number;
  model_calls: number;
  fork_count: number;
  reported_cost: number | null;
  computed_cost: number | null;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
  summary_json: string | null;
};

export const effectiveConversationTitle = `
  COALESCE((
    SELECT ss.generated_title
    FROM conversation_branches title_branch
    JOIN source_sessions ss ON ss.id = title_branch.source_session_id
    WHERE title_branch.conversation_id = c.id
      AND ss.generated_title IS NOT NULL
    ORDER BY title_branch.updated_at DESC, title_branch.id DESC
    LIMIT 1
  ), c.title)
`;

export const conversationColumns = `
  c.id, c.source_id, c.external_id, c.public_id, so.harness,
  ${effectiveConversationTitle} AS title,
  c.agent, c.working_directory, c.updated_at, c.started_at, c.ended_at,
  c.providers_json, c.models_json, cr.user_turns, cr.model_calls,
  MAX(0, (SELECT COUNT(*) FROM conversation_branches branch_count
    WHERE branch_count.conversation_id = c.id) - 1) AS fork_count,
  cr.reported_cost, cr.computed_cost, cr.uncached_input_tokens,
  cr.cache_read_tokens, cr.cache_write_tokens, cr.cache_write_5m_tokens,
  cr.cache_write_1h_tokens, cr.fresh_prompt_tokens, cr.output_tokens,
  cr.reasoning_tokens, cr.processed_tokens, cr.summary_json
`;

export function tokens(row: {
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  fresh_prompt_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  processed_tokens: number;
}): TokenUsage {
  return {
    uncachedInput: row.uncached_input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens ?? undefined,
    cacheWrite5m: row.cache_write_5m_tokens ?? undefined,
    cacheWrite1h: row.cache_write_1h_tokens ?? undefined,
    freshPrompt: row.fresh_prompt_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
    processed: row.processed_tokens,
  };
}

export function baseSummary(
  row: ConversationRow,
  thinking: SessionSummary["thinking"],
): SessionSummary {
  const workingDirectory = row.working_directory ?? undefined;
  const summary: SessionSummary = {
    id: row.public_id ?? row.external_id,
    workingDirectory: workingDirectory === undefined
      ? undefined
      : compactHomePath(workingDirectory),
    harness: row.harness,
    title: row.title,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    providers: JSON.parse(row.providers_json),
    models: JSON.parse(row.models_json),
    userTurns: row.user_turns,
    modelCalls: row.model_calls,
    thinking: thinking ?? {
      latest: undefined,
      values: [],
      classifiedCalls: 0,
    },
    reportedCost: row.reported_cost ?? undefined,
    tokens: tokens(row),
  };
  if (row.fork_count > 0) summary.forkCount = row.fork_count;
  return summary;
}
