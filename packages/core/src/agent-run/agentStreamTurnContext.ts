import type {
  BridgeFrame,
  DocState,
} from "@qingagent/contract-ts";
import type { RequestContext } from "@mastra/core/request-context";
import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import { basename } from "node:path";
import { mastra } from "../mastra.js";
import type { SessionState } from "../session/sessionState.js";
import {
  AGENT_FIRST_CHUNK_TIMEOUT_MS,
  AGENT_IDLE_TIMEOUT_MS,
  AGENT_TOOL_HEARTBEAT_TIMEOUT_MS,
} from "./agentLimits.js";
import {
  resolveFileIds,
  type ResolvedUploadedFile,
} from "../session/uploadFileResolver.js";
import {
  upsertMaterialByFileId,
  type MaterialParseFailure,
} from "../session/materialResource.js";
import { schedulePersist } from "../session/threadPersistence.js";
import type {
  AskUserPurposeKind,
} from "./toolCards.js";
import type { QuestionnaireToolName } from "./questionnaireTools.js";
import { AnnotationPreviewState } from "./annotationPreview.js";
import { currentPmDoc } from "../doc-engine/draftScratch.js";
import { confirmService, type ConfirmService } from "../confirm/confirmService.js";

const logger = mastra.getLogger();

export interface ProcessAgentStreamOptions {
  state: SessionState;
  agentMessageId: string;
  streamId: string;
  runId: string;
  userText?: string;
  /** Upload fileIds from the current turn, used to link materials to their source files. */
  fileIds?: string[];
  requestContext?: RequestContext;
  idleTimeoutMs?: number;
  /** 首个非 heartbeat chunk 到达前的宽限窗口。 */
  firstChunkTimeoutMs?: number;
  /** 连续只有 tool-heartbeat、没有真实流事件时的硬收口窗口。 */
  toolHeartbeatTimeoutMs?: number;
  /** 调用方能安全自动重试时，零产出 idle-timeout 先只返回 outcome，不在本层展示失败。 */
  deferRetryableIdleTimeout?: boolean;
  abortController?: AbortController;
  /** 仅测试注入；生产统一使用模块级 ConfirmService。 */
  confirmService?: ConfirmService;
}

export interface ProcessOutcome {
  producedVisibleFrame: boolean;
  sawToolCall: boolean;
  streamWasUserAborted: boolean;
  /** askUser 重放不算副作用，供瞬态错误重试守卫区分。 */
  sawSideEffectToolCall: boolean;
  transientErrorChunk?: unknown;
  retryableIdleTimeoutChunk?: unknown;
}

export interface ExtractedTextEntry {
  text: string;
  sourceUrl: string | null;
  fileId: string | null;
  sourceKind?: "github";
}

export interface AgentStreamTurnContext {
  readonly state: SessionState;
  readonly agentMessageId: string;
  readonly streamId: string;
  readonly runId: string;
  readonly userText: string;
  readonly requestContext?: RequestContext;
  readonly abortController: AbortController;
  readonly outcome: ProcessOutcome;
  readonly previousStreamId: string | null;
  readonly restoreStreamIdOnExit: boolean;
  readonly streamStartTime: number;
  readonly docVersionBeforeStream: number;
  readonly timeoutMs: number;
  readonly firstChunkTimeoutMs: number;
  readonly toolHeartbeatTimeoutMs: number;
  readonly deferRetryableIdleTimeout: boolean;
  readonly confirmService: ConfirmService;

  firstChunkLogged: boolean;
  accumulatedText: string;
  reasoningId: string | null;
  materialFrames: BridgeFrame[];
  extractedTexts: Map<string, ExtractedTextEntry>;
  researchFullTexts: Map<string, { text: string; materialId: string | null }>;
  extractionEventsThisTurn: ExtractedTextEntry[];
  consumedExtractions: Set<ExtractedTextEntry>;
  validPatchCount: number;
  docJustGenerated: boolean;
  docGeneratedThisTurn: boolean;
  sawWriteDraftProgress: boolean;
  sawValidDraftMutation: boolean;
  sawFailedDraftMutationInput: boolean;
  finalDocumentSnapshotEmitted: boolean;
  activeDocGenerationToolCallId: string | null;
  activeDocGenerationId: string | null;
  activeDocGenerationLastSeq: number;
  activeDocGenerationFailedEventSeen: boolean;
  settledDocGenerationId: string | null;
  settledDocGenerationLastSeq: number;
  readonly docExistedBeforeStream: boolean;
  wasSuspended: boolean;
  seenAskUser: boolean;
  askUserProgressEmitted: boolean;
  askUserProgressToolCallId: string | null;
  readImageMeta: Map<string, { args: Record<string, unknown>; thumbnailSrc: string | null }>;
  generateSvgMeta: Map<string, { args: Record<string, unknown> }>;
  toolCallArgsById: Map<string, Record<string, unknown>>;
  askUserRenderMode: "fullpage" | "overlay";
  askUserPurpose: AskUserPurposeKind | null;
  questionnaireToolName: QuestionnaireToolName | null;
  generateSvgPreviousDocState: DocState | null;
  toolIoSpans: Map<string, Span<SpanType.TOOL_CALL> | null>;
  streamingPlaceholders: Set<string>;
  annotationPreview: AnnotationPreviewState;
  sawAnyToolCall: boolean;
  sawNonUiToolCall: boolean;
  sawToolHeartbeat: boolean;
  sawIdleTimeout: boolean;
  lastStepFinishReason: string | null;
  sawTextAfterLastTool: boolean;
  stepIndex: number;
  activeStepIndex: number | null;
  lastModelChunkAt: string | null;
  fileIdMap: Map<string, string>;
  resolvedFilesByFilename: Map<string, ResolvedUploadedFile>;
  resolvedFilesByFileId: Map<string, ResolvedUploadedFile>;
}

export async function createAgentStreamTurnContext(
  opts: ProcessAgentStreamOptions,
): Promise<AgentStreamTurnContext> {
  // 与拆分前保持同一观测口径：上传文件解析也计入首帧等待和整轮耗时。
  const streamStartTime = Date.now();
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    userText = "",
    fileIds: turnFileIds,
    requestContext,
  } = opts;
  const abortController = opts.abortController ?? new AbortController();
  state._annotationOriginsReplacedThisTurn = new Set();
  if (requestContext && !requestContext.get("doc")) {
    requestContext.set("doc", state.docDraftCandidateDoc ?? currentPmDoc(state));
  }
  const previousStreamId = state.streamId;
  const restoreStreamIdOnExit = previousStreamId === null;
  if (restoreStreamIdOnExit) state.streamId = streamId;

  const fileIdMap = new Map<string, string>();
  const resolvedFilesByFilename = new Map<string, ResolvedUploadedFile>();
  const resolvedFilesByFileId = new Map<string, ResolvedUploadedFile>();
  if (turnFileIds && turnFileIds.length > 0) {
    try {
      const resolved = await resolveFileIds(turnFileIds);
      for (const file of resolved) {
        fileIdMap.set(file.filename, file.fileId);
        resolvedFilesByFilename.set(file.filename, file);
        resolvedFilesByFileId.set(file.fileId, file);
      }
    } catch {
      // Non-fatal: preview just won't have fileId.
    }
  }

  const extractedTexts = (state._extractedTexts ??= new Map<string, ExtractedTextEntry>());
  return {
    state,
    agentMessageId,
    streamId,
    runId,
    userText,
    requestContext,
    abortController,
    outcome: {
      producedVisibleFrame: false,
      sawToolCall: false,
      sawSideEffectToolCall: false,
      streamWasUserAborted: false,
    },
    previousStreamId,
    restoreStreamIdOnExit,
    streamStartTime,
    docVersionBeforeStream: state.docVersion,
    timeoutMs: opts.idleTimeoutMs ?? AGENT_IDLE_TIMEOUT_MS,
    firstChunkTimeoutMs:
      opts.firstChunkTimeoutMs ?? AGENT_FIRST_CHUNK_TIMEOUT_MS,
    toolHeartbeatTimeoutMs:
      opts.toolHeartbeatTimeoutMs ?? AGENT_TOOL_HEARTBEAT_TIMEOUT_MS,
    deferRetryableIdleTimeout: opts.deferRetryableIdleTimeout === true,
    confirmService: opts.confirmService ?? confirmService,
    firstChunkLogged: false,
    accumulatedText: "",
    reasoningId: null,
    materialFrames: [],
    extractedTexts,
    researchFullTexts: new Map(),
    extractionEventsThisTurn: [],
    consumedExtractions: new Set(),
    validPatchCount: 0,
    docJustGenerated: false,
    docGeneratedThisTurn: false,
    sawWriteDraftProgress: false,
    sawValidDraftMutation: false,
    sawFailedDraftMutationInput: false,
    finalDocumentSnapshotEmitted: false,
    activeDocGenerationToolCallId: null,
    activeDocGenerationId: null,
    activeDocGenerationLastSeq: 0,
    activeDocGenerationFailedEventSeen: false,
    settledDocGenerationId: null,
    settledDocGenerationLastSeq: 0,
    docExistedBeforeStream: state.legacySections.length > 0,
    wasSuspended: false,
    seenAskUser: false,
    askUserProgressEmitted: false,
    askUserProgressToolCallId: null,
    readImageMeta: new Map(),
    generateSvgMeta: new Map(),
    toolCallArgsById: new Map(),
    askUserRenderMode: "fullpage",
    askUserPurpose: null,
    questionnaireToolName: null,
    generateSvgPreviousDocState: null,
    toolIoSpans: new Map(),
    streamingPlaceholders: new Set(),
    annotationPreview: new AnnotationPreviewState(),
    sawAnyToolCall: false,
    sawNonUiToolCall: false,
    sawToolHeartbeat: false,
    sawIdleTimeout: false,
    lastStepFinishReason: null,
    sawTextAfterLastTool: true,
    stepIndex: -1,
    activeStepIndex: null,
    lastModelChunkAt: null,
    fileIdMap,
    resolvedFilesByFilename,
    resolvedFilesByFileId,
  };
}

function basenameArg(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return basename(value);
}

export function resolveParseFileBinding(
  context: AgentStreamTurnContext,
  args: Record<string, unknown>,
): { fileId: string | null; filename: string | null; mimeType: string | null } {
  const argFileId = typeof args.fileId === "string" && args.fileId ? args.fileId : null;
  const argFilename = typeof args.filename === "string" && args.filename ? args.filename : null;
  const byFileId = argFileId ? context.resolvedFilesByFileId.get(argFileId) : undefined;
  const byFilename = argFilename ? context.resolvedFilesByFilename.get(argFilename) : undefined;
  const filePathBase = basenameArg(args.filePath);
  const fileId = argFileId ??
    (argFilename ? context.fileIdMap.get(argFilename) ?? null : null) ??
    filePathBase;
  return {
    fileId,
    filename: argFilename ?? byFileId?.filename ?? byFilename?.filename ?? filePathBase ?? fileId,
    mimeType:
      (typeof args.mimeType === "string" && args.mimeType ? args.mimeType : null) ??
      byFileId?.mimeType ??
      byFilename?.mimeType ??
      null,
  };
}

export function upsertParseFileErrorMaterial(
  context: AgentStreamTurnContext,
  args: Record<string, unknown>,
  failure: MaterialParseFailure,
): void {
  const binding = resolveParseFileBinding(context, args);
  if (!binding.fileId) {
    logger.warn("parseFile 失败但无法绑定 fileId，跳过失败素材落库", {
      sessionId: context.state.sessionId,
      filename: args.filename,
      filePath: args.filePath,
    });
    return;
  }
  const { frame } = upsertMaterialByFileId(
    context.state,
    {
      fileId: binding.fileId,
      filename: binding.filename,
      mimeType: binding.mimeType,
    },
    failure,
  );
  context.materialFrames.push(frame);
  schedulePersist(context.state, "tool_result:parseFile_error_material").catch((error) =>
    logger.error("Persist after parseFile error material failed", { error: String(error) }),
  );
}
