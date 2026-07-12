export {
  clearDraftMutationScratch,
  invalidateDraftStateAfterCanonicalWrite,
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
  advanceLastContentEditedAt,
  commitDocumentOp,
  getDocumentVersionCommittedAt,
} from "./commitDocumentOp.js";

export type {
  CommitDocumentOpInput,
  CommitDocumentOpResult,
  CommitIdempotencyKey,
  PmValidationError,
} from "./commitDocumentOp.js";

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

export { serializeReviewOutcome } from "./reviewOutcome.js";

export { rehydratePendingDraft } from "./pendingDraftRehydrate.js";

export type { PendingDraftRehydrateResult } from "./pendingDraftRehydrate.js";

export { rebaseRemainingPendingDraft } from "./pendingDraftRebase.js";

export type { PendingDraftRebaseResult, RebaseRemainingPendingDraftInput } from "./pendingDraftRebase.js";

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

export { migrateThreadMetadataToDocuments } from "./migrateThreadMetadataToDocuments.js";

export type {
  MigrationOptions,
  MigrationStats,
} from "./migrateThreadMetadataToDocuments.js";

