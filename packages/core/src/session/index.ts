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

export type { PendingConfirm, SessionState, SuggestionRecord, SuspensionLiveness, SuspensionToolName } from "./sessionState.js";

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
} from "./turnOwnership.js";
export type {
  TurnOwnership,
  TurnWriteGuard,
  TurnWriteGuardAssertion,
} from "./turnOwnership.js";

export {
  buildCapabilityTools,
  createSessionScopedTools,
} from "./sessionTools.js";

export type { SelectedSkillInput } from "./sessionTools.js";

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
} from "./workingMemory.js";
export type {
  WorkingMemoryOperation,
  WorkingMemorySection,
  WorkingMemoryStorageTarget,
} from "./workingMemory.js";

export {
  estimateTurnCounterFromMessages,
  isOmSidecarEnabled,
  nextOmTurnIndex,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
} from "./omSidecar.js";

export { omSidecarThreadId, sessionOwnedThreadIds } from "./sessionShadowThreads.js";

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
} from "./threadPersistence.js";

export { deriveTitleFromDoc } from "./title.js";

export { resolveFileIds, UPLOADS_BASE } from "./uploadFileResolver.js";

export type {
  QingagentThreadMetadata,
  HomeSessionThread,
  MaterialRecord,
  SuggestionRecordJson,
} from "./threadPersistence.js";
