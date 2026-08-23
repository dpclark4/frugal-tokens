import type {
  CompactionCheckpointItem,
  CompactionDetail,
  ContextEvent,
  ModelCall,
  TokenUsage,
} from "../shared/sessionSchemas.ts";

export type ConversationContentImport = {
  kind: string;
  sourceID?: string;
  sourceOrder?: number;
  preview?: string;
  originalLength?: number;
  truncated?: boolean;
  mimeType?: string;
  contentHash?: string;
};

export type ConversationToolImport =
  & Omit<ModelCall["activity"]["tools"][number], "childSessionID">
  & {
    sourceID?: string;
    sourceEntryID?: string;
    outputSourceEntryID?: string;
    sourceOrderStart?: number;
    sourceOrderEnd?: number;
    childExternalID?: string;
    sourceChildSessionID?: string;
    input?: Omit<
      ConversationContentImport,
      "kind" | "mimeType" | "contentHash"
    >;
    output?: Omit<
      ConversationContentImport,
      "kind" | "mimeType" | "contentHash"
    >;
  };

export type ReasoningSettingImport = {
  settingName: string;
  settingValue: string;
  sourceFieldPath?: string;
  sourceOrder?: number;
  observedAt?: number;
  provenance: "explicit" | "inherited" | "session_fallback";
};

export type ConversationCallImport =
  & Omit<ModelCall, "activity" | "contextEventsBefore">
  & {
    sourceID?: string;
    sourceOrderStart?: number;
    sourceOrderEnd?: number;
    identityBasis?: "stable-id" | "explicit-lineage" | "unresolved";
    activity: Omit<ModelCall["activity"], "tools"> & {
      tools: ConversationToolImport[];
    };
    content?: ConversationContentImport[];
    reasoningSetting?: ReasoningSettingImport;
  };

export type CompactionCheckpointItemImport =
  & Omit<CompactionCheckpointItem, "ordinal">
  & { ordinal?: number };

export type CompactionDetailImport =
  & Omit<CompactionDetail, "checkpointItems">
  & { checkpointItems: CompactionCheckpointItemImport[] };

export type ConversationContextEventImport =
  & Omit<ContextEvent, "compaction">
  & {
    affectedCall?: { turn: number; call: number };
    compaction?: CompactionDetailImport;
  };

export type ConversationTurnImport = {
  number: number;
  sourceID?: string;
  sourceOrderStart?: number;
  sourceOrderEnd?: number;
  identityBasis?: "stable-id" | "explicit-lineage" | "unresolved";
  startedAt: number;
  inputs?: ConversationContentImport[];
  reasoningSetting?: ReasoningSettingImport;
  calls: ConversationCallImport[];
};

/** A complete normalized linear artifact ready for conversation storage. */
export type LinearConversationImport = {
  sourceID: number;
  externalID: string;
  publicID?: string;
  parentExternalID?: string;
  artifactPath?: string;
  workingDirectory?: string;
  observedAt: number;
  checkpoint: {
    changeHint?: string;
    sourceSize?: number;
    sourceModifiedAt?: number;
    checksum?: string;
    parserVersion?: string;
    importedAt?: number;
  };
  session: {
    title: string;
    agent?: string;
    updatedAt: number;
    startedAt?: number;
    endedAt?: number;
    providers: string[];
    models: string[];
    userTurns: number;
    modelCalls: number;
    reportedCost?: number;
    tokens: TokenUsage;
    turns: ConversationTurnImport[];
    contextEvents?: ConversationContextEventImport[];
  };
};
