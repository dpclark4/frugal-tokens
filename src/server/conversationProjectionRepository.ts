import type { DatabaseSync } from "node:sqlite";
import type {
  ReasoningSettingImport,
  SessionContentImport,
  SourceSessionImport,
} from "./sessionRepository.ts";
import { computeModelCallCost } from "./pricing.ts";
import type { TokenUsage } from "../shared/sessionSchemas.ts";

function tokenValues(tokens: TokenUsage) {
  return [
    tokens.uncachedInput,
    tokens.cacheRead,
    tokens.cacheWrite ?? null,
    tokens.cacheWrite5m ?? null,
    tokens.cacheWrite1h ?? null,
    tokens.freshPrompt,
    tokens.output,
    tokens.reasoning,
    tokens.processed,
  ];
}

function reasoningValues(setting?: ReasoningSettingImport) {
  return setting === undefined
    ? [null, null, null, null, null, null]
    : [
      setting.settingName,
      setting.settingValue,
      setting.sourceFieldPath ?? null,
      setting.sourceOrder ?? null,
      setting.observedAt ?? null,
      setting.provenance,
    ];
}

function computedConversationCost(value: SourceSessionImport) {
  const calls = value.session.turns.flatMap((turn) => turn.calls);
  if (calls.length === 0) return undefined;
  const costs = calls.map((call) =>
    computeModelCallCost(call.tokens, call.model, call.startedAt)
  );
  if (costs.some((cost) => cost === undefined)) return undefined;
  return costs.reduce<number>((sum, cost) => sum + cost!, 0);
}

/** Transactional writer for the additive conversation-v2 shadow projection. */
export class ConversationProjectionRepository {
  constructor(private db: DatabaseSync) {}

  replaceLinearSession(value: SourceSessionImport) {
    this.replaceLinearSessionTree([value]);
  }

  replaceLinearSessionTree(values: SourceSessionImport[]) {
    if (values.length === 0) {
      throw new Error("A linear conversation projection must not be empty");
    }
    const sourceID = values[0].sourceID;
    if (values.some((value) => value.sourceID !== sourceID)) {
      throw new Error("A conversation projection must belong to one source");
    }
    const externalIDs = new Set(values.map((value) => value.externalID));
    if (externalIDs.size !== values.length) {
      throw new Error("A conversation projection must have unique external IDs");
    }
    for (const value of values) {
      if (
        value.parentExternalID !== undefined &&
        !externalIDs.has(value.parentExternalID)
      ) {
        throw new Error(`Unknown projected subagent parent: ${value.parentExternalID}`);
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Legacy tree replacement removes source-session identities that no
      // longer exist. Their linear V2 branches are left with a null source
      // reference and can be removed without touching merely-missing sources.
      this.db.prepare(`
        DELETE FROM conversations
        WHERE source_id = ? AND id IN (
          SELECT conversation_id FROM conversation_branches
          WHERE source_session_id IS NULL
        )
      `).run(sourceID);
      const conversationIDs = new Map<string, number>();
      const sourceSessionIDs = new Map<string, number>();
      for (const value of values) {
        const sourceSession = this.db.prepare(`
          SELECT id FROM source_sessions
          WHERE source_id = ? AND external_id = ?
        `).get(sourceID, value.externalID) as { id: number } | undefined;
        if (!sourceSession) {
          throw new Error(`Unknown source artifact: ${value.externalID}`);
        }
        sourceSessionIDs.set(value.externalID, Number(sourceSession.id));
        const conversationID = Number((this.db.prepare(`
          INSERT INTO conversations (
            source_id, external_id, title, working_directory, updated_at,
            started_at, ended_at, providers_json, models_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_id, external_id) DO UPDATE SET
            title = excluded.title,
            working_directory = excluded.working_directory,
            updated_at = excluded.updated_at,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            providers_json = excluded.providers_json,
            models_json = excluded.models_json
          RETURNING id
        `).get(
          sourceID,
          value.externalID,
          value.session.title,
          value.workingDirectory ?? null,
          value.session.updatedAt,
          value.session.startedAt ?? null,
          value.session.endedAt ?? null,
          JSON.stringify(value.session.providers),
          JSON.stringify(value.session.models),
        ) as { id: number }).id);
        conversationIDs.set(value.externalID, conversationID);
      }

      const ids = [...conversationIDs.values()];
      const placeholders = ids.map(() => "?").join(", ");
      this.db.prepare(`
        DELETE FROM conversation_subagent_launches
        WHERE parent_conversation_id IN (${placeholders}) OR
          child_conversation_id IN (${placeholders})
      `).run(...ids, ...ids);
      for (const conversationID of ids) {
        this.db.prepare(
          "DELETE FROM conversation_branches WHERE conversation_id = ?",
        ).run(conversationID);
        this.db.prepare(
          "DELETE FROM conversation_entries WHERE conversation_id = ?",
        ).run(conversationID);
        this.db.prepare(
          "DELETE FROM conversation_model_calls WHERE conversation_id = ?",
        ).run(conversationID);
        this.db.prepare(
          "DELETE FROM conversation_turns WHERE conversation_id = ?",
        ).run(conversationID);
        this.db.prepare(
          "DELETE FROM conversation_rollups WHERE conversation_id = ?",
        ).run(conversationID);
      }

      const launchTools = new Map<
        string,
        { modelCallID: number; toolEventID: number }
      >();
      for (const value of values) {
        this.#insertLinearConversation(
          value,
          conversationIDs.get(value.externalID)!,
          sourceSessionIDs.get(value.externalID)!,
          launchTools,
        );
      }

      for (const value of values) {
        if (value.parentExternalID === undefined) continue;
        const launch = launchTools.get(
          `${value.parentExternalID}\0${value.externalID}`,
        );
        this.db.prepare(`
          INSERT INTO conversation_subagent_launches (
            parent_conversation_id, child_conversation_id, model_call_id,
            tool_event_id, provenance
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          conversationIDs.get(value.parentExternalID)!,
          conversationIDs.get(value.externalID)!,
          launch?.modelCallID ?? null,
          launch?.toolEventID ?? null,
          launch === undefined ? "source-ancestry" : "explicit-tool-link",
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #insertLinearConversation(
    value: SourceSessionImport,
    conversationID: number,
    sourceSessionID: number,
    launchTools: Map<string, { modelCallID: number; toolEventID: number }>,
  ) {
    const branchID = Number((this.db.prepare(`
      INSERT INTO conversation_branches (
        conversation_id, source_session_id, external_id,
        fork_point_provenance, updated_at
      ) VALUES (?, ?, ?, 'unresolved', ?)
      RETURNING id
    `).get(
      conversationID,
      sourceSessionID,
      value.externalID,
      value.session.updatedAt,
    ) as { id: number }).id);
    let previousTurnID: number | null = null;
    let previousEntryID: number | null = null;
    let entrySourceOrder = 0;
    let callOrdinal = 0;

    const insertEntry = (options: {
      stableSourceID?: string;
      kind: string;
      role?: string;
      occurredAt?: number;
      content?: SessionContentImport;
      producerModelCallID?: number;
      producerToolEventID?: number;
      outputOrdinal?: number;
      nativeMetadata?: unknown;
      sourceOrder?: number;
    }) => {
      const entryID = Number((this.db.prepare(`
        INSERT INTO conversation_entries (
          conversation_id, parent_entry_id, producer_model_call_id,
          producer_tool_event_id, output_ordinal, stable_source_id, kind, role,
          occurred_at, content_preview, original_length, truncated, mime_type,
          content_hash, native_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).get(
        conversationID,
        previousEntryID,
        options.producerModelCallID ?? null,
        options.producerToolEventID ?? null,
        options.outputOrdinal ?? null,
        options.stableSourceID ?? null,
        options.kind,
        options.role ?? null,
        options.occurredAt ?? null,
        options.content?.preview ?? null,
        options.content?.originalLength ?? null,
        Number(options.content?.truncated ?? false),
        options.content?.mimeType ?? null,
        options.content?.contentHash ?? null,
        options.nativeMetadata === undefined
          ? null
          : JSON.stringify(options.nativeMetadata),
      ) as { id: number }).id);
      previousEntryID = entryID;
      this.db.prepare(`
        INSERT INTO artifact_entry_occurrences (
          source_session_id, branch_id, entry_id, source_entry_id,
          source_order_start, source_order_end, occurrence_kind, identity_basis
        ) VALUES (?, ?, ?, ?, ?, ?, 'executed', 'unresolved')
      `).run(
        sourceSessionID,
        branchID,
        entryID,
        options.stableSourceID ?? null,
        options.sourceOrder ?? ++entrySourceOrder,
        options.sourceOrder ?? entrySourceOrder,
      );
      return entryID;
    };

    for (const turn of value.session.turns) {
      const turnID: number = Number((this.db.prepare(`
        INSERT INTO conversation_turns (
          conversation_id, parent_turn_id, source_turn_id, ordinal, started_at,
          reasoning_setting_name, reasoning_setting_value,
          reasoning_source_field_path, reasoning_source_order,
          reasoning_observed_at, reasoning_provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).get(
        conversationID,
        previousTurnID,
        `turn:${turn.number}`,
        turn.number,
        turn.startedAt,
        ...reasoningValues(turn.reasoningSetting),
      ) as { id: number }).id);
      previousTurnID = turnID;

      (turn.inputs ?? []).forEach((input, index) =>
        insertEntry({
          stableSourceID: `turn:${turn.number}:input:${index + 1}`,
          kind: "message",
          role: "user",
          occurredAt: turn.startedAt,
          content: input,
        })
      );

      for (const call of turn.calls) {
        callOrdinal++;
        const callID = Number((this.db.prepare(`
          INSERT INTO conversation_model_calls (
            conversation_id, turn_id, source_call_id, ordinal,
            call_within_turn, provider, model, started_at, completed_at,
            reported_cost, uncached_input_tokens, cache_read_tokens,
            cache_write_tokens, cache_write_5m_tokens,
            cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
            reasoning_tokens, processed_tokens, finish_reason, images,
            has_text, has_reasoning, reasoning_setting_name,
            reasoning_setting_value, reasoning_source_field_path,
            reasoning_source_order, reasoning_observed_at,
            reasoning_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `).get(
          conversationID,
          turnID,
          call.id,
          callOrdinal,
          call.callWithinTurn,
          call.provider,
          call.model,
          call.startedAt,
          call.completedAt ?? null,
          call.reportedCost ?? null,
          ...tokenValues(call.tokens),
          call.activity.finishReason ?? null,
          call.activity.images ?? null,
          Number(call.activity.hasText),
          Number(call.activity.hasReasoning),
          ...reasoningValues(call.reasoningSetting),
        ) as { id: number }).id);
        this.db.prepare(`
          INSERT INTO artifact_model_call_occurrences (
            source_session_id, branch_id, model_call_id, source_turn_id,
            source_call_id, occurrence_kind, identity_basis
          ) VALUES (?, ?, ?, ?, ?, 'executed', 'unresolved')
        `).run(
          sourceSessionID,
          branchID,
          callID,
          `turn:${turn.number}`,
          call.id,
        );

        (call.content ?? []).forEach((content, index) =>
          insertEntry({
            stableSourceID:
              `turn:${turn.number}:call:${call.callWithinTurn}:output:${index + 1}`,
            kind: "message",
            role: content.kind === "reasoning" ? "reasoning" : "assistant",
            occurredAt: call.completedAt ?? call.startedAt,
            content,
            producerModelCallID: callID,
            outputOrdinal: index + 1,
          })
        );

        call.activity.tools.forEach((tool, index) => {
          const toolEventID = Number((this.db.prepare(`
            INSERT INTO conversation_tool_events (
              model_call_id, source_tool_id, ordinal, name, status,
              started_at, completed_at, input_preview, input_original_length,
              input_truncated, output_preview, output_original_length,
              output_truncated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).get(
            callID,
            tool.sourceID ?? null,
            index + 1,
            tool.name,
            tool.status,
            tool.startedAt ?? null,
            tool.completedAt ?? null,
            tool.input?.preview ?? tool.inputPreview ?? null,
            tool.input?.originalLength ?? null,
            Number(tool.input?.truncated ?? false),
            tool.output?.preview ?? tool.outputPreview ?? null,
            tool.output?.originalLength ?? null,
            Number(tool.output?.truncated ?? false),
          ) as { id: number }).id);
          if (tool.output !== undefined || tool.outputPreview !== undefined) {
            insertEntry({
              stableSourceID:
                `turn:${turn.number}:call:${call.callWithinTurn}:tool:${index + 1}:output`,
              kind: "tool-result",
              role: "tool",
              occurredAt: tool.completedAt,
              content: {
                kind: "text",
                preview: tool.output?.preview ?? tool.outputPreview,
                originalLength: tool.output?.originalLength ??
                  tool.outputPreview?.length,
                truncated: tool.output?.truncated,
              },
              producerToolEventID: toolEventID,
              outputOrdinal: 1,
            });
          }
          if (tool.childExternalID !== undefined) {
            launchTools.set(
              `${value.externalID}\0${tool.childExternalID}`,
              { modelCallID: callID, toolEventID },
            );
          }
        });
      }
    }

    (value.session.contextEvents ?? []).forEach((event, index) => {
      insertEntry({
        stableSourceID: `context:${event.sourceOrder}:${index + 1}`,
        kind: "context-event",
        occurredAt: event.occurredAt,
        nativeMetadata: event,
        sourceOrder: event.sourceOrder,
      });
    });

    this.db.prepare(`
      UPDATE conversation_branches SET head_entry_id = ? WHERE id = ?
    `).run(previousEntryID, branchID);
    this.db.prepare(`
      INSERT INTO conversation_rollups (
        conversation_id, rollup_version, user_turns, model_calls,
        reported_cost, computed_cost, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
        cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
        reasoning_tokens, processed_tokens
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationID,
      value.session.userTurns,
      value.session.modelCalls,
      value.session.reportedCost ?? null,
      computedConversationCost(value) ?? null,
      ...tokenValues(value.session.tokens),
    );
  }
}
