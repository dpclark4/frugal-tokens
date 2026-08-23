import type { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "../shared/json.ts";
import type {
  ConversationContentImport,
  LinearConversationImport,
  ReasoningSettingImport,
} from "./conversationImportTypes.ts";
import { computeModelCallCost } from "./pricing.ts";
import {
  sessionListItemSchema,
  type SessionSummary,
  type TokenUsage,
} from "../shared/sessionSchemas.ts";
import { buildSessionRollup, type SessionRollup } from "./sessionRollups.ts";
import { analyzeCacheMisses, type CacheAnalysisCall } from "./cacheAnalysis.ts";
import {
  enrichSessionSummary,
  sessionDetailFromConversationImports,
} from "./sessionSummaryEnrichment.ts";
import {
  firstImportedUserText,
  importedTitleNeedsGeneration,
} from "./sessionTitles.ts";

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

function computedConversationCost(value: LinearConversationImport) {
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
  value: LinearConversationImport;
};

export type SourceArtifactFamilyImport = {
  sourceID: number;
  externalID: string;
  artifacts: SourceArtifactFamilyMemberImport[];
  // Child conversations retain their own linear projections. They are supplied
  // here only to rebuild the merged root's inclusive rollup and summary.
  subagents?: LinearConversationImport[];
};

type IdentityBasis = "stable-id" | "explicit-lineage" | "unresolved";

type CanonicalEntrySource = {
  sourceID?: string;
  sourceOrder?: number;
  signature: string;
};

function entrySignature(
  kind: string,
  role: string | undefined,
  content: ConversationContentImport,
) {
  return JSON.stringify([
    kind,
    role ?? null,
    content.kind,
    content.preview ?? null,
    content.originalLength ?? null,
    content.truncated ?? false,
    content.mimeType ?? null,
  ]);
}

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

function analyticsRollupValues(rollup: SessionRollup) {
  return [
    rollup.version,
    rollup.firstActivityAt ?? null,
    rollup.lastActivityAt ?? null,
    rollup.subagentModelCalls,
    rollup.subagentTokens.uncachedInput,
    rollup.subagentTokens.cacheRead,
    rollup.subagentTokens.cacheWrite ?? null,
    JSON.stringify(rollup.overview),
  ];
}

/** Transactional writer for canonical conversation materialization. */
export class ConversationWriteRepository {
  #statements = new Map<
    string,
    ReturnType<DatabaseSync["prepare"]>
  >();

  constructor(private db: DatabaseSync) {}

  #prepare(sql: string) {
    const existing = this.#statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  #preserveAuthoritativeImportedTitle(
    sourceSessionID: number,
    value: LinearConversationImport,
  ) {
    if (
      importedTitleNeedsGeneration(
        value.session.title,
        firstImportedUserText(value),
      )
    ) return;
    this.#prepare(`
      UPDATE source_sessions SET generated_title = NULL WHERE id = ?
    `).run(sourceSessionID);
  }

  replaceLinearConversation(value: LinearConversationImport) {
    this.replaceLinearConversationTree([value]);
  }

  replaceLinearConversationTree(values: LinearConversationImport[]) {
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
      // Tree replacement removes conversations whose source-artifact identity
      // no longer exists without touching artifacts merely marked missing.
      this.#prepare(`
        DELETE FROM conversations
        WHERE source_id = ? AND id IN (
          SELECT conversation_id FROM conversation_branches
          WHERE source_session_id IS NULL
        )
      `).run(sourceID);
      const conversationIDs = new Map<string, number>();
      const sourceArtifactIDs = new Map<string, number>();
      for (const value of values) {
        const sourceSession = this.#prepare(`
          SELECT id FROM source_sessions
          WHERE source_id = ? AND external_id = ?
        `).get(sourceID, value.externalID) as { id: number } | undefined;
        if (!sourceSession) {
          throw new Error(`Unknown source artifact: ${value.externalID}`);
        }
        const sourceSessionID = Number(sourceSession.id);
        sourceArtifactIDs.set(value.externalID, sourceSessionID);
        this.#preserveAuthoritativeImportedTitle(sourceSessionID, value);
        const conversationID = Number(
          (this.#prepare(`
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
      this.#prepare(`
        DELETE FROM conversation_subagent_launches
        WHERE parent_conversation_id IN (${placeholders}) OR
          child_conversation_id IN (${placeholders})
      `).run(...ids, ...ids);
      for (const conversationID of ids) {
        this.#prepare(
          "DELETE FROM conversation_branches WHERE conversation_id = ?",
        ).run(conversationID);
        this.#prepare(
          "DELETE FROM conversation_entries WHERE conversation_id = ?",
        ).run(conversationID);
        this.#prepare(
          "DELETE FROM conversation_model_calls WHERE conversation_id = ?",
        ).run(conversationID);
        this.#prepare(
          "DELETE FROM conversation_turns WHERE conversation_id = ?",
        ).run(conversationID);
        this.#prepare(
          "DELETE FROM conversation_rollups WHERE conversation_id = ?",
        ).run(conversationID);
      }

      const launchTools = new Map<
        string,
        Array<{ modelCallID: number; toolEventID: number }>
      >();
      for (const value of values) {
        this.#insertLinearConversation(
          value,
          conversationIDs.get(value.externalID)!,
          sourceArtifactIDs.get(value.externalID)!,
          launchTools,
        );
      }

      for (const value of values) {
        if (value.parentExternalID === undefined) continue;
        const launches = launchTools.get(
          `${value.parentExternalID}\0${value.externalID}`,
        ) ?? [];
        const childConversationID = conversationIDs.get(value.externalID)!;
        for (const launch of launches) {
          this.#prepare(`
            UPDATE conversation_tool_events SET child_conversation_id = ?
            WHERE id = ?
          `).run(childConversationID, launch.toolEventID);
        }
        const launch = launches[0];
        this.#prepare(`
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
      const byExternalID = new Map(
        values.map((value) => [value.externalID, value]),
      );
      const harness = this.#sourceHarness(sourceID);
      const rootExternalID = (value: LinearConversationImport) => {
        let current = value;
        const visited = new Set<string>();
        while (current.parentExternalID !== undefined) {
          if (visited.has(current.externalID)) {
            throw new Error("Conversation subagent cycle");
          }
          visited.add(current.externalID);
          current = byExternalID.get(current.parentExternalID)!;
        }
        return current.externalID;
      };
      for (
        const [rootID, tree] of Map.groupBy(values, rootExternalID).entries()
      ) {
        const conversationID = conversationIDs.get(rootID)!;
        const rollup = buildSessionRollup(tree);
        this.#updateAnalyticsRollup(conversationID, rollup);
        this.#materializeSummary(
          conversationID,
          sessionDetailFromConversationImports(tree, rootID, harness),
          rollup,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceConversationFamily(family: SourceArtifactFamilyImport) {
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
      const sourceArtifactIDs = new Map<string, number>();
      for (const artifact of ordered) {
        const row = this.#prepare(`
          SELECT id FROM source_sessions
          WHERE source_id = ? AND external_id = ?
        `).get(family.sourceID, artifact.externalID) as
          | { id: number }
          | undefined;
        if (row === undefined) {
          throw new Error(`Unknown source artifact: ${artifact.externalID}`);
        }
        const sourceSessionID = Number(row.id);
        sourceArtifactIDs.set(artifact.externalID, sourceSessionID);
        this.#preserveAuthoritativeImportedTitle(
          sourceSessionID,
          artifact.value,
        );
      }

      const sourceArtifactIDValues = [...sourceArtifactIDs.values()];
      const sourcePlaceholders = sourceArtifactIDValues.map(() => "?").join(
        ", ",
      );
      const oldConversationIDs = (this.#prepare(`
        SELECT DISTINCT conversation_id AS id FROM conversation_branches
        WHERE source_session_id IN (${sourcePlaceholders})
      `).all(...sourceArtifactIDValues) as Array<{ id: number }>).map((row) =>
        Number(row.id)
      );
      const target = this.#prepare(`
        SELECT id FROM conversations WHERE source_id = ? AND external_id = ?
      `).get(family.sourceID, family.externalID) as { id: number } | undefined;
      if (target !== undefined) oldConversationIDs.push(Number(target.id));
      for (const conversationID of new Set(oldConversationIDs)) {
        this.#prepare("DELETE FROM conversations WHERE id = ?").run(
          conversationID,
        );
      }

      const subagentConversationIDs = new Map<string, number>();
      const subagentSourceArtifactIDs = new Map<string, number>();
      const subagentLaunchTools = new Map<
        string,
        Array<{ modelCallID: number; toolEventID: number }>
      >();
      for (const subagent of family.subagents ?? []) {
        const sourceArtifact = this.#prepare(`
          SELECT id FROM source_sessions
          WHERE source_id = ? AND external_id = ?
        `).get(family.sourceID, subagent.externalID) as
          | { id: number }
          | undefined;
        if (sourceArtifact === undefined) {
          throw new Error(`Unknown source artifact: ${subagent.externalID}`);
        }
        subagentSourceArtifactIDs.set(
          subagent.externalID,
          Number(sourceArtifact.id),
        );
        const subagentConversationID = Number(
          (this.#prepare(`
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
              family.sourceID,
              subagent.externalID,
              subagent.session.title,
              subagent.workingDirectory ?? null,
              subagent.session.updatedAt,
              subagent.session.startedAt ?? null,
              subagent.session.endedAt ?? null,
              JSON.stringify(subagent.session.providers),
              JSON.stringify(subagent.session.models),
              subagent.session.agent ?? null,
              subagent.publicID ?? subagent.externalID,
            ) as { id: number }).id,
        );
        subagentConversationIDs.set(
          subagent.externalID,
          subagentConversationID,
        );
        this.#prepare(
          "DELETE FROM conversation_branches WHERE conversation_id = ?",
        ).run(subagentConversationID);
        this.#prepare(
          "DELETE FROM conversation_entries WHERE conversation_id = ?",
        ).run(subagentConversationID);
        this.#prepare(
          "DELETE FROM conversation_model_calls WHERE conversation_id = ?",
        ).run(subagentConversationID);
        this.#prepare(
          "DELETE FROM conversation_turns WHERE conversation_id = ?",
        ).run(subagentConversationID);
        this.#prepare(
          "DELETE FROM conversation_rollups WHERE conversation_id = ?",
        ).run(subagentConversationID);
      }
      for (const subagent of family.subagents ?? []) {
        this.#insertLinearConversation(
          subagent,
          subagentConversationIDs.get(subagent.externalID)!,
          subagentSourceArtifactIDs.get(subagent.externalID)!,
          subagentLaunchTools,
        );
      }
      for (const subagent of family.subagents ?? []) {
        if (
          subagent.parentExternalID === undefined ||
          !subagentConversationIDs.has(subagent.parentExternalID)
        ) continue;
        const launches = subagentLaunchTools.get(
          `${subagent.parentExternalID}\0${subagent.externalID}`,
        ) ?? [];
        for (const launch of launches) {
          this.#prepare(`
            UPDATE conversation_tool_events SET child_conversation_id = ?
            WHERE id = ?
          `).run(
            subagentConversationIDs.get(subagent.externalID)!,
            launch.toolEventID,
          );
        }
        const launch = launches[0];
        this.#prepare(`
          INSERT INTO conversation_subagent_launches (
            parent_conversation_id, child_conversation_id, model_call_id,
            tool_event_id, provenance
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          subagentConversationIDs.get(subagent.parentExternalID)!,
          subagentConversationIDs.get(subagent.externalID)!,
          launch?.modelCallID ?? null,
          launch?.toolEventID ?? null,
          launch === undefined ? "source-ancestry" : "explicit-tool-link",
        );
      }

      const conversationID = Number(
        (this.#prepare(`
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
          (this.#prepare(`
          INSERT INTO conversation_branches (
            conversation_id, source_session_id, external_id,
            fork_point_provenance, updated_at
          ) VALUES (?, ?, ?, 'unresolved', ?)
          RETURNING id
        `).get(
              conversationID,
              sourceArtifactIDs.get(artifact.externalID)!,
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
        entrySources: CanonicalEntrySource[];
        callIDs: number[];
        lastEntryID: number | null;
      }>();
      const canonicalCalls = new Map<string, number>();
      const canonicalTurnValues: LinearConversationImport["session"]["turns"] =
        [];
      const canonicalContexts = new Map<string, number>();
      const canonicalCallValues = new Map<number, (typeof allCalls)[number]>();
      const launchTools = new Map<
        string,
        Array<{ modelCallID: number; toolEventID: number }>
      >();
      const artifactTurnKeys = new Map<string, Set<string>>();
      const artifactCallKeys = new Map<string, Set<string>>();
      const artifactEntryKeys = new Map<string, Set<string>>();
      const artifactPaths = new Map<string, number[]>();
      const artifactCallPaths = new Map<string, number[]>();
      const branchCallPredecessors = new Map<number, number | undefined>();

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
      const evidence = (artifact: SourceArtifactFamilyMemberImport) => {
        const value: JsonObject = {};
        if (artifact.sourceIdentity !== undefined) {
          value.sourceIdentity = artifact.sourceIdentity;
        }
        if (artifact.parentSourceIdentity !== undefined) {
          value.parentSourceIdentity = artifact.parentSourceIdentity;
        }
        return JSON.stringify(value);
      };

      const insertEntry = (options: {
        parentEntryID: number | null;
        turnID?: number;
        stableSourceID?: string;
        kind: string;
        role?: string;
        occurredAt?: number;
        content?: ConversationContentImport;
        producerModelCallID?: number;
        producerToolEventID?: number;
        outputOrdinal?: number;
        nativeMetadata?: unknown;
      }) =>
        Number(
          (this.#prepare(`
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
        this.#prepare(`
        INSERT INTO artifact_entry_occurrences (
          source_session_id, branch_id, entry_id, source_entry_id,
          source_order_start, source_order_end, occurrence_kind,
          identity_basis, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
            sourceArtifactIDs.get(options.artifact.externalID)!,
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
        const pathCallIDs: number[] = [];
        const parentCallPath = parentArtifact === undefined
          ? undefined
          : artifactCallPaths.get(parentArtifact.externalID);
        let implicitParentCallPrefix: number[] = [];
        const callKeys = new Set<string>();
        const turnKeys = new Set<string>();
        const entryKeys = new Set<string>();
        let previousTurnKey: string | undefined;
        const unresolvedTurnAppearances = new Map<string, number>();
        const contexts = [...(artifact.value.session.contextEvents ?? [])]
          .sort((a, b) => a.sourceOrder - b.sourceOrder);
        const contextAppearances = new Map<string, number>();
        let contextIndex = 0;

        const insertContextsBefore = (sourceOrder: number) => {
          while (
            contextIndex < contexts.length &&
            contexts[contextIndex].sourceOrder < sourceOrder
          ) {
            const event = contexts[contextIndex++];
            const stableID = event.compaction?.sourceID;
            let appearance: number | undefined;
            if (stableID !== undefined) {
              appearance = (contextAppearances.get(stableID) ?? 0) + 1;
              contextAppearances.set(stableID, appearance);
            }
            const key = stableID === undefined
              ? `${artifact.externalID}:context:${event.sourceOrder}`
              : `stable:${stableID}:appearance:${appearance}`;
            let entryID = canonicalContexts.get(key);
            if (entryID === undefined) {
              entryID = insertEntry({
                parentEntryID: previousEntryID,
                stableSourceID: appearance === 1 ? stableID : undefined,
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
          const unresolvedTurnKey = previousTurnKey === undefined ||
              turn.inputs === undefined || turn.inputs.length === 0
            ? undefined
            : `${previousTurnKey}:unresolved:${
              turn.inputs.map((input) =>
                entrySignature("message", "user", input)
              ).join("|")
            }`;
          const unresolvedAppearance = unresolvedTurnKey === undefined
            ? undefined
            : (unresolvedTurnAppearances.get(unresolvedTurnKey) ?? 0) + 1;
          if (unresolvedAppearance !== undefined) {
            unresolvedTurnAppearances.set(
              unresolvedTurnKey!,
              unresolvedAppearance,
            );
          }
          const turnKey =
            confirmedIdentity(turnBasis) && turn.sourceID !== undefined
              ? `${turnBasis}:${turn.sourceID}`
              : unresolvedTurnKey === undefined
              ? `${artifact.externalID}:turn:${turnIndex + 1}`
              : `${unresolvedTurnKey}:${unresolvedAppearance}`;
          let canonicalTurn = canonicalTurns.get(turnKey);
          const currentEntrySources: CanonicalEntrySource[] = [];
          for (const input of turn.inputs ?? []) {
            currentEntrySources.push({
              sourceID: input.sourceID,
              sourceOrder: input.sourceOrder,
              signature: entrySignature("message", "user", input),
            });
          }
          for (const call of turn.calls) {
            for (const content of call.content ?? []) {
              currentEntrySources.push({
                sourceID: content.sourceID,
                sourceOrder: content.sourceOrder,
                signature: entrySignature(
                  "message",
                  content.kind === "reasoning" ? "reasoning" : "assistant",
                  content,
                ),
              });
            }
            for (const tool of call.activity.tools) {
              if (
                tool.output !== undefined || tool.outputPreview !== undefined
              ) {
                const content: ConversationContentImport = {
                  kind: "text",
                  preview: tool.output?.preview ?? tool.outputPreview,
                  originalLength: tool.output?.originalLength ??
                    tool.outputPreview?.length,
                  truncated: tool.output?.truncated,
                };
                currentEntrySources.push({
                  sourceID: tool.outputSourceEntryID,
                  sourceOrder: tool.sourceOrderEnd,
                  signature: entrySignature("tool-result", "tool", content),
                });
              }
            }
          }
          let entryMatches: Array<{
            canonicalIndex: number;
            source: CanonicalEntrySource;
          }>;

          if (canonicalTurn === undefined) {
            turnOrdinal++;
            canonicalTurnValues.push({ ...turn, number: turnOrdinal });
            const turnID: number = Number(
              (this.#prepare(`
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
                  (this.#prepare(`
                  INSERT INTO conversation_model_calls (
                    conversation_id, turn_id, source_call_id, ordinal,
                    call_within_turn, provider, model, started_at, completed_at,
                    reported_cost, computed_cost, uncached_input_tokens,
                    cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
                    cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
                    reasoning_tokens, processed_tokens, finish_reason, images,
                    has_text, has_reasoning, reasoning_setting_name,
                    reasoning_setting_value, reasoning_source_field_path,
                    reasoning_source_order, reasoning_observed_at,
                    reasoning_provenance
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                      computeModelCallCost(
                        call.tokens,
                        call.model,
                        call.startedAt,
                      ) ?? null,
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
                  (this.#prepare(`
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
                if (tool.childExternalID !== undefined) {
                  const launches = launchTools.get(tool.childExternalID) ?? [];
                  launches.push({ modelCallID: callID, toolEventID });
                  launchTools.set(tool.childExternalID, launches);
                }
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
              entrySources: currentEntrySources,
              callIDs,
              lastEntryID: previousEntryID,
            };
            canonicalTurns.set(turnKey, canonicalTurn);
            entryMatches = currentEntrySources.map((
              source,
              canonicalIndex,
            ) => ({
              canonicalIndex,
              source,
            }));
          } else {
            const currentCanonicalTurn = canonicalTurn;
            if (currentCanonicalTurn.parentID !== previousTurnID) {
              throw new Error(
                `Conflicting canonical turn lineage: ${
                  turn.sourceID ?? turnKey
                }`,
              );
            }
            const unmatchedCanonicalEntries = new Set(
              currentCanonicalTurn.entrySources.map((_, index) => index),
            );
            entryMatches = currentEntrySources.map((source) => {
              const canonicalIndex = currentCanonicalTurn.entrySources
                .findIndex(
                  (candidate, index) =>
                    unmatchedCanonicalEntries.has(index) &&
                    source.sourceID !== undefined &&
                    source.sourceID === candidate.sourceID,
                );
              const fallbackIndex = canonicalIndex === -1
                ? currentCanonicalTurn.entrySources.findIndex((
                  candidate,
                  index,
                ) =>
                  unmatchedCanonicalEntries.has(index) &&
                  source.signature === candidate.signature
                )
                : canonicalIndex;
              if (fallbackIndex === -1) {
                throw new Error(
                  `Conflicting canonical entry shape: ${
                    turn.sourceID ?? turnKey
                  }`,
                );
              }
              unmatchedCanonicalEntries.delete(fallbackIndex);
              return { canonicalIndex: fallbackIndex, source };
            });
            previousEntryID = entryMatches.at(-1) === undefined
              ? currentCanonicalTurn.lastEntryID
              : currentCanonicalTurn
                .entryIDs[entryMatches.at(-1)!.canonicalIndex];
          }

          const turnKind = occurrenceKind(
            artifact,
            turnKey,
            artifactTurnKeys,
            turnBasis,
          );
          for (const { canonicalIndex, source } of entryMatches) {
            const entryID = canonicalTurn.entryIDs[canonicalIndex];
            const entryKey = source.sourceID === undefined
              ? `${turnKey}:entry:${canonicalIndex + 1}`
              : `stable:${source.sourceID}`;
            insertEntryOccurrence({
              artifact,
              branchID,
              entryID,
              sourceEntryID: source.sourceID,
              sourceOrderStart: source.sourceOrder ?? turn.sourceOrderStart,
              sourceOrderEnd: source.sourceOrder ?? turn.sourceOrderEnd,
              kind: turnKind,
              basis: source.sourceID === undefined ? turnBasis : "stable-id",
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
            const callKind = occurrenceKind(
              artifact,
              callKey,
              artifactCallKeys,
              callBasis,
            );
            this.#prepare(`
              INSERT INTO artifact_model_call_occurrences (
                source_session_id, branch_id, model_call_id, source_turn_id,
                source_call_id, source_order_start, source_order_end,
                occurrence_kind, identity_basis, evidence_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              sourceArtifactIDs.get(artifact.externalID)!,
              branchID,
              callID,
              turn.sourceID ?? null,
              call.sourceID ?? call.id,
              call.sourceOrderStart ?? turn.sourceOrderStart ?? null,
              call.sourceOrderEnd ?? turn.sourceOrderEnd ?? null,
              callKind,
              callBasis,
              evidence(artifact),
            );
            if (callKind === "executed") {
              let predecessor = pathCallIDs.findLast((id) =>
                !canonicalCallValues.get(id)!.id.startsWith(
                  "context-operation:",
                )
              );
              if (predecessor === undefined && parentCallPath !== undefined) {
                const predecessorIndex = parentCallPath.findLastIndex((id) =>
                  canonicalCallValues.get(id)!.startedAt <= call.startedAt &&
                  !canonicalCallValues.get(id)!.id.startsWith(
                    "context-operation:",
                  )
                );
                if (predecessorIndex >= 0) {
                  implicitParentCallPrefix = parentCallPath.slice(
                    0,
                    predecessorIndex + 1,
                  );
                  predecessor = parentCallPath[predecessorIndex];
                }
              }
              branchCallPredecessors.set(callID, predecessor);
            }
            pathCallIDs.push(callID);
            callKeys.add(callKey);
          }
          previousTurnID = canonicalTurn.id;
          previousTurnKey = turnKey;
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
        this.#prepare(`
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
        artifactCallPaths.set(
          artifact.externalID,
          [...implicitParentCallPrefix, ...pathCallIDs],
        );
      }

      for (const [childExternalID, launches] of launchTools) {
        const child = this.#prepare(`
          SELECT id FROM conversations
          WHERE source_id = ? AND external_id = ?
        `).get(family.sourceID, childExternalID) as { id: number } | undefined;
        if (child === undefined) continue;
        for (const launch of launches) {
          this.#prepare(`
            UPDATE conversation_tool_events SET child_conversation_id = ?
            WHERE id = ?
          `).run(child.id, launch.toolEventID);
        }
        const launch = launches[0];
        this.#prepare(`
          INSERT OR IGNORE INTO conversation_subagent_launches (
            parent_conversation_id, child_conversation_id, model_call_id,
            tool_event_id, provenance
          ) VALUES (?, ?, ?, ?, 'explicit-tool-link')
        `).run(
          conversationID,
          child.id,
          launch.modelCallID,
          launch.toolEventID,
        );
      }

      const familyArtifactExternalIDs = new Set(
        family.artifacts.map((artifact) => artifact.externalID),
      );
      for (const subagent of family.subagents ?? []) {
        if (!familyArtifactExternalIDs.has(subagent.parentExternalID ?? "")) {
          continue;
        }
        this.#prepare(`
          INSERT OR IGNORE INTO conversation_subagent_launches (
            parent_conversation_id, child_conversation_id, provenance
          ) VALUES (?, ?, 'source-ancestry')
        `).run(
          conversationID,
          subagentConversationIDs.get(subagent.externalID)!,
        );
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
      const reportedCost = reportedCosts.length > 0 &&
          reportedCosts.every((cost) => cost !== undefined)
        ? reportedCosts.reduce<number>((sum, cost) => sum + cost!, 0)
        : undefined;
      const computedCost = computedCosts.length > 0 &&
          computedCosts.every((cost) => cost !== undefined)
        ? computedCosts.reduce<number>((sum, cost) => sum + cost!, 0)
        : undefined;
      const canonicalContextEvents = [
        ...new Map(
          ordered.flatMap((artifact) =>
            artifact.value.session.contextEvents ?? []
          ).map((event) => [JSON.stringify(event), event]),
        ).values(),
      ].toSorted((a, b) => a.sourceOrder - b.sourceOrder);
      const canonicalSession: LinearConversationImport = {
        sourceID: family.sourceID,
        externalID: family.externalID,
        observedAt: Math.max(...ordered.map((item) => item.value.observedAt)),
        checkpoint: {},
        session: {
          title: root.value.session.title,
          agent: root.value.session.agent,
          updatedAt: Math.max(
            ...ordered.map((item) => item.value.session.updatedAt),
          ),
          startedAt: startedAt.length === 0
            ? undefined
            : Math.min(...startedAt),
          endedAt: endedAt.length === 0 ? undefined : Math.max(...endedAt),
          providers,
          models,
          userTurns: canonicalTurnValues.length,
          modelCalls: uniqueCalls.length,
          reportedCost,
          tokens: totalTokens,
          turns: canonicalTurnValues,
          contextEvents: canonicalContextEvents,
        },
      };
      const familyTree = [
        canonicalSession,
        ...(family.subagents ?? []).map((subagent) =>
          familyArtifactExternalIDs.has(subagent.parentExternalID ?? "")
            ? { ...subagent, parentExternalID: canonicalSession.externalID }
            : subagent
        ),
      ];
      const analyticsRollup = buildSessionRollup(familyTree);
      this.#prepare(`
        INSERT INTO conversation_rollups (
          conversation_id, rollup_version, user_turns, model_calls,
          reported_cost, computed_cost, uncached_input_tokens,
          cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
          cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
          reasoning_tokens, processed_tokens, first_activity_at,
          last_activity_at, subagent_model_calls,
          subagent_uncached_input_tokens, subagent_cache_read_tokens,
          subagent_cache_write_tokens, overview_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationID,
        analyticsRollup.version,
        canonicalTurns.size,
        uniqueCalls.length,
        reportedCost ?? null,
        computedCost ?? null,
        ...tokenValues(totalTokens),
        ...analyticsRollupValues(analyticsRollup).slice(1),
      );
      this.#insertCacheMisses(
        conversationID,
        canonicalSession.session,
        undefined,
        undefined,
        branchCallPredecessors,
      );
      this.#materializeSummary(
        conversationID,
        sessionDetailFromConversationImports(
          familyTree,
          canonicalSession.externalID,
          this.#sourceHarness(family.sourceID),
        ),
        analyticsRollup,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #insertLinearConversation(
    value: LinearConversationImport,
    conversationID: number,
    sourceArtifactID: number,
    launchTools: Map<
      string,
      Array<{ modelCallID: number; toolEventID: number }>
    >,
  ) {
    const analyticsRollup = buildSessionRollup([{
      ...value,
      parentExternalID: undefined,
    }]);
    const branchID = Number(
      (this.#prepare(`
      INSERT INTO conversation_branches (
        conversation_id, source_session_id, external_id,
        fork_point_provenance, updated_at
      ) VALUES (?, ?, ?, 'unresolved', ?)
      RETURNING id
    `).get(
          conversationID,
          sourceArtifactID,
          value.externalID,
          value.session.updatedAt,
        ) as { id: number }).id,
    );
    let previousTurnID: number | null = null;
    let previousEntryID: number | null = null;
    let entrySourceOrder = 0;
    let callOrdinal = 0;
    const turnIDs = new Map<number, number>();
    const callIDs = new Map<string, number>();

    const insertEntry = (options: {
      turnID?: number;
      stableSourceID?: string;
      kind: string;
      role?: string;
      occurredAt?: number;
      content?: ConversationContentImport;
      producerModelCallID?: number;
      producerToolEventID?: number;
      outputOrdinal?: number;
      nativeMetadata?: unknown;
      sourceOrder?: number;
    }) => {
      const entryID = Number(
        (this.#prepare(`
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
      this.#prepare(`
        INSERT INTO artifact_entry_occurrences (
          source_session_id, branch_id, entry_id, source_entry_id,
          source_order_start, source_order_end, occurrence_kind, identity_basis
        ) VALUES (?, ?, ?, ?, ?, ?, 'executed', 'unresolved')
      `).run(
        sourceArtifactID,
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
        (this.#prepare(`
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
      turnIDs.set(turn.number, turnID);

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
          (this.#prepare(`
          INSERT INTO conversation_model_calls (
            conversation_id, turn_id, source_call_id, ordinal,
            call_within_turn, provider, model, started_at, completed_at,
            reported_cost, computed_cost, uncached_input_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
            cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
            reasoning_tokens, processed_tokens, finish_reason, images,
            has_text, has_reasoning, reasoning_setting_name,
            reasoning_setting_value, reasoning_source_field_path,
            reasoning_source_order, reasoning_observed_at,
            reasoning_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              computeModelCallCost(
                call.tokens,
                call.model,
                call.startedAt,
              ) ?? null,
              ...tokenValues(call.tokens),
              call.activity.finishReason ?? null,
              call.activity.images ?? null,
              Number(call.activity.hasText),
              Number(call.activity.hasReasoning),
              ...reasoningValues(call.reasoningSetting),
            ) as { id: number }).id,
        );
        callIDs.set(`${turn.number}:${call.callWithinTurn}`, callID);
        this.#prepare(`
          INSERT INTO artifact_model_call_occurrences (
            source_session_id, branch_id, model_call_id, source_turn_id,
            source_call_id, occurrence_kind, identity_basis
          ) VALUES (?, ?, ?, ?, ?, 'executed', 'unresolved')
        `).run(
          sourceArtifactID,
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
            (this.#prepare(`
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
            const key = `${value.externalID}\0${tool.childExternalID}`;
            const launches = launchTools.get(key) ?? [];
            launches.push({ modelCallID: callID, toolEventID });
            launchTools.set(key, launches);
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

    this.#prepare(`
      UPDATE conversation_branches SET head_entry_id = ? WHERE id = ?
    `).run(previousEntryID, branchID);
    this.#insertCacheMisses(conversationID, value.session, callIDs, turnIDs);
    this.#prepare(`
      INSERT INTO conversation_rollups (
        conversation_id, rollup_version, user_turns, model_calls,
        reported_cost, computed_cost, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
        cache_write_1h_tokens, fresh_prompt_tokens, output_tokens,
        reasoning_tokens, processed_tokens, first_activity_at,
        last_activity_at, subagent_model_calls,
        subagent_uncached_input_tokens, subagent_cache_read_tokens,
        subagent_cache_write_tokens, overview_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationID,
      analyticsRollup.version,
      value.session.userTurns,
      value.session.modelCalls,
      value.session.reportedCost ?? null,
      computedConversationCost(value) ?? null,
      ...tokenValues(value.session.tokens),
      ...analyticsRollupValues(analyticsRollup).slice(1),
    );
  }

  #updateAnalyticsRollup(conversationID: number, rollup: SessionRollup) {
    this.#prepare(`
      UPDATE conversation_rollups SET
        rollup_version = ?, first_activity_at = ?, last_activity_at = ?,
        subagent_model_calls = ?, subagent_uncached_input_tokens = ?,
        subagent_cache_read_tokens = ?, subagent_cache_write_tokens = ?,
        overview_json = ?
      WHERE conversation_id = ?
    `).run(...analyticsRollupValues(rollup), conversationID);
  }

  #insertCacheMisses(
    conversationID: number,
    session: Pick<
      LinearConversationImport["session"],
      "turns" | "contextEvents"
    >,
    knownCallIDs?: Map<string, number>,
    knownTurnIDs?: Map<number, number>,
    knownPredecessors?: Map<number, number | undefined>,
  ) {
    const callRows = knownCallIDs === undefined
      ? this.#prepare(`
        SELECT call.id, call.call_within_turn, turn.id AS turn_id,
          turn.ordinal AS turn_ordinal
        FROM conversation_model_calls call
        JOIN conversation_turns turn ON turn.id = call.turn_id
        WHERE call.conversation_id = ?
        ORDER BY turn.ordinal, call.call_within_turn, call.ordinal
      `).all(conversationID) as Array<{
        id: number;
        call_within_turn: number;
        turn_id: number;
        turn_ordinal: number;
      }>
      : [];
    const callIDs = knownCallIDs ?? new Map(callRows.map((row) => [
      `${row.turn_ordinal}:${row.call_within_turn}`,
      row.id,
    ]));
    const turnIDs = knownTurnIDs ?? new Map(callRows.map((row) => [
      row.turn_ordinal,
      row.turn_id,
    ]));
    const callKeysByID = new Map(
      [...callIDs].map(([key, id]) => [id, key]),
    );
    const compactionCallKeys = new Set(
      (session.contextEvents ?? []).filter((event) =>
        event.type === "compaction" && event.affectedCall !== undefined
      ).map((event) =>
        `${event.affectedCall!.turn}:${event.affectedCall!.call}`
      ),
    );
    const cacheCalls: CacheAnalysisCall[] = session.turns.flatMap((turn) =>
      turn.calls.map((call) => {
        const analyzed: CacheAnalysisCall = {
          id: `${turn.number}:${call.callWithinTurn}`,
          provider: call.provider,
          model: call.model,
          startedAt: call.startedAt,
          tokens: call.tokens,
          reasoningSetting: call.reasoningSetting ?? turn.reasoningSetting,
          followsCompaction: compactionCallKeys.has(
            `${turn.number}:${call.callWithinTurn}`,
          ),
        };
        if (knownPredecessors !== undefined) {
          analyzed.previousCallID = callKeysByID.get(
            knownPredecessors.get(
              callIDs.get(`${turn.number}:${call.callWithinTurn}`)!,
            )!,
          );
          analyzed.predecessorResolved = true;
        }
        return analyzed;
      })
    );
    const callsByID = new Map(cacheCalls.map((call) => [call.id, call]));
    const insert = this.#prepare(`
      INSERT INTO conversation_cache_misses (
        model_call_id, previous_model_call_id, conversation_id, turn_id,
        started_at, gap_ms, status, reason, cause, retained_ratio,
        previous_reusable_tokens, previous_context_tokens,
        current_context_tokens, actual_cache_read_tokens, missed_tokens,
        model_call_cost, actual_missed_cost, expected_read_cost,
        estimated_extra_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const miss of analyzeCacheMisses(cacheCalls)) {
      const currentTurn = Number(miss.callID.split(":")[0]);
      const modelCallID = callIDs.get(miss.callID);
      const previousModelCallID = callIDs.get(miss.previousCallID);
      const turnID = turnIDs.get(currentTurn);
      const call = callsByID.get(miss.callID);
      if (
        modelCallID === undefined || previousModelCallID === undefined ||
        turnID === undefined || call === undefined
      ) {
        throw new Error(`Unknown conversation cache miss call: ${miss.callID}`);
      }
      insert.run(
        modelCallID,
        previousModelCallID,
        conversationID,
        turnID,
        call.startedAt,
        miss.gap,
        miss.status,
        miss.reason ?? null,
        miss.cause ?? null,
        miss.retainedRatio ?? null,
        miss.previousReusableTokens ?? null,
        miss.previousContextTokens,
        miss.currentContextTokens,
        miss.actualCacheReadTokens,
        miss.missedTokens,
        miss.modelCallCost ?? null,
        miss.actualMissedCost ?? null,
        miss.expectedReadCost ?? null,
        miss.estimatedExtraCost ?? null,
      );
    }
  }

  #materializeSummary(
    conversationID: number,
    detail: Parameters<typeof enrichSessionSummary>[0],
    rollup: SessionRollup,
  ) {
    const enriched = enrichSessionSummary(detail);
    const summary = sessionListItemSchema.parse(
      rollup.thinkingClassifiedCalls === 0 ? enriched : {
        ...enriched,
        thinking: {
          latest: rollup.thinkingLatest,
          values: rollup.thinkingValues,
          classifiedCalls: rollup.thinkingClassifiedCalls,
        },
      },
    );
    this.#prepare(`
      UPDATE conversation_rollups SET summary_json = ?
      WHERE conversation_id = ?
    `).run(JSON.stringify(summary), conversationID);
  }

  #sourceHarness(sourceID: number) {
    const row = this.#prepare(
      "SELECT harness FROM sources WHERE id = ?",
    ).get(sourceID) as { harness: SessionSummary["harness"] } | undefined;
    if (row === undefined) throw new Error(`Unknown source: ${sourceID}`);
    return row.harness;
  }
}
