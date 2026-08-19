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
} from "../session/sessionState.js";
export type { PendingConfirm, SessionState, SuggestionRecord, SuspensionLiveness, SuspensionToolName } from "../session/sessionState.js";

export {
  TURN_GENERATION_REQUEST_CONTEXT_KEY,
  TURN_OWNER_REQUEST_CONTEXT_KEY,
  TURN_WRITE_GUARD_FACTORY_REQUEST_CONTEXT_KEY,
  assertTurnWriteAllowed,
  beginTurnOwnership,
  bindTurnOwnershipToRequestContext,
  bindTurnWriteGuardFactoryToRequestContext,
  captureBoundTurnWriteGuard,
  captureTurnWriteGuard,
  endTurnOwnership,
  invalidateTurnOwnership,
  turnOwnershipFromRequestContext,
} from "../session/turnOwnership.js";
export type {
  TurnOwnership,
  TurnWriteGuard,
  TurnWriteGuardAssertion,
} from "../session/turnOwnership.js";

export {
  ConfirmDecisionError,
  ConfirmService,
  confirmService,
  secretLeaseStore,
} from "../confirm/index.js";
export type { SafeSubmitConfirmDecision } from "../confirm/index.js";

export {
  AGENT_MAX_STEPS,
} from "../agent-run/agentLimits.js";

export {
  buildAgentTracingMetadata,
  sessionIdToTraceId,
} from "../agent-run/agentSpans.js";

export {
  invalidateDraftStateAfterCanonicalWrite,
  clearInMemoryDraftDocs,
  clonePmDoc,
  currentPmDoc,
  ensureDraftCandidateDoc,
  replaceDraftCandidateDoc,
} from "../doc-engine/draftScratch.js";

export {
  settleDraftCandidate,
} from "../doc-engine/settleDraftCandidate.js";

export {
  isWholeDocumentSuggestionBatchId,
} from "../doc-engine/draftReviewSuggestions.js";

export {
  abortAndCleanupTurn,
  finalizeLingeringRunningToolCalls,
} from "../agent-run/turnCleanup.js";
export {
  terminateSessionBackgroundCommands,
} from "../agent-run/backgroundCommandTermination.js";

export {
  buildCapabilityTools,
  buildSessionScopedToolsInput,
  createSessionScopedTools,
} from "../session/sessionTools.js";
export type { SelectedSkillInput } from "../session/sessionTools.js";

export {
  runAgentTurn,
} from "../agent-run/runAgentTurn.js";

export {
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  buildTodoAwarenessContent,
} from "../agent-run/todoAwareness.js";

export {
  ensureWorkingMemorySnapshot,
  ensureWorkingMemorySnapshotWithStatus,
  mergeWorkingMemoryOperations,
  normalizeWorkingMemoryContent,
  readWorkingMemoryContent,
  writeWorkingMemoryContent,
  withWorkingMemoryWriteLock,
  QINGAGENT_WORKING_MEMORY_MAX_CHARS,
  QINGAGENT_WORKING_MEMORY_SECTIONS,
  QINGAGENT_WORKING_MEMORY_TEMPLATE,
  WorkingMemoryContentError,
} from "../session/workingMemory.js";
export type {
  WorkingMemoryOperation,
  WorkingMemorySection,
  WorkingMemoryStorageTarget,
} from "../session/workingMemory.js";

export {
  processAgentStream,
} from "../agent-run/processAgentStream.js";
export type {
  ProcessAgentStreamOptions,
  ProcessOutcome,
} from "../agent-run/processAgentStream.js";

export {
  cancelConfirmedCommand,
  failConfirmedToolCall,
  resumeConfirmDecision,
} from "../agent-run/confirmResume.js";
export type { ApprovalAgent } from "../agent-run/confirmResume.js";

export {
  estimateTurnCounterFromMessages,
  isOmSidecarEnabled,
  nextOmTurnIndex,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
} from "../session/omSidecar.js";

export {
  updatePatchVerdict,
  commitPatches,
  expandReviewIds,
  commitReviewGroups,
} from "../doc-engine/reviewCommit.js";

export {
  buildDocumentSnapshot,
  emitDocumentSnapshotFrames,
} from "../doc-engine/docGenerator.js";

export {
  hasNonEmptyCanonicalBase,
} from "../doc-engine/draftScratch.js";

export {
  hasApplicableSuggestion,
  hasCanonicalDoc,
} from "../doc-engine/docFacts.js";

export {
  buildAnnotationMappingSteps,
  mapAnnotationGroupsThroughSteps,
} from "../doc-engine/annotationMapping.js";
export type { MappedAnnotationGroups } from "../doc-engine/annotationMapping.js";

export {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  emitProjectedDocState,
} from "../doc-engine/docStateMachine.js";
export type {
  ActiveOverlay,
  EditorState,
} from "../doc-engine/docStateMachine.js";

export {
  advanceLastContentEditedAt,
  commitDocumentOp,
  getDocumentVersionCommittedAt,
} from "../doc-engine/commitDocumentOp.js";
export type {
  CommitDocumentOpInput,
  CommitDocumentOpResult,
  CommitIdempotencyKey,
  PmValidationError,
} from "../doc-engine/commitDocumentOp.js";

export {
  buildMaterialFromParse,
  findMaterialByFileId,
  materialResourceUpsertedFrame,
  materialToResource,
  parseFileFailureFromResult,
  stableErrorMaterialId,
  upsertMaterialByFileId,
} from "../session/materialResource.js";
export type {
  MaterialParseFailure,
  MaterialParseFailureKind,
  MaterialParseOutcome,
  MaterialParseSource,
  UpsertMaterialByFileIdResult,
} from "../session/materialResource.js";

export {
  collectTopLevelTextBlocks,
  findLiteralMatches,
  findSafeRegexMatches,
  markTextRuns,
  replaceTextRuns,
} from "../doc-engine/textEditOps.js";
export type {
  QuoteMatch,
  TextBlockRef,
} from "../doc-engine/textEditOps.js";

export {
  compileSafeRegex,
  execSafeRegexAll,
} from "../agent-run/safeRegex.js";
export type {
  CompileSafeRegexResult,
  ExecSafeRegexResult,
} from "../agent-run/safeRegex.js";

export { serializeReviewOutcome } from "../doc-engine/reviewOutcome.js";
export { rehydratePendingDraft } from "../doc-engine/pendingDraftRehydrate.js";
export type { PendingDraftRehydrateResult } from "../doc-engine/pendingDraftRehydrate.js";
export { rebaseRemainingPendingDraft } from "../doc-engine/pendingDraftRebase.js";
export type { PendingDraftRebaseResult, RebaseRemainingPendingDraftInput } from "../doc-engine/pendingDraftRebase.js";
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
} from "../agent-run/askUserAnswerMessage.js";
export type { AskUserAnswerRecord } from "../agent-run/askUserAnswerMessage.js";

export {
  deriveDocStateFacts,
  idleDocState,
  normalizePersistedDocStateKind,
  normalizeRestoredDocStateKind,
  normalizeTargetDocState,
  transitionDocState,
  DocStateTransitionError,
} from "../doc-engine/docStateTransitions.js";
export type {
  DocStateFacts,
  DocStateTransitionReason,
  RestoreDocStateFacts,
  TransitionDocStateOptions,
} from "../doc-engine/docStateTransitions.js";

export {
  createSessionThread,
  drainSessionPersistence,
  drainSessionPersistenceForSession,
  isSessionDeleted,
  markSessionDeleted,
  resolveSessionDocumentId,
  unmarkSessionDeleted,
  persistSessionMetadata,
  schedulePersist,
  loadSessionFromThread,
  listHomeSessionThreads,
  listSessionThreads,
  deleteSessionThread,
  cleanRestoredText,
  QINGAGENT_RESOURCE_ID,
  __getSessionPersistenceStateForTest,
  __resetSessionPersistenceForTest,
} from "../session/threadPersistence.js";

export { isSensitiveField, redactSensitiveText } from "../agent-run/redaction.js";
export { deriveTitleFromDoc } from "../session/title.js";
export {
  interruptQuestionnaireSpecForRestore,
  isDirectionReset,
  isPlanDraftTool,
  isQuestionnaireTool,
  normalizeQuestionnaireSpecForRestore,
} from "../agent-run/questionnaireTools.js";
export { resolveFileIds, UPLOADS_BASE } from "../session/uploadFileResolver.js";

export type {
  QingagentThreadMetadata,
  HomeSessionThread,
  MaterialRecord,
  SuggestionRecordJson,
} from "../session/threadPersistence.js";
