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
  return setting === undefined ? [null, null, null, null, null, null] : [
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

export type SourceArtifactFamilyMemberImport = {
  externalID: string;
  sourceIdentity?: string;
  parentSourceIdentity?: string;
  value: SourceSessionImport;
};

export type SourceArtifactFamilyImport = {
  sourceID: number;
  externalID: string;
  artifacts: SourceArtifactFamilyMemberImport[];
};

type IdentityBasis = "stable-id" | "explicit-lineage" | "unresolved";

function confirmedIdentity(basis: IdentityBasis | undefined) {
  return basis === "stable-id" || basis === "explicit-lineage";
}

function addTokenUsage(total: TokenUsage, value: TokenUsage) {
  total.uncachedInput += value.uncachedInput;
  total.cacheRead += value.cacheRead;
  total.cacheWrite =
    total.cacheWrite === undefined && value.cacheWrite === undefined
      ? undefined
      : (total.cacheWrite ?? 0) + (value.cacheWrite ?? 0);
  total.cacheWrite5m =
    total.cacheWrite5m === undefined && value.cacheWrite5m === undefined
      ? undefined
      : (total.cacheWrite5m ?? 0) + (value.cacheWrite5m ?? 0);
  total.cacheWrite1h =
    total.cacheWrite1h === undefined && value.cacheWrite1h === undefined
      ? undefined
      : (total.cacheWrite1h ?? 0) + (value.cacheWrite1h ?? 0);
  total.freshPrompt += value.freshPrompt;
  total.output += value.output;
  total.reasoning += value.reasoning;
  total.processed += value.processed;
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
      throw new Error(
        "A conversation projection must have unique external IDs",
      );
    }
    for (const value of values) {
      if (
        value.parentExternalID !== undefined &&
        !externalIDs.has(value.parentExternalID)
      ) {
        throw new Error(
          `Unknown projected subagent parent: ${value.parentExternalID}`,
        );
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
        const conversationID = Number(
          (this.db.prepare(`
          INSERT INTO conversations (
            source_id, external_id, title, working_directory, updated_at,
            started_at, ended_at, providers_json, models_json, agent, public_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_id, external_id) DO UPDATE SET
            title = excluded.title,
            working_directory = excluded.working_directory,
            updated_at = excluded.updated_at,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            providers_json = excluded.providers_json,
            models_json = excluded.models_json,
            agent = excluded.agent,
            public_id = excluded.public_id
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
              value.session.agent ?? null,
              value.publicID ?? value.externalID,
            ) as { id: number }).id,
        );
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

  replaceArtifactFamily(family: SourceArtifactFamilyImport) {
    if (family.artifacts.length === 0) {
      throw new Error("A source artifact family must not be empty");
    }
    if (
      family.artifacts.some((artifact) =>
        artifact.value.sourceID !== family.sourceID ||
        artifact.value.externalID !== artifact.externalID
      )
    ) {
      throw new Error("A source artifact family must belong to one source");
    }
    const externalIDs = new Set(
      family.artifacts.map((artifact) => artifact.externalID),
    );
    if (externalIDs.size !== family.artifacts.length) {
      throw new Error("A source artifact family must have unique external IDs");
    }
    const byIdentity = new Map(
      family.artifacts.flatMap((artifact) =>
        artifact.sourceIdentity === undefined
          ? []
          : [[artifact.sourceIdentity, artifact] as const]
      ),
    );
    if (
      byIdentity.size !==
        family.artifacts.filter((artifact) =>
          artifact.sourceIdentity !== undefined
        ).length
    ) {
      throw new Error("A source artifact family has duplicate source identity");
    }

    const ordered: SourceArtifactFamilyMemberImport[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (artifact: SourceArtifactFamilyMemberImport) => {
      if (visited.has(artifact.externalID)) return;
      if (visiting.has(artifact.externalID)) {
        throw new Error(
          `Malformed source artifact ancestry cycle: ${artifact.externalID}`,
        );
      }
      visiting.add(artifact.externalID);
      const parent = artifact.parentSourceIdentity === undefined
        ? undefined
        : byIdentity.get(artifact.parentSourceIdentity);
      if (parent !== undefined) visit(parent);
      visiting.delete(artifact.externalID);
      visited.add(artifact.externalID);
      ordered.push(artifact);
    };
    for (const artifact of family.artifacts) visit(artifact);

    const roots = ordered.filter((artifact) =>
      artifact.parentSourceIdentity === undefined ||
      !byIdentity.has(artifact.parentSourceIdentity)
    );
    const root =
      roots.sort((a, b) =>
        (a.value.session.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (b.value.session.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        a.externalID.localeCompare(b.externalID)
      )[0];
    if (root === undefined) {
      throw new Error("A source artifact family has no root");
    }

    const allCalls = ordered.flatMap((artifact) =>
      artifact.value.session.turns.flatMap((turn) => turn.calls)
    );
    const providers = [...new Set(allCalls.map((call) => call.provider))];
    const models = [...new Set(allCalls.map((call) => call.model))];
    const startedAt = ordered.flatMap((artifact) =>
      artifact.value.session.startedAt === undefined
        ? []
        : [artifact.value.session.startedAt]
    );
    const endedAt = ordered.flatMap((artifact) =>
      artifact.value.session.endedAt === undefined
        ? []
        : [artifact.value.session.endedAt]
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceSessionIDs = new Map<string, number>();
      for (const artifact of ordered) {
        const row = this.db.prepare(`
          SELECT id FROM source_sessions
          WHERE source_id = ? AND external_id = ?
        `).get(family.sourceID, artifact.externalID) as
          | { id: number }
          | undefined;
        if (row === undefined) {
          throw new Error(`Unknown source artifact: ${artifact.externalID}`);
        }
        sourceSessionIDs.set(artifact.externalID, Number(row.id));
      }

      const sourceSessionIDValues = [...sourceSessionIDs.values()];
      const sourcePlaceholders = sourceSessionIDValues.map(() => "?").join(
        ", ",
      );
      const oldConversationIDs = (this.db.prepare(`
        SELECT DISTINCT conversation_id AS id FROM conversation_branches
        WHERE source_session_id IN (${sourcePlaceholders})
      `).all(...sourceSessionIDValues) as Array<{ id: number }>).map((row) =>
        Number(row.id)
      );
      const target = this.db.prepare(`
        SELECT id FROM conversations WHERE source_id = ? AND external_id = ?
      `).get(family.sourceID, family.externalID) as { id: number } | undefined;
      if (target !== undefined) oldConversationIDs.push(Number(target.id));
      for (const conversationID of new Set(oldConversationIDs)) {
        this.db.prepare("DELETE FROM conversations WHERE id = ?").run(
          conversationID,
        );
      }

      const conversationID = Number(
        (this.db.prepare(`
        INSERT INTO conversations (
          source_id, external_id, title, working_directory, updated_at,
          started_at, ended_at, providers_json, models_json, agent, public_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).get(
            family.sourceID,
            family.externalID,
            root.value.session.title,
            root.value.workingDirectory ?? null,
            Math.max(
              ...ordered.map((artifact) => artifact.value.session.updatedAt),
            ),
            startedAt.length === 0 ? null : Math.min(...startedAt),
            endedAt.length === 0 ? null : Math.max(...endedAt),
            JSON.stringify(providers),
            JSON.stringify(models),
            root.value.session.agent ?? null,
            root.value.publicID ?? family.externalID,
          ) as { id: number }).id,
      );

      const branchIDs = new Map<string, number>();
      for (const artifact of ordered) {
        const branchID = Number(
          (this.db.prepare(`
          INSERT INTO conversation_branches (
            conversation_id, source_session_id, external_id,
            fork_point_provenance, updated_at
          ) VALUES (?, ?, ?, 'unresolved', ?)
          RETURNING id
        `).get(
              conversationID,
              sourceSessionIDs.get(artifact.externalID)!,
              artifact.sourceIdentity ?? artifact.externalID,
              artifact.value.session.updatedAt,
            ) as { id: number }).id,
        );
        branchIDs.set(artifact.externalID, branchID);
      }

      let turnOrdinal = 0;
      let callOrdinal = 0;
      const canonicalTurns = new Map<string, {
        id: number;
        parentID: number | null;
        entryIDs: number[];
        callIDs: number[];
        lastEntryID: number | null;
      }>();
      const canonicalCalls = new Map<string, number>();
      const canonicalContexts = new Map<string, number>();
      const canonicalCallValues = new Map<number, (typeof allCalls)[number]>();
      const artifactTurnKeys = new Map<string, Set<string>>();
      const artifactCallKeys = new Map<string, Set<string>>();
      const artifactEntryKeys = new Map<string, Set<string>>();
      const artifactPaths = new Map<string, number[]>();

      const occurrenceKind = (
        artifact: SourceArtifactFamilyMemberImport,
        key: string,
        keys: Map<string, Set<string>>,
        basis: IdentityBasis,
      ) => {
        if (artifact.parentSourceIdentity === undefined) return "executed";
        if (!confirmedIdentity(basis)) return "unknown";
        const parent = byIdentity.get(artifact.parentSourceIdentity);
        if (parent === undefined) return "unknown";
        return keys.get(parent.externalID)?.has(key) ? "copied" : "executed";
      };
      const evidence = (artifact: SourceArtifactFamilyMemberImport) =>
        JSON.stringify({
          ...(artifact.sourceIdentity === undefined
            ? {}
            : { sourceIdentity: artifact.sourceIdentity }),
          ...(artifact.parentSourceIdentity === undefined
            ? {}
            : { parentSourceIdentity: artifact.parentSourceIdentity }),
        });

      const insertEntry = (options: {
        parentEntryID: number | null;
        turnID?: number;
        stableSourceID?: string;
        kind: string;
        role?: string;
        occurredAt?: number;
        content?: SessionContentImport;
        producerModelCallID?: number;
        producerToolEventID?: number;
        outputOrdinal?: number;
        nativeMetadata?: unknown;
      }) =>
        Number(
          (this.db.prepare(`
        INSERT INTO conversation_entries (
          conversation_id, parent_entry_id, producer_model_call_id,
          producer_tool_event_id, output_ordinal, stable_source_id, kind, role,
          occurred_at, content_preview, original_length, truncated, mime_type,
          content_hash, native_metadata_json, turn_id, content_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).get(
            conversationID,
            options.parentEntryID,
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
            options.turnID ?? null,
            options.content?.kind ?? null,
          ) as { id: number }).id,
        );

      const insertEntryOccurrence = (options: {
        artifact: SourceArtifactFamilyMemberImport;
        branchID: number;
        entryID: number;
        sourceEntryID?: string;
        sourceOrderStart?: number;
        sourceOrderEnd?: number;
        kind: "executed" | "copied" | "unknown";
        basis: IdentityBasis;
      }) =>
        this.db.prepare(`
        INSERT INTO artifact_entry_occurrences (
          source_session_id, branch_id, entry_id, source_entry_id,
          source_order_start, source_order_end, occurrence_kind,
          identity_basis, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
            sourceSessionIDs.get(options.artifact.externalID)!,
            options.branchID,
            options.entryID,
            options.sourceEntryID ?? null,
            options.sourceOrderStart ?? null,
            options.sourceOrderEnd ?? null,
            options.kind,
            options.basis,
            evidence(options.artifact),
          );

      for (const artifact of ordered) {
        const branchID = branchIDs.get(artifact.externalID)!;
        const parentArtifact = artifact.parentSourceIdentity === undefined
          ? undefined
          : byIdentity.get(artifact.parentSourceIdentity);
        let previousTurnID: number | null = null;
        let previousEntryID: number | null = null;
        const pathEntryIDs: number[] = [];
        const callKeys = new Set<string>();
        const turnKeys = new Set<string>();
        const entryKeys = new Set<string>();
        const contexts = [...(artifact.value.session.contextEvents ?? [])]
          .sort((a, b) => a.sourceOrder - b.sourceOrder);
        let contextIndex = 0;

        const insertContextsBefore = (sourceOrder: number) => {
          while (
            contextIndex < contexts.length &&
            contexts[contextIndex].sourceOrder < sourceOrder
          ) {
            const event = contexts[contextIndex++];
            const stableID = event.compaction?.sourceID;
            const key = stableID === undefined
              ? `${artifact.externalID}:context:${event.sourceOrder}`
              : `stable:${stableID}`;
            let entryID = canonicalContexts.get(key);
            if (entryID === undefined) {
              entryID = insertEntry({
                parentEntryID: previousEntryID,
                stableSourceID: stableID,
                kind: "context-event",
                occurredAt: event.occurredAt,
                nativeMetadata: event,
              });
              canonicalContexts.set(key, entryID);
            }
            const basis: IdentityBasis = stableID === undefined
              ? "unresolved"
              : "stable-id";
            insertEntryOccurrence({
              artifact,
              branchID,
              entryID,
              sourceEntryID: stableID,
              sourceOrderStart: event.sourceOrder,
              sourceOrderEnd: event.sourceOrder,
              kind: occurrenceKind(artifact, key, artifactEntryKeys, basis),
              basis,
            });
            previousEntryID = entryID;
            pathEntryIDs.push(entryID);
            entryKeys.add(key);
          }
        };

        for (
          const [turnIndex, turn] of artifact.value.session.turns.entries()
        ) {
          insertContextsBefore(
            turn.sourceOrderStart ?? Number.MAX_SAFE_INTEGER,
          );
          const turnBasis: IdentityBasis = turn.identityBasis ?? "unresolved";
          const turnKey =
            confirmedIdentity(turnBasis) && turn.sourceID !== undefined
              ? `${turnBasis}:${turn.sourceID}`
              : `${artifact.externalID}:turn:${turnIndex + 1}`;
          let canonicalTurn = canonicalTurns.get(turnKey);
          const currentEntrySources: Array<{
            sourceID?: string;
            sourceOrder?: number;
          }> = [];
          for (const input of turn.inputs ?? []) {
            currentEntrySources.push({
              sourceID: input.sourceID,
              sourceOrder: input.sourceOrder,
            });
          }
          for (const call of turn.calls) {
            for (const content of call.content ?? []) {
              currentEntrySources.push({
                sourceID: content.sourceID,
                sourceOrder: content.sourceOrder,
              });
            }
            for (const tool of call.activity.tools) {
              if (
                tool.output !== undefined || tool.outputPreview !== undefined
              ) {
                currentEntrySources.push({
                  sourceID: tool.outputSourceEntryID,
                  sourceOrder: tool.sourceOrderEnd,
                });
              }
            }
          }

          if (canonicalTurn === undefined) {
            turnOrdinal++;
            const turnID: number = Number(
              (this.db.prepare(`
              INSERT INTO conversation_turns (
                conversation_id, parent_turn_id, source_turn_id, ordinal,
                started_at, reasoning_setting_name, reasoning_setting_value,
                reasoning_source_field_path, reasoning_source_order,
                reasoning_observed_at, reasoning_provenance
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING id
            `).get(
                  conversationID,
                  previousTurnID,
                  turn.sourceID ?? null,
                  turnOrdinal,
                  turn.startedAt,
                  ...reasoningValues(turn.reasoningSetting),
                ) as { id: number }).id,
            );
            const entryIDs: number[] = [];
            for (const input of turn.inputs ?? []) {
              const entryID = insertEntry({
                parentEntryID: previousEntryID,
                turnID,
                stableSourceID: input.sourceID,
                kind: "message",
                role: "user",
                occurredAt: turn.startedAt,
                content: input,
              });
              previousEntryID = entryID;
              entryIDs.push(entryID);
            }
            const callIDs: number[] = [];
            for (const call of turn.calls) {
              const callBasis: IdentityBasis = call.identityBasis ??
                "unresolved";
              const callKey =
                confirmedIdentity(callBasis) && call.sourceID !== undefined
                  ? `${callBasis}:${call.sourceID}`
                  : `${artifact.externalID}:${turnKey}:call:${call.callWithinTurn}`;
              let callID = canonicalCalls.get(callKey);
              if (callID === undefined) {
                callOrdinal++;
                callID = Number(
                  (this.db.prepare(`
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
                      call.sourceID ?? call.id,
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
                    ) as { id: number }).id,
                );
                canonicalCalls.set(callKey, callID);
                canonicalCallValues.set(callID, call);
              }
              callIDs.push(callID);
              callKeys.add(callKey);

              (call.content ?? []).forEach((content, index) => {
                const entryID = insertEntry({
                  parentEntryID: previousEntryID,
                  turnID,
                  stableSourceID: content.sourceID,
                  kind: "message",
                  role: content.kind === "reasoning"
                    ? "reasoning"
                    : "assistant",
                  occurredAt: call.completedAt ?? call.startedAt,
                  content,
                  producerModelCallID: callID,
                  outputOrdinal: index + 1,
                });
                previousEntryID = entryID;
                entryIDs.push(entryID);
              });
              call.activity.tools.forEach((tool, index) => {
                const toolEventID = Number(
                  (this.db.prepare(`
                  INSERT INTO conversation_tool_events (
                    model_call_id, source_tool_id, ordinal, name, status,
                    started_at, completed_at, input_preview,
                    input_original_length, input_truncated, output_preview,
                    output_original_length, output_truncated
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
                    ) as { id: number }).id,
                );
                if (
                  tool.output !== undefined || tool.outputPreview !== undefined
                ) {
                  const entryID = insertEntry({
                    parentEntryID: previousEntryID,
                    turnID,
                    stableSourceID: tool.outputSourceEntryID,
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
                  previousEntryID = entryID;
                  entryIDs.push(entryID);
                }
              });
            }
            canonicalTurn = {
              id: turnID,
              parentID: previousTurnID,
              entryIDs,
              callIDs,
              lastEntryID: previousEntryID,
            };
            canonicalTurns.set(turnKey, canonicalTurn);
          } else {
            if (canonicalTurn.parentID !== previousTurnID) {
              throw new Error(
                `Conflicting canonical turn lineage: ${
                  turn.sourceID ?? turnKey
                }`,
              );
            }
            if (canonicalTurn.entryIDs.length !== currentEntrySources.length) {
              throw new Error(
                `Conflicting canonical entry shape: ${
                  turn.sourceID ?? turnKey
                }`,
              );
            }
            previousEntryID = canonicalTurn.lastEntryID;
          }

          const turnKind = occurrenceKind(
            artifact,
            turnKey,
            artifactTurnKeys,
            turnBasis,
          );
          for (const [index, entryID] of canonicalTurn.entryIDs.entries()) {
            const source = currentEntrySources[index];
            const entryKey = source?.sourceID === undefined
              ? `${turnKey}:entry:${index + 1}`
              : `stable:${source.sourceID}`;
            insertEntryOccurrence({
              artifact,
              branchID,
              entryID,
              sourceEntryID: source?.sourceID,
              sourceOrderStart: source?.sourceOrder ?? turn.sourceOrderStart,
              sourceOrderEnd: source?.sourceOrder ?? turn.sourceOrderEnd,
              kind: turnKind,
              basis: source?.sourceID === undefined ? turnBasis : "stable-id",
            });
            pathEntryIDs.push(entryID);
            entryKeys.add(entryKey);
          }
          for (const [index, call] of turn.calls.entries()) {
            const callBasis: IdentityBasis = call.identityBasis ?? "unresolved";
            const callKey =
              confirmedIdentity(callBasis) && call.sourceID !== undefined
                ? `${callBasis}:${call.sourceID}`
                : `${artifact.externalID}:${turnKey}:call:${call.callWithinTurn}`;
            const callID = canonicalTurn.callIDs[index];
            if (callID === undefined) {
              throw new Error(
                `Conflicting canonical call shape: ${turn.sourceID ?? turnKey}`,
              );
            }
            this.db.prepare(`
              INSERT INTO artifact_model_call_occurrences (
                source_session_id, branch_id, model_call_id, source_turn_id,
                source_call_id, source_order_start, source_order_end,
                occurrence_kind, identity_basis, evidence_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              sourceSessionIDs.get(artifact.externalID)!,
              branchID,
              callID,
              turn.sourceID ?? null,
              call.sourceID ?? call.id,
              call.sourceOrderStart ?? turn.sourceOrderStart ?? null,
              call.sourceOrderEnd ?? turn.sourceOrderEnd ?? null,
              occurrenceKind(artifact, callKey, artifactCallKeys, callBasis),
              callBasis,
              evidence(artifact),
            );
            callKeys.add(callKey);
          }
          previousTurnID = canonicalTurn.id;
          turnKeys.add(turnKey);
        }
        insertContextsBefore(Number.MAX_SAFE_INTEGER);

        const parentPath = parentArtifact === undefined
          ? undefined
          : artifactPaths.get(parentArtifact.externalID);
        let forkPointEntryID: number | null = null;
        let forkPointProvenance: "inferred-confirmed" | "unresolved" =
          "unresolved";
        if (parentPath !== undefined) {
          const shared = pathEntryIDs.findIndex((entryID, index) =>
            parentPath[index] !== entryID
          );
          const sharedLength = shared === -1
            ? Math.min(pathEntryIDs.length, parentPath.length)
            : shared;
          forkPointEntryID = sharedLength === 0
            ? null
            : pathEntryIDs[sharedLength - 1];
          forkPointProvenance = sharedLength === 0
            ? "unresolved"
            : "inferred-confirmed";
        }
        this.db.prepare(`
          UPDATE conversation_branches SET forked_from_branch_id = ?,
            fork_point_entry_id = ?, head_entry_id = ?,
            fork_point_provenance = ?
          WHERE id = ?
        `).run(
          parentArtifact === undefined
            ? null
            : branchIDs.get(parentArtifact.externalID)!,
          forkPointEntryID,
          previousEntryID,
          forkPointProvenance,
          branchID,
        );
        artifactTurnKeys.set(artifact.externalID, turnKeys);
        artifactCallKeys.set(artifact.externalID, callKeys);
        artifactEntryKeys.set(artifact.externalID, entryKeys);
        artifactPaths.set(artifact.externalID, pathEntryIDs);
      }

      const uniqueCalls = [...canonicalCallValues.values()];
      const totalTokens: TokenUsage = {
        uncachedInput: 0,
        cacheRead: 0,
        freshPrompt: 0,
        output: 0,
        reasoning: 0,
        processed: 0,
      };
      for (const call of uniqueCalls) addTokenUsage(totalTokens, call.tokens);
      const reportedCosts = uniqueCalls.map((call) => call.reportedCost);
      const computedCosts = uniqueCalls.map((call) =>
        computeModelCallCost(call.tokens, call.model, call.startedAt)
      );
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
        canonicalTurns.size,
        uniqueCalls.length,
        reportedCosts.length > 0 &&
          reportedCosts.every((cost) => cost !== undefined)
          ? reportedCosts.reduce<number>((sum, cost) => sum + cost!, 0)
          : null,
        computedCosts.length > 0 &&
          computedCosts.every((cost) => cost !== undefined)
          ? computedCosts.reduce<number>((sum, cost) => sum + cost!, 0)
          : null,
        ...tokenValues(totalTokens),
      );
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
    const branchID = Number(
      (this.db.prepare(`
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
        ) as { id: number }).id,
    );
    let previousTurnID: number | null = null;
    let previousEntryID: number | null = null;
    let entrySourceOrder = 0;
    let callOrdinal = 0;

    const insertEntry = (options: {
      turnID?: number;
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
      const entryID = Number(
        (this.db.prepare(`
        INSERT INTO conversation_entries (
          conversation_id, parent_entry_id, producer_model_call_id,
          producer_tool_event_id, output_ordinal, stable_source_id, kind, role,
          occurred_at, content_preview, original_length, truncated, mime_type,
          content_hash, native_metadata_json, turn_id, content_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            options.turnID ?? null,
            options.content?.kind ?? null,
          ) as { id: number }).id,
      );
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
      const turnID: number = Number(
        (this.db.prepare(`
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
          ) as { id: number }).id,
      );
      previousTurnID = turnID;

      (turn.inputs ?? []).forEach((input, index) =>
        insertEntry({
          turnID,
          stableSourceID: `turn:${turn.number}:input:${index + 1}`,
          kind: "message",
          role: "user",
          occurredAt: turn.startedAt,
          content: input,
        })
      );

      for (const call of turn.calls) {
        callOrdinal++;
        const callID = Number(
          (this.db.prepare(`
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
            ) as { id: number }).id,
        );
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
            turnID,
            stableSourceID:
              `turn:${turn.number}:call:${call.callWithinTurn}:output:${
                index + 1
              }`,
            kind: "message",
            role: content.kind === "reasoning" ? "reasoning" : "assistant",
            occurredAt: call.completedAt ?? call.startedAt,
            content,
            producerModelCallID: callID,
            outputOrdinal: index + 1,
          })
        );

        call.activity.tools.forEach((tool, index) => {
          const toolEventID = Number(
            (this.db.prepare(`
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
              ) as { id: number }).id,
          );
          if (tool.output !== undefined || tool.outputPreview !== undefined) {
            insertEntry({
              turnID,
              stableSourceID:
                `turn:${turn.number}:call:${call.callWithinTurn}:tool:${
                  index + 1
                }:output`,
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
