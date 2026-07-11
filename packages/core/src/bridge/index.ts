export {
  activeSuspensionOwnedBy,
  appendPartToChatHistory,
  clearSuspension,
  clearStaleSuspensionIfInactive,
  createSession,
  getActiveSuspensionOwner,
  getSuspensionLiveness,
  hasActiveSuspension,
  nextSeq,
  recordSuspension,
  terminalizeAskUserToolCall,
  updateToolCallInChatHistory,
} from "./sessionState.js";
export type { SessionState, SuggestionRecord, SuspensionLiveness, SuspensionToolName } from "./sessionState.js";

export {
  AGENT_MAX_STEPS,
} from "./agentLimits.js";

export {
  buildAgentTracingMetadata,
  sessionIdToTraceId,
} from "./agentSpans.js";

export {
  clearDraftMutationScratch,
  clearInMemoryDraftDocs,
  clonePmDoc,
  currentPmDoc,
  ensureDraftCandidateDoc,
  replaceDraftCandidateDoc,
} from "./draftScratch.js";

export {
  settleDraftCandidate,
} from "./settleDraftCandidate.js";

export {
  abortAndCleanupTurn,
  finalizeLingeringRunningToolCalls,
} from "./turnCleanup.js";

export {
  buildCapabilityTools,
  createSessionScopedTools,
} from "./sessionTools.js";
export type { SelectedSkillInput } from "./sessionTools.js";

export {
  runAgentTurn,
} from "./runAgentTurn.js";

export {
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  buildTodoAwarenessContent,
} from "./todoAwareness.js";

export {
  ensureWorkingMemorySnapshot,
  ensureWorkingMemorySnapshotWithStatus,
} from "./workingMemory.js";

export {
  processAgentStream,
} from "./processAgentStream.js";
export type {
  ProcessAgentStreamOptions,
  ProcessOutcome,
} from "./processAgentStream.js";

export {
  estimateTurnCounterFromMessages,
  isOmSidecarEnabled,
  nextOmTurnIndex,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
} from "./omSidecar.js";

export {
  updatePatchVerdict,
  commitPatches,
  expandReviewIds,
  commitReviewGroups,
} from "./reviewCommit.js";

export {
  parseLegacySections,
  extractJson,
  buildDocumentSnapshot,
  emitDocumentSnapshotFrames,
  docSectionSchema,
  legacySectionsSchema,
} from "./docGenerator.js";

export {
  cloneLegacySections,
} from "./docDiff.js";

export {
  hasApplicableSuggestion,
  hasCanonicalDoc,
} from "./docFacts.js";

export {
  isServerReanchorEnabled,
  isTruthyFlag,
} from "./draftFeatureFlags.js";

export {
  coerceLegacyContentKind,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  emitProjectedDocState,
} from "./docStateMachine.js";
export type {
  ActiveOverlay,
  EditorState,
} from "./docStateMachine.js";

export {
  commitDocumentOp,
} from "./commitDocumentOp.js";
export type {
  CommitDocumentOpInput,
  CommitDocumentOpResult,
  CommitIdempotencyKey,
  PmValidationError,
} from "./commitDocumentOp.js";

export {
  buildMaterialFromParse,
  findMaterialByFileId,
  materialResourceUpsertedFrame,
  materialToResource,
  parseFileFailureFromResult,
  stableErrorMaterialId,
  upsertMaterialByFileId,
} from "./materialResource.js";
export type {
  MaterialParseFailure,
  MaterialParseFailureKind,
  MaterialParseOutcome,
  MaterialParseSource,
  UpsertMaterialByFileIdResult,
} from "./materialResource.js";

export {
  collectTopLevelTextBlocks,
  findLiteralMatches,
  findSafeRegexMatches,
  markTextRuns,
  replaceTextRuns,
} from "./textEditOps.js";
export type {
  QuoteMatch,
  TextBlockRef,
} from "./textEditOps.js";

export {
  compileSafeRegex,
  execSafeRegexAll,
} from "./safeRegex.js";
export type {
  CompileSafeRegexResult,
  ExecSafeRegexResult,
} from "./safeRegex.js";

export { serializeReviewOutcome } from "./reviewOutcome.js";
export { rehydratePendingDraft } from "./pendingDraftRehydrate.js";
export type { PendingDraftRehydrateResult } from "./pendingDraftRehydrate.js";
export { rebaseRemainingPendingDraft } from "./pendingDraftRebase.js";
export type { PendingDraftRebaseResult, RebaseRemainingPendingDraftInput } from "./pendingDraftRebase.js";
export {
  appendAskUserAnswerMessageIfMissing,
  appendMissingAskUserAnswerMessagesFromChatHistory,
  appendMissingVisibleAskUserAnswerMessagesFromChatHistory,
  askUserAnswerMarker,
  buildAskUserAnswerCardItems,
  buildAskUserAnswerUserMessage,
  buildVisibleAskUserAnswerMessage,
  enrichAskUserResumeAnswersWithLabels,
  findAskUserToolCallSpecInChatHistory,
  hasAskUserAnswerMessage,
  hasVisibleAskUserAnswerMessage,
  normalizeAskUserAnswers,
  visibleAskUserAnswerMessageId,
} from "./askUserAnswerMessage.js";
export type { AskUserAnswerRecord } from "./askUserAnswerMessage.js";

export {
  deriveDocStateFacts,
  idleDocState,
  normalizePersistedDocStateKind,
  normalizeRestoredDocStateKind,
  normalizeTargetDocState,
  transitionDocState,
  DocStateTransitionError,
} from "./docStateTransitions.js";
export type {
  DocStateFacts,
  DocStateTransitionReason,
  RestoreDocStateFacts,
  TransitionDocStateOptions,
} from "./docStateTransitions.js";

export {
  createSessionThread,
  drainSessionPersistence,
  persistSessionMetadata,
  schedulePersist,
  loadSessionFromThread,
  listSessionThreads,
  deleteSessionThread,
  cleanRestoredText,
  QINGAGENT_RESOURCE_ID,
  __getSessionPersistenceStateForTest,
  __resetSessionPersistenceForTest,
} from "./threadPersistence.js";

export type {
  QingagentThreadMetadata,
  MaterialRecord,
  SuggestionRecordJson,
} from "./threadPersistence.js";
