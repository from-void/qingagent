// Mastra
export { mastra, configureObservability, getObservability, getMemory } from "./mastra.js";
export { qingagentAgent, getQingagentSkills } from "./agents/qingagent.js";
export { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR, SKILLS_INSTALL_DIR } from "./skills/paths.js";
export { ARCHIVED_BUILTIN_SKILLS, isArchivedBuiltinSkillName } from "./skills/archived.js";
export { ensureNodeRuntimeShim, isElectronRuntime } from "./workspace/nodeRuntimeShim.js";
export { ensureLarkCliShim } from "./workspace/larkCliShim.js";
export { evaluateCommandPolicy } from "./workspace/commandPolicy.js";
export {
  buildSandboxEnv,
  SANDBOX_BIN_DIR,
  sandboxExtraReadOnlyPaths,
  resolveIsolation,
} from "./workspace/sessionWorkspace.js";
export { redactProbe } from "./workspace/probeRedaction.js";
export { getQingagentSessionWorkspace } from "./agents/qingagent.js";
export {
  readDisabledSet,
  writeDisabledSet,
  isDisabled,
  setEnabled,
} from "./skills/enabledStore.js";

// Tools
export { askUserTool } from "./tools/index.js";
export { parseFileTool } from "./tools/index.js";
export { parseFileBuffer } from "./tools/index.js";
export type {
  ParseFileBufferFailure,
  ParseFileBufferInput,
  ParseFileBufferOutput,
  ParseFileBufferResult,
} from "./tools/index.js";
export { storeMaterialTool } from "./tools/index.js";
export { fetchArticleTool } from "./tools/index.js";
export { systemBrowserExecutablePath, systemBrowserCandidates } from "./browser/systemBrowser.js";
export { webSearchTool } from "./tools/index.js";
export { generateSvgTool } from "./tools/index.js";
export { readImageTool } from "./tools/index.js";
export { runJsTool, runJsInWorker } from "./tools/index.js";
export type { RunJsInput, RunJsResult } from "./tools/index.js";
export { runPythonTool, getPyodideTools } from "./tools/index.js";
export type { RunPythonInput, RunPythonResult } from "./tools/index.js";
export { streamMoreQuestions } from "./tools/index.js";
export { redactSensitiveText } from "./bridge/redaction.js";
export { extractJsonArray } from "./utils/extractJsonArray.js";
export {
  guardBeforeProviderCall,
  guardContext,
  guardReset,
  withPrefixCacheGuardContext,
  PrefixCacheGuardError,
} from "./llm/prefixCacheGuard.js";
export {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL_IDS,
  DEEPSEEK_CONTEXT_WINDOWS,
  MODEL_OVERRIDES_CONTEXT_KEY,
  resolveBaseUrl,
  resolveDeepseekAuth,
  resolveDeepseekRouterModelId,
  resolveModelId,
  resolveModelParams,
  resolveModelTier,
  createDeepseekProvider,
  getDeepseekModel,
  sanitizeBaseUrl,
  sanitizeModelId,
  resolveVisionConfig,
  getVisionModel,
  anthropicBaseUrl,
} from "./llm/modelConfig.js";
export { installNetProbe } from "./llm/netProbe.js";
export { warmUpModelEndpoint } from "./llm/modelWarmup.js";
export {
  VISION_TEST_TIMEOUT_MS,
  testVisionConnection,
} from "./llm/visionTest.js";
export { testTextModelConnection } from "./llm/textConnectionTest.js";
export type { TextConnectionTestInput } from "./llm/textConnectionTest.js";
export type {
  ApiKeyOrigin,
  DeepseekTier,
  ModelProtocol,
  ModelOverrides,
  ModelParamOverrides,
  ResolvedDeepseekAuth,
  ResolvedVisionConfig,
  UsageTrackedModelOptions,
} from "./llm/modelConfig.js";
export {
  DEFAULT_DEEPSEEK_PRICING_CNY_PER_MILLION,
  estimateCostCny,
  getDeepseekPricingTable,
} from "./llm/deepseekPricing.js";
export type {
  DeepseekModelPricing,
  DeepseekPricingTable,
  TokenUsageForCost,
} from "./llm/deepseekPricing.js";
export type {
  PrefixCacheGuardContext,
  PrefixCacheGuardDiff,
  PrefixCacheGuardLineage,
  PrefixCacheGuardResult,
} from "./llm/prefixCacheGuard.js";

// Types
export type { Material } from "./types/material.js";

// Export
export { toDocx, toHtml, toMarkdown, toPdf, toTxt, withRenderedDiagrams } from "./export/index.js";
export { setHtmlToPdfRenderer, getHtmlToPdfRenderer } from "./export/index.js";
export type { ExportOptions, HtmlToPdfRenderer } from "./export/index.js";
export { pmToHomeArticleMeta } from "./home/pmToHomeArticleMeta.js";
export type { HomeArticleMeta, HomeArticleMetaInput } from "./home/pmToHomeArticleMeta.js";
export { validateFetchUrl } from "./browser/extractor.js";
export { deriveTitleFromSections } from "./bridge/title.js";

// 桌面端首启示例内容(分叉骨架,once 门在桌面主进程)
export { seedInitialContent } from "./seed/seedInitialContent.js";

// Documents shadow table
export { documentRepo, projectPmDocToSections } from "./db/documentRepo.js";
export { deleteDocumentFamily } from "./db/documentFamilyRepo.js";
export type {
  DocumentRepo,
  DocumentRow,
  DocumentSaveInput,
} from "./db/documentRepo.js";
export {
  ensureMigrated,
  runMigrations,
  assertMigrationsContinuous,
  __resetMigrationsForTest,
  __setMigrationsForTest,
} from "./db/migrations.js";
export type { Migration, MigrationResult } from "./db/migrations.js";
export { getDocumentsClient } from "./db/documentsClient.js";
export {
  SETTING_DEEPSEEK_GLOBAL_KEY,
  SETTING_MODEL_PARAMS,
  SETTING_SEARCH_PRIMARY,
  SETTING_SEARCH_PROVIDER_CONFIG,
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
} from "./db/appSettingsRepo.js";
export {
  SearchProviderError,
  classifySearchHttpStatus,
  searchProviderErrorFromStatus,
} from "./search/errors.js";
export type { SearchProviderErrorKind } from "./search/errors.js";
export {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_REGISTRY,
  getSearchProviderRegistryEntry,
  isSearchProviderId,
} from "./search/registry.js";
export type {
  SearchProviderConfig,
  SearchProviderConfigMap,
  SearchProviderId,
  SearchProviderKind,
  SearchProviderRegistryEntry,
} from "./search/registry.js";
export {
  SEARCH_PROVIDER_QUOTA_COOLDOWN_MS,
  clearSearchProviderHealth,
  getSearchProviderHealth,
  markSearchProviderAuthFailed,
  markSearchProviderQuota,
  recordSearchProviderError,
  shouldSkipSearchProvider,
} from "./search/health.js";
export type {
  SearchProviderHealth,
  SearchProviderHealthStatus,
} from "./search/health.js";
export {
  clearManagedSearchProviderHealth,
  getManagedSearchProvider,
  getPrimarySearchConfig,
  getSearchProviderConfig,
  invalidateManagedSearchConfig,
  invalidatePrimarySearchConfig,
  parsePrimarySearchConfig,
  parseSearchProviderConfig,
} from "./search/managedSearch.js";
export type { PrimarySearchConfig } from "./search/managedSearch.js";
export { describeToolsForDebug } from "./debug/toolsInspector.js";
export type { DebugToolEntry } from "./debug/toolsInspector.js";
export {
  DEFAULT_DIAG_ERROR_FIELD_BYTES,
  DEFAULT_DIAG_FIELD_BYTES,
  classifyDiagLayer,
  exportedSpanToDiagSpan,
  statusFromError,
  truncateField,
} from "./diagnostics/diagSpan.js";
export {
  browserFolderSourcesEnabled,
  folderSourcesToWire,
  getSessionFolderSources,
  localFolderSourcesEnabled,
  markFolderSourceDetached,
  registerSessionFolderSources,
  toFolderSourceWire,
  unregisterSessionFolderSources,
} from "./folderSources/runtime.js";
export {
  BrowserBridgeFilesystem,
  __browserFolderBridgeStatsForTest,
  __resetBrowserFolderBridgeForTest,
  getBrowserFolderBridgeClientFolderIds,
  getBrowserFolderBridgePendingRequest,
  isBrowserFolderBridgeClientRegistered,
  isBrowserFolderSourceRegistered,
  openBrowserFolderBridgeConnection,
  registerBrowserFolderSource,
  requestBrowserFolderBridge,
  resolveBrowserFolderBridgeResponse,
  unregisterBrowserFolderSession,
  unregisterBrowserFolderSource,
} from "./workspace/browserBridgeFilesystem.js";
export type {
  BrowserFolderBridgeBoundResponse,
  BrowserFolderBridgeEntry,
  BrowserFolderBridgeRequest,
  BrowserFolderBridgeResponse,
  BrowserFolderBridgeStat,
} from "./workspace/browserBridgeFilesystem.js";
export {
  clearFolderSourceCache,
  clearSessionFolderSourceCache,
  cleanupOldFolderSourceCaches,
} from "./folderSources/cache.js";
export {
  readDocumentForSession,
  resolveFolderSourcePath,
  searchDocumentsForSession,
} from "./tools/index.js";
export type {
  ReadDocumentResult,
  ResolvedFolderSourcePath,
  SearchDocumentsResult,
} from "./tools/index.js";
export {
  aggregateUsageByDay,
  aggregateUsageBySession,
  aggregateUsageTotal,
  latestAgentUsageForSession,
  recordUsageEvent,
} from "./db/usageRepo.js";
export type {
  UsageAggRow,
  UsageEventInput,
} from "./db/usageRepo.js";
export {
  getVersionSnapshot,
  listVersions,
} from "./db/documentVersionRepo.js";
export type {
  DocumentVersionRow,
} from "./db/documentVersionRepo.js";
export { documentDraftRepo } from "./db/documentDraftRepo.js";
export type {
  DocumentDraftRow,
  DocumentDraftStatus,
  SaveCandidateDraftInput,
  SavePendingDraftInput,
} from "./db/documentDraftRepo.js";
export { migrateThreadMetadataToDocuments } from "./db/migrateThreadMetadataToDocuments.js";
export type { MigrationStats } from "./db/migrateThreadMetadataToDocuments.js";
export {
  QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY,
} from "./llm/workingMemoryPrompt.js";
export {
  QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY,
} from "./llm/omObservationsPrompt.js";

// Bridge
export {
  createSession,
  activeSuspensionOwnedBy,
  clearSuspension,
  clearStaleSuspensionIfInactive,
  createSessionScopedTools,
  buildCapabilityTools,
  abortAndCleanupTurn,
  finalizeLingeringRunningToolCalls,
  getActiveSuspensionOwner,
  getSuspensionLiveness,
  hasActiveSuspension,
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  buildTodoAwarenessContent,
  ensureWorkingMemorySnapshot,
  ensureWorkingMemorySnapshotWithStatus,
  nextSeq,
  runAgentTurn,
  serializeReviewOutcome,
  processAgentStream,
  estimateTurnCounterFromMessages,
  isOmSidecarEnabled,
  nextOmTurnIndex,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
  terminalizeAskUserToolCall,
  updatePatchVerdict,
  commitPatches,
  expandReviewIds,
  commitReviewGroups,
  rehydratePendingDraft,
  rebaseRemainingPendingDraft,
  buildMaterialFromParse,
  findMaterialByFileId,
  materialResourceUpsertedFrame,
  materialToResource,
  parseFileFailureFromResult,
  stableErrorMaterialId,
  upsertMaterialByFileId,
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
  commitDocumentOp,
  clonePmDoc,
  hasApplicableSuggestion,
  hasCanonicalDoc,
  currentPmDoc,
  ensureDraftCandidateDoc,
  replaceDraftCandidateDoc,
  settleDraftCandidate,
  buildDocumentSnapshot,
  cloneLegacySections,
  deriveDocStateFacts,
  emitDocumentSnapshotFrames,
  idleDocState,
  normalizePersistedDocStateKind,
  normalizeRestoredDocStateKind,
  normalizeTargetDocState,
  transitionDocState,
  DocStateTransitionError,
  docSectionSchema,
  legacySectionsSchema,
  createSessionThread,
  drainSessionPersistence,
  persistSessionMetadata,
  schedulePersist,
  loadSessionFromThread,
  listSessionThreads,
  deleteSessionThread,
  cleanRestoredText,
  sessionIdToTraceId,
  buildAgentTracingMetadata,
  AGENT_MAX_STEPS,
  collectTopLevelTextBlocks,
  findLiteralMatches,
  isServerReanchorEnabled,
  isTruthyFlag,
  replaceTextRuns,
  coerceLegacyContentKind,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  emitProjectedDocState,
  QINGAGENT_RESOURCE_ID,
  __getSessionPersistenceStateForTest,
  __resetSessionPersistenceForTest,
} from "./bridge/index.js";
export { resolveFileIds, UPLOADS_BASE } from "./bridge/uploadFileResolver.js";

export type {
  SessionState,
  SuggestionRecord,
  DocStateFacts,
  DocStateTransitionReason,
  RestoreDocStateFacts,
  TransitionDocStateOptions,
  ActiveOverlay,
  EditorState,
  QingagentThreadMetadata,
  MaterialRecord,
  SuggestionRecordJson,
  PendingDraftRehydrateResult,
  PendingDraftRebaseResult,
  RebaseRemainingPendingDraftInput,
  CommitDocumentOpInput,
  CommitDocumentOpResult,
  CommitIdempotencyKey,
  PmValidationError,
  AskUserAnswerRecord,
  MaterialParseFailure,
  MaterialParseFailureKind,
  MaterialParseOutcome,
  MaterialParseSource,
  UpsertMaterialByFileIdResult,
} from "./bridge/index.js";
export type { ResolvedUploadedFile } from "./bridge/uploadFileResolver.js";

// 沙箱凭据子系统(后端 API 录入,加密落库,注入会话沙箱)
export {
  saveCredentialRecord,
  getCredentialsForPlatform,
  getAllCredentialEnv,
  listCredentialMeta,
  deleteCredential,
  redactSecret,
  PLATFORM_CREDENTIAL_SPECS,
  type CredentialInput,
  type CredentialMeta,
  type PlatformCredentialSpec,
} from "./credentials/index.js";
export { invalidateSessionWorkspace } from "./workspace/sessionWorkspace.js";
