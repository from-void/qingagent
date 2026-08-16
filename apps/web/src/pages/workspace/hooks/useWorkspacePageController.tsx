import type {
  ActiveDocumentTarget,
  ActionCardData,
  AnnotationGroup,
  BridgeFrame,
  ChatChip,
  Command,
  DocumentSnapshot,
  FolderSource,
  HistorySnapshot,
  ReviewContext,
} from "@qingagent/contract-ts";
import {
  getPmContentHash,
  isAbnormalDocumentCollapse,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useSessionStore } from "../../../stores/sessionStore";
import {
  chatInputBus,
  deriveFolderCapability,
  useClientCapabilities,
  useToast,
} from "../../../system";
import { useConfirm } from "../../../system/ConfirmProvider";
import { useModelKeyGate } from "../../../system/modelKeyGate";
import { resources, useResourceList } from "../../../system/resources";
import { validateCommand } from "../../../system/validators";
import type {
  ChatInputHandle,
  ChatInputSnapshot,
} from "../data/chatInputTypes";
import { buildWholeDocReviewKey } from "../components/ChatMessageList";
import type { DerivativeGenerateParams } from "../components/derivatives/DerivativeGenerateModal";
import { buildActiveDocumentTurnTarget } from "../components/derivatives/derivativeTurnContext";
import {
  buildTranslationAgentQuery,
  buildTranslationDisplayCard,
  DTYPE_REGISTRY,
  type DerivativeDtype,
} from "../components/derivatives/dtypeRegistry";
import { selectTranslationItem } from "../components/derivatives/translationSelection";
import type { DerivativeItem } from "../components/derivatives/types";
import {
  isEditorRangeSingleAtomBlock,
  isEditorRangeWithinSingleTextBlock,
} from "../components/DocToolbar";
import type { DocumentSnapshotViewHandle } from "../components/DocumentSnapshotView";
import type { StarterBlankTarget } from "../components/StarterPanel";
import type { ReviewType } from "../components/ReviewLaunchModal";
import { runAiModifyTarget, type AiModifyTarget } from "../data/aiModifyTarget";
import {
  magicMoveFromRect,
  magicMoveToRect,
  morphTuning,
} from "../data/barMorph";
import {
  ensureBrowserFolderBridge,
  forgetBrowserFolderSource,
  pickBrowserFolderSource,
  rememberAttachedBrowserFolderSource,
  requestBrowserFolderPermission,
  stopBrowserFolderBridge,
  type PickedBrowserFolderSource,
} from "../data/browserFolderBridge";
import {
  DEFAULT_CHAT_INPUT_PLACEHOLDER,
  getChatInputBlockReason,
  sessionRestoreChatInputBlockReason,
} from "../data/chatInputBlockReason";
import { logClientEvent } from "../data/clientLog";
import { newClientMessageId } from "../data/clientMessageId";
import { cloneViewSections } from "../data/cloneViewDoc";
import {
  installAnnotationGroupDecorations,
  updateAnnotationGroupDecorations,
} from "../data/annotationDecorations";
import { annotationRemovalToastMessage } from "../data/annotationMessages";
import { deriveDocDimensions } from "../data/docDimensions";
import {
  buildAttachFolderCommand,
  FolderAttachTimeoutError,
  folderSourceOperationFailureToast,
  newFolderAttachRequestId,
  submitAttachFolderCommand,
  type FolderAttachSelection,
} from "../data/folderAttach";
import {
  cloneNativePresentationRun,
  type NativePresentationRun,
} from "../data/nativeDiffAnimation";
import {
  markDocSaveFailureNotified,
  PendingDocSaveError,
  docSaveFailureToastMessage,
  docWriteResultMessage,
  type PendingDocSaveWaiter,
} from "../data/pendingDocSave";
import {
  acknowledgedDocWriteContentHash,
  appliedDocVersionFromBroadcastFrame,
  broadcastContentFrameWritesDocumentVersion,
  decideBroadcastDocumentFrame,
  splitStreamEndFinalDocument,
  shouldHandleDocWriteResult,
} from "../data/docWriteResultOwnership";
import {
  EMPTY_PM_DOC_CONTENT_HASH,
  appliedDocWriteBaseline,
  createKnownDocVersionLedger,
  isEmptyScaffoldConflict,
  resolveDocWriteConflict,
} from "../data/docWriteBaseline";
import type { DocWriteBaseline } from "../data/docWriteBaseline";
import { pmDocHasSubstantiveContent } from "../data/pageExitSave";
import type {
  BlockPatchInput,
  PatchOverlayInput,
  ViewDocumentSnapshot,
} from "../data/protocol";
import {
  derivePatchPresentation,
  mergeGranularListBlockPatchInputs,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInputs,
  suggestionToPatchOverlay,
  wireDocToView,
} from "../data/protocol";
import {
  buildPatchMeta,
  computeWholeDocReviewChangeRatio,
  deriveReviewRenderMode,
  shouldCloseMaterialPreviewForReview,
  shouldDispatchManualDocSavedForWriteResult,
  shouldRetainPresentationRun,
  shouldSuppressPresentationRun,
} from "../data/reviewActions";
import { deriveReviewUiState } from "../data/reviewUiState";
import {
  isServerStreamDisposedError,
  loggedFrameObservabilityOf,
  retryDisposedServerStreamOnce,
  ServerStream,
} from "../data/serverStream";
import {
  clientPerformanceNow,
  presentationRunWatchdogMs,
  restoreExistingSessionWithRetry,
  shouldAcceptBridgeFrameForSession,
  submitImmediateChatInputSend,
  uploadFiles,
} from "../data/sessionFrameGuards";
import {
  ensureSessionIdOnce,
  replaceWorkspaceSessionHash,
  startNewSessionOnce,
} from "../data/sessionLifecycle";
import {
  reconcileAssetPreview,
  toAssetSource,
  type AssetSource,
} from "../data/sources";
import {
  resourceMutationKey,
  workspaceMutations,
} from "../data/revisionedMutation";
import {
  MATERIAL_PARSE_BUSY_REASON,
  MATERIAL_PARSE_SEND_FAILED_REASON,
  useMaterialParseTracker,
} from "../data/useMaterialParseTracker";
import {
  selectFullpageAsk,
  workspaceDataAttrs,
  workspaceHashWithViewingVersion,
  workspaceHistorySnapshotUrl,
  workspaceSessionIdFromHash,
  workspaceViewingVersionFromHash,
  workspaceViewingVersionIdFromHash,
  workspaceVisualState,
} from "../data/workspacePageView";
import {
  initialWorkspaceState,
  selectOpenAskUser,
  selectPatches,
  workspaceReducer,
} from "../data/workspaceState";
import {
  initialWorkspaceHydration,
  WORKSPACE_HYDRATION_TIMEOUT_MS,
  type WorkspaceHydrationAction,
  workspaceHydrationReducer,
} from "../data/workspaceHydration";
import { useAutoScroll } from "../useAutoScroll";
import { useAssetPreviewState } from "./useAssetPreviewState";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useReviewReveal } from "./useReviewReveal";
import {
  beginWorkspaceTurnDispatch,
  cancelWorkspaceTurnDispatch,
  isWorkspaceTurnDispatchCurrent,
  prepareAndDispatchWorkspaceTurn,
  useWorkspaceChatActions,
  type WorkspaceTurnDispatchGate,
} from "./useWorkspaceChatActions";
import { useWorkspaceChrome } from "./useWorkspaceChrome";
import { useWorkspaceDebugControls } from "./useWorkspaceDebugControls";
import {
  useWorkspaceDocumentEditor,
  type QueuedDocWrite,
  type PreparedPageExitDocSave,
  type SendDocWrite,
} from "./useWorkspaceDocumentEditor";
import { useWorkspaceFind } from "./useWorkspaceFind";
import {
  askUserCancelMutationKey,
  isAuthoritativeAskUserCancelFrame,
  useWorkspaceReviewActions,
} from "./useWorkspaceReviewActions";
export { RightPane } from "../components/RightPane";
export {
  buildPageExitDocSaveCommand,
  drainPageExitDocSaveOutbox,
  flushDocSaveInBackground,
  flushDocSaveOnPageExit,
  PageExitDocSaveError,
  pageExitDocSaveFingerprint,
  shouldFlushDocSaveOnPageExit,
} from "../data/pageExitSave";
export {
  PendingDocSaveError,
  docSaveFailureToastMessage,
  reviewCommitFramesLeavePendingReview,
  runAfterPendingDocSave,
} from "../data/pendingDocSave";
export {
  buildPatchVerdictCommand,
  buildReviewGroupCommitSelection,
  buildReviewGroupRejectSelection,
  buildReviewOutcome,
  canUseDocumentEditing,
  computeWholeDocReviewChangeRatio,
  deriveReviewRenderMode,
  sendReviewOutcomeFollowup,
  shouldCloseMaterialPreviewForReview,
  shouldDispatchManualDocSavedForWriteResult,
  shouldRetainPresentationRun,
  shouldSuppressPresentationRun,
} from "../data/reviewActions";
export {
  bridgeFrameSessionId,
  isRetriableSessionRestoreError,
  restoreExistingSessionWithRetry,
  rollbackOptimisticChatSend,
  sendFailureToastMessage,
  shouldAcceptBridgeFrameForSession,
  submitImmediateChatInputSend,
} from "../data/sessionFrameGuards";

// 历史版本入口特性开关:后端(版本快照/操作流水/读取 API)已就绪,前端列表/查看 UI 尚未迭代,
// 暂时隐藏文档纸右上角的"历史"按钮(及其"即将上线"toast)。功能做完翻为 true 即可恢复入口。
export const HISTORY_ENTRY_ENABLED = false;

export async function sendMaterialParseCommandWithStream(
  stream: Pick<ServerStream, "sendCommand"> | null,
  command: Command,
): Promise<unknown> {
  if (!stream) throw new Error("连接未就绪");
  return stream.sendCommand(command);
}

function hydratedSessionTitle(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0 || value === "未命名草稿") {
    return null;
  }
  return value;
}

function sessionTitleFromStore(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const title = useSessionStore
    .getState()
    .sessions.find((session) => session.id === sessionId)?.title;
  return hydratedSessionTitle(title);
}

function isAbortError(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError";
}

function reconcileFinishedDerivativeGenerations(
  items: DerivativeItem[],
  finishedAtByDocId: ReadonlyMap<string, string>,
): DerivativeItem[] {
  return items.map((item) => {
    const finishedAt = finishedAtByDocId.get(item.docId);
    if (!finishedAt || (item.generatedAt != null && item.generatedAt >= finishedAt)) {
      return item;
    }
    // generate_derivative 的成功事务会把 source_version 盖到当时主稿版本；
    // generatedAt 旧于完成帧的列表响应只是旧快照，不得把红点重新写回来。
    return {
      ...item,
      sourceVersion: item.currentSourceVersion,
      generatedAt: finishedAt,
      stale: false,
    };
  });
}

export function useWorkspacePageController() {
  const initialSessionId =
    typeof window === "undefined"
      ? null
      : workspaceSessionIdFromHash(window.location.hash);
  // 已有会话先沿用列表中的标题，避免恢复帧到达前把 store 短暂写空。
  const [title, setTitle] = useState(
    () => sessionTitleFromStore(initialSessionId) ?? "",
  );
  const {
    debugMode,
    demoBarKind,
    demoBarShown,
    devToolsOpen,
    handleMorphEnter,
    handleMorphKind,
    handleMorphReturn,
    handleRevealReplay,
    inputContentOut,
    revealConfig,
    revealReplayNonce,
    setDevToolsOpen,
  } = useWorkspaceDebugControls();
  const { previewExit, previewSource, setPreviewSource } =
    useAssetPreviewState();
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const initialHydrationSessionIdRef = useRef<string | null>(initialSessionId);
  const [hydration, setHydration] = useState(() =>
    initialWorkspaceHydration(initialHydrationSessionIdRef.current),
  );
  const hydrationRef = useRef(hydration);
  const hydrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [derivatives, setDerivatives] = useState<DerivativeItem[]>([]);
  const finishedDerivativeGenerationRef = useRef<Map<string, string>>(new Map());
  const [derivativeCreateOpen, setDerivativeCreateOpen] = useState(false);
  const [derivativeCreateDtype, setDerivativeCreateDtype] =
    useState<DerivativeDtype>("gzh");
  const [derivativeCreating, setDerivativeCreating] = useState(false);
  const [pendingDerivativeGeneration, setPendingDerivativeGeneration] =
    useState<string | null>(null);
  const sendDerivativeQueryRef = useRef<
    (
      text: string,
      displayCard: ActionCardData,
      reviewContext?: ReviewContext,
      targetOverride?: ActiveDocumentTarget,
    ) => void
  >(() => undefined);
  const [activeTab, setActiveTab] = useState<"main" | string>("main");
  const [activeTranslationDocId, setActiveTranslationDocId] = useState<
    string | null
  >(null);
  useEffect(() => {
    setActiveTranslationDocId((current) => {
      return selectTranslationItem(derivatives, current)?.docId ?? null;
    });
  }, [derivatives]);
  const activeDocumentTurnTarget = useMemo(
    () =>
      buildActiveDocumentTurnTarget(
        activeTab,
        title,
        derivatives,
        activeTranslationDocId,
      ),
    [activeTab, activeTranslationDocId, derivatives, title],
  );
  useEffect(() => {
    // 批注预览是转瞬态：切 tab 不恢复、不保留。
    dispatch({ kind: "annotationPreviewCleared", data: {} });
  }, [activeTab]);
  const [presentationRun, setPresentationRun] =
    useState<NativePresentationRun | null>(null);
  const presentationRunRef = useRef<NativePresentationRun | null>(null);
  const [hasReplayablePresentation, setHasReplayablePresentation] =
    useState(false);
  // 乐观"请求在途"标记:用户点发送的那一刻即置真,补上"气泡已发出、但流还没激活"的空窗
  // (此前那段没有任何 loading,容易被误以为断网)。真实 streamActive/agentBusy 一到就交棒、撤掉。
  const [sendPending, setSendPending] = useState(false);
  const [browserFolderOverrides, setBrowserFolderOverrides] = useState<
    Record<
      string,
      {
        status: FolderSource["status"];
        error: string | null;
      }
    >
  >({});
  const chatInputRef = useRef<ChatInputHandle>(null);
  // 二维码过期刷新等"一点即发"用:chatInputBus.send 触发时,预填后立即提交。用 ref 取最新 handleSubmitChat,
  // 避免订阅 effect 与 handleSubmitChat 定义顺序/闭包陈旧问题。
  const handleSubmitChatRef = useRef<() => void>(() => {});
  const docViewRef = useRef<DocumentSnapshotViewHandle>(null);
  const tiptapEditorRef = useRef<Editor | null>(null);
  const streamRef = useRef<ServerStream | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  // 整篇审(大改)新旧版切换态 + 新旧各自滚动位置记忆
  const [wholeDocVersion, setWholeDocVersion] = useState<"new" | "old">("new");
  const wholeDocScrollMem = useRef<{ new: number; old: number }>({
    new: 0,
    old: 0,
  });
  const exportAnchorRef = useRef<HTMLDivElement>(null);
  const reviewAnchorRef = useRef<HTMLDivElement>(null);
  // 输入框 ⇄ 右侧操作条「同体平移」用:输入框外壳 ref + 上一帧条是否在场 + 条最后位置(供返回时幽灵滑回)
  const inputMorphRef = useRef<HTMLDivElement>(null);
  const prevBarPresentRef = useRef(false);
  const morphTokenRef = useRef(0);
  const lastBarRectRef = useRef<DOMRect | null>(null);
  // 输入框是否曾进入过可用态(未锁)。区分 askUser 卡是「交互中出现」(输入框曾可用→几何形变)
  // 还是「刷新恢复时就已在 DOM」(输入框从未可用→静态显示,不形变;否则 FLIP 会把卡形变到
  // 隐藏态输入框的位置 → 卡看不见=「弹框消失+锁死」)。
  const inputWasEverActiveRef = useRef(false);
  // FLIP 编排是否已跑过第一帧。刷新恢复时,卡/条在「首帧」就已在 DOM —— 那不是「交互中新出现」,
  // 而是恢复态。首帧若发现卡已在场,一律静态交接、绝不 magicMove(否则把卡 pin 到隐藏输入框位置 →
  // 卡看不见+输入框锁死)。这条与 inputWasEverActiveRef 互为双保险:不依赖恢复期输入框是否瞬间可用过的时序。
  const flipDidFirstRunRef = useRef(false);
  const stateRef = useRef(state);
  const workspaceMountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const replaySessionIdRef = useRef<string | null>(state.sessionId);
  const activeWorkspaceSessionTargetRef = useRef<string | null>(null);
  const streamGenerationRef = useRef(0);
  const derivativeListGenerationRef = useRef(0);
  const streamDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startNewSessionPromiseRef = useRef<Promise<string> | null>(null);
  const startSessionPromisesBySessionRef = useRef<Map<string, Promise<string>>>(
    new Map(),
  );
  const applyWorkspaceHydrationAction = useCallback(
    (action: WorkspaceHydrationAction) => {
      const current = hydrationRef.current;
      const next = workspaceHydrationReducer(current, action);
      if (next !== current) {
        // 同步推进 ref，避免同一事件循环内的 restoreReset/startSession 看见旧相位，
        // 在 React 下一次 render 前把 ready 误重置为 waiting。
        hydrationRef.current = next;
        setHydration(next);
      }
      return next;
    },
    [],
  );
  const clearHydrationTimers = useCallback(() => {
    if (hydrationTimeoutRef.current !== null) {
      clearTimeout(hydrationTimeoutRef.current);
      hydrationTimeoutRef.current = null;
    }
  }, []);
  const beginWorkspaceHydration = useCallback(
    (sessionId: string | null) => {
      const current = hydrationRef.current;
      if (current.sessionId === sessionId) {
        // 初始 hash 已把门设为 waiting；第一次真正发起恢复时只补上绝对超时，
        // 同会话之后的重连/重复 effect 一律不重开门、也不重置 4s 预算。
        if (
          sessionId &&
          current.phase === "waiting" &&
          hydrationTimeoutRef.current === null
        ) {
          hydrationTimeoutRef.current = setTimeout(() => {
            hydrationTimeoutRef.current = null;
            applyWorkspaceHydrationAction({ kind: "timeout", sessionId });
          }, WORKSPACE_HYDRATION_TIMEOUT_MS);
        }
        return;
      }
      clearHydrationTimers();
      applyWorkspaceHydrationAction({ kind: "begin", sessionId });
      if (!sessionId) return;
      hydrationTimeoutRef.current = setTimeout(() => {
        hydrationTimeoutRef.current = null;
        applyWorkspaceHydrationAction({ kind: "timeout", sessionId });
      }, WORKSPACE_HYDRATION_TIMEOUT_MS);
    },
    [applyWorkspaceHydrationAction, clearHydrationTimers],
  );
  const observeHydrationFrame = useCallback(
    (frame: BridgeFrame, fallbackSessionId: string | null) => {
      if (frame.kind === "restoreReset") {
        // begin 对同会话是幂等的：既不 ready→waiting，也不重启弱网预算；
        // waiting 内的新恢复批次另行清掉上一批的半完成信号。
        beginWorkspaceHydration(fallbackSessionId);
        if (fallbackSessionId) {
          applyWorkspaceHydrationAction({
            kind: "restoreReset",
            sessionId: fallbackSessionId,
          });
        }
        return;
      }
      if (frame.kind === "documentSnapshotWritten" && fallbackSessionId) {
        applyWorkspaceHydrationAction({
          kind: "documentObserved",
          sessionId: fallbackSessionId,
        });
        return;
      }
      if (frame.kind === "sessionRestoreCompleted") {
        const next = applyWorkspaceHydrationAction({
          kind: "restoreCompleted",
          sessionId: frame.data.sessionId,
        });
        // 有正文时完成帧只代表协议首批结束；编辑器首帧尚未可画就继续守门。
        if (next.phase === "ready") clearHydrationTimers();
      }
    },
    [
      applyWorkspaceHydrationAction,
      beginWorkspaceHydration,
      clearHydrationTimers,
    ],
  );
  const restoreExistingSessionIdRef = useRef<string | null>(null);
  const lastRetriableSendRef = useRef<Extract<
    Command,
    { kind: "sendMessage" }
  > | null>(null);
  // 所有 sendMessage 入口共用同一 turn 闸门：输入框发送与衍生稿指令都必须能被
  // 一次停止持续作废，不能各自保留会晚到的异步派发链。
  const turnDispatchGateRef = useRef<WorkspaceTurnDispatchGate>({
    generation: 0,
    sessionId: null,
  });
  const reviewCloseInFlightRef = useRef<Promise<void> | null>(null);
  // REST 提交与 /events 共用同一 FrameLog，但到达浏览器的先后独立。
  // 递增游标让提交结果处理能识别“实时 docCommitted 已先到、REST 随后仅回 no-op”。
  const reviewCommitReceiptRef = useRef<{
    sessionId: string | null;
    revision: number;
    version: number;
  }>({ sessionId: null, revision: 0, version: 0 });
  // cancelAskUser 的乐观事务 token。收到同 toolCall 的权威取消成功帧即失效；
  // 之后即使 POST 响应连接迟到失败，也不得把已解锁的服务端状态回滚成旧问卷。
  const askUserCancelMutationTokensRef = useRef<Map<string, symbol>>(
    new Map(),
  );
  const pendingBrowserAttachRef = useRef<
    Map<
      string,
      {
        sessionId: string;
        picked: PickedBrowserFolderSource;
      }
    >
  >(new Map());
  const activeFolderAttachRef = useRef<{
    sessionId: string;
    controller: AbortController;
  } | null>(null);
  const activeBrowserFolderKeysRef = useRef<
    Map<string, { sessionId: string; folderId: string }>
  >(new Map());
  const docVersionRef = useRef(state.version);
  // 与 docVersionRef 组成同一 canonical 保存基线；排队保存时 state.doc 可能为保护
  // 编辑器而暂未回灌成功稿，故哈希必须在私有成功回执处独立推进。
  const baseContentHashRef = useRef(EMPTY_PM_DOC_CONTENT_HASH);
  const pendingDocWriteRef = useRef(false);
  const queuedPmDocRef = useRef<QueuedDocWrite | null>(null);
  const scheduledDocWriteRef = useRef(false);
  const latestDocMutationIdRef = useRef<string | null>(null);
  const docWriteAckRef = useRef<Map<string, PendingDocSaveWaiter>>(new Map());
  const docSaveDrainWaitersRef = useRef<PendingDocSaveWaiter[]>([]);
  const deferredDocumentFrameRef = useRef<{
    frame: BridgeFrame;
    streamSessionId: string | null;
    streamGeneration: number;
  } | null>(null);
  const deferredDocumentFrameDrainRef = useRef(false);
  // 真冲突时既保留编辑器本地正文，也保留服务器 canonical 帧；重载入口由
  // documentFrameConflict 驱动，不能把服务器版本从内存中遗忘。
  const conflictedDocumentFrameRef = useRef<BridgeFrame | null>(null);
  const pendingBlankFocusRef = useRef<StarterBlankTarget | null>(null);
  // 模板填充在途 promise:单飞去重(review #2)+ 发送消息前等它落定,避免 sendMessage 与骨架
  // updateDoc 竞发(sendMessage 先被处理会置 streamId,后到的骨架写被拒、模板永久丢失,review #6)。
  const fillTemplatePromiseRef = useRef<Promise<void> | null>(null);
  // 瞬态保存重试的退避定时器:存起来,组件卸载/切会话时清掉,杜绝孤儿定时器用旧态杂散重发。
  const docSaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const foregroundDocSaveDepthRef = useRef(0);
  const pageExitDocSaveFingerprintRef = useRef<string | null>(null);
  // 诊断 p01:记住最近一次发出的手动保存文档,保存成功后同步进 state.doc。
  const lastSentPmDocRef = useRef<PmDoc | null>(null);
  const lastSentDocWriteBaselineRef = useRef<DocWriteBaseline | null>(null);
  // 空脚手架旧写冲突后，临时允许 startSession(existing) 的权威恢复帧覆盖该空稿。
  // 非空用户输入不进入此通道，继续沿用 dirty 冲突保留路径。
  const docConflictReconcileSessionRef = useRef<string | null>(null);
  // 本会话【已知产出】的文档版本账本:本标签自己写入的回执版本 + agent 生成流推进且本标签
  // 已应用的版本。冲突时服务端现版本若在账本里,只是基线取早了(可视化写回与防抖保存追尾、
  // agent 刚写完本会话文档),静默改基线重放即可;不在账本里才是真外部并发,保留重载横幅。
  const knownDocVersionsRef = useRef(createKnownDocVersionLedger());
  // 已经拿来当基线重放过的版本 + 连续静默重放次数:双保险,杜绝重放打转。
  const replayedConflictVersionsRef = useRef<Set<number>>(new Set());
  const silentConflictReplayDepthRef = useRef(0);
  const presentationRunSeqRef = useRef(0);
  const sawDraftingRef = useRef(false);
  const presentedDocumentSnapshotRef = useRef<number | null>(null);
  const sendDocWriteRef = useRef<SendDocWrite>(() =>
    Promise.resolve(),
  );
  const flushPendingDocSaveRef = useRef<() => Promise<void>>(() =>
    Promise.resolve(),
  );
  const preparePageExitDocSaveRef = useRef<() => PreparedPageExitDocSave | null>(
    () => null,
  );
  const reducedMotionRef = useRef(false);
  stateRef.current = state;
  hydrationRef.current = hydration;
  sessionIdRef.current = state.sessionId ?? sessionIdRef.current;
  docVersionRef.current = state.version;
  if (state.version === 0) {
    baseContentHashRef.current = EMPTY_PM_DOC_CONTENT_HASH;
  } else if (
    state.doc?.pmDoc &&
    state.doc.version === state.version
  ) {
    // manualDocSaved 保留编辑器物化表示；同版本若已有服务端/私有 ack 登记的 canonical
    // 基线，不能在下一次 render 又用物化 state.doc 哈希把它覆盖回去。
    baseContentHashRef.current =
      knownDocVersionsRef.current.get(state.version)?.baseline.baseContentHash ??
      getPmContentHash(state.doc.pmDoc);
  }
  presentationRunRef.current = presentationRun;
  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null);
  const markDocumentSurfaceReady = useCallback(
    () => {
      const sessionId = hydrationRef.current.sessionId;
      if (!sessionId) return;
      const next = applyWorkspaceHydrationAction({
        kind: "documentSurfaceReady",
        sessionId,
      });
      if (next.phase === "ready") clearHydrationTimers();
    },
    [applyWorkspaceHydrationAction, clearHydrationTimers],
  );
  const toast = useToast();
  const confirm = useConfirm();
  const showToast = toast.show;
  useEffect(() => {
    if (!tiptapEditor || tiptapEditor.isDestroyed) return;
    const current = stateRef.current;
    return installAnnotationGroupDecorations(
      tiptapEditor,
      current.docState.kind === "pendingReview" ? [] : current.annotationGroups,
      (groups, invalidatedAnchorCount) => {
        dispatch({ kind: "annotationGroupsChanged", groups });
        if (invalidatedAnchorCount > 0) {
          showToast({
            message: annotationRemovalToastMessage(invalidatedAnchorCount),
            dedupeKey: "annotation-anchor-invalidated",
          });
        }
      },
      current.previewGroups,
    );
  }, [showToast, tiptapEditor]);
  useEffect(() => {
    if (!tiptapEditor || tiptapEditor.isDestroyed) return;
    updateAnnotationGroupDecorations(
      tiptapEditor,
      state.docState.kind === "pendingReview" ? [] : state.annotationGroups,
      state.previewGroups,
    );
  }, [state.annotationGroups, state.docState.kind, state.previewGroups, tiptapEditor]);
  const dispatchAnnotationGroups = useCallback((groups: AnnotationGroup[]) => {
    dispatch({ kind: "annotationGroupsChanged", groups });
  }, []);
  tiptapEditorRef.current = tiptapEditor;
  useEffect(() => {
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      activeFolderAttachRef.current?.controller.abort(
        new DOMException("Workspace unmounted", "AbortError"),
      );
      activeFolderAttachRef.current = null;
    };
  }, []);
  const restoreExistingSession = useCallback((sessionId: string) => {
    const stream = streamRef.current;
    if (!stream) return Promise.reject(new Error("stream not ready"));
    const restoreGeneration = streamGenerationRef.current;
    restoreExistingSessionIdRef.current = sessionId;
    return restoreExistingSessionWithRetry({
      sessionId,
      startSession: (data) => {
        if (
          streamRef.current !== stream ||
          streamGenerationRef.current !== restoreGeneration ||
          activeWorkspaceSessionTargetRef.current !== sessionId
        ) {
          return Promise.reject(new Error("session restore superseded"));
        }
        return stream.startSession(data);
      },
      startSessionPromisesBySessionRef,
      dispatch: (action) => {
        if (
          streamGenerationRef.current === restoreGeneration &&
          activeWorkspaceSessionTargetRef.current === sessionId
        ) {
          dispatch(action);
        }
      },
    });
  }, []);

  // 恢复失败态的重试:右侧文档面板的「重试」按钮与左下角 toast 的「重试」共用这条路径。
  // 先清掉 streamError,面板立刻从错误态切回等待态(重试失败会重新 dispatch 出错误)。
  const handleRetryRestore = useCallback(() => {
    const sessionId =
      restoreExistingSessionIdRef.current ?? stateRef.current.sessionId;
    if (!sessionId) return;
    dispatch({ kind: "streamErrorCleared" });
    restoreExistingSession(sessionId).catch((error) => {
      console.error("[workspace] session restore retry failed", error);
    });
  }, [restoreExistingSession]);

  const sendAttachFolderSelection = useCallback(
    async (
      stream: ServerStream,
      sessionId: string,
      selection: FolderAttachSelection,
      options: {
        awaitBrowserBridge?: boolean;
        signal?: AbortSignal;
      } = {},
    ): Promise<void> => {
      const requestId = newFolderAttachRequestId();
      const command = buildAttachFolderCommand(
        sessionId,
        selection,
        requestId,
      );
      let usedGlobalPending = false;
      if (selection.provider === "browser-fs-access") {
        if (!options.awaitBrowserBridge) {
          pendingBrowserAttachRef.current.set(requestId, {
            sessionId,
            picked: selection.picked,
          });
          usedGlobalPending = true;
        }
      }

      try {
        validateCommand(command);
      } catch (error) {
        if (usedGlobalPending) {
          pendingBrowserAttachRef.current.delete(requestId);
        }
        console.error("[workspace] attachFolder validation failed", error);
        showToast("命令校验失败 · 见 console");
        throw error;
      }

      const startedAt = Date.now();
      console.info("[workspace] folder attach submit started", {
        requestId,
        provider: selection.provider,
      });
      try {
        const result = await submitAttachFolderCommand(
          stream,
          command,
          selection,
          { signal: options.signal },
        );
        if (!result.ok) {
          throw new Error(folderSourceOperationFailureToast(result));
        }
        if (
          selection.provider === "browser-fs-access" &&
          options.awaitBrowserBridge
        ) {
          await rememberAttachedBrowserFolderSource({
            sessionId,
            folderId: result.folderId,
            picked: selection.picked,
          });
          activeBrowserFolderKeysRef.current.set(
            `${sessionId}\0${result.folderId}`,
            { sessionId, folderId: result.folderId },
          );
        }
        console.info("[workspace] folder attach submit completed", {
          requestId,
          provider: selection.provider,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (usedGlobalPending) {
          pendingBrowserAttachRef.current.delete(requestId);
        }
        console.warn("[workspace] folder attach submit failed", {
          requestId,
          provider: selection.provider,
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },
    [showToast],
  );

  const resolvePendingDocSaveDrain = useCallback(() => {
    if (
      pendingDocWriteRef.current ||
      queuedPmDocRef.current ||
      scheduledDocWriteRef.current
    ) {
      return;
    }

    const waiters = docSaveDrainWaitersRef.current.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }, []);

  const rejectPendingDocSaveDrain = useCallback((error: Error) => {
    const waiters = docSaveDrainWaitersRef.current.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }, []);

  const waitForPendingDocSaveDrain = useCallback(() => {
    if (
      !pendingDocWriteRef.current &&
      !queuedPmDocRef.current &&
      !scheduledDocWriteRef.current
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      docSaveDrainWaitersRef.current.push({ resolve, reject });
    });
  }, []);

  const showBackgroundDocSaveFailure = useCallback(
    (error: unknown) => {
      if (foregroundDocSaveDepthRef.current > 0) return;
      showToast(docSaveFailureToastMessage(error));
      markDocSaveFailureNotified(error);
    },
    [showToast],
  );

  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSessionTitle = useSessionStore((s) => s.updateSessionTitle);
  const reducedMotion = usePrefersReducedMotion();
  reducedMotionRef.current = reducedMotion;
  const flushPendingDocSaveBeforeNavigation = useCallback(
    () => flushPendingDocSaveRef.current(),
    [],
  );

  const { handleBackHome } = useWorkspaceChrome({
    viewRef,
    docScrollRef,
    chatScrollRef,
    sessionId: state.sessionId,
    reducedMotion,
    flushPendingDocSave: flushPendingDocSaveBeforeNavigation,
  });

  useAutoScroll(chatScrollRef);

  const modelKeyGate = useModelKeyGate();
  const hasModelKey = modelKeyGate.status !== "unconfigured";

  const dim = useMemo(() => deriveDocDimensions(state), [state]);
  // Agent 在跑 = 真实信号(流已激活 / 后端 agentBusy)并联乐观 sendPending。
  // 输入框据此挂环境辉光,覆盖"刚发出→流激活"的空窗,以及生成期间不流式输出的 writeDraft 长憋。
  const agentActive = state.streamActive || state.agentBusy || sendPending;
  const fileResources = useResourceList({ kind: "file" });
  useEffect(() => {
    const reconciled = reconcileAssetPreview(previewSource, fileResources);
    if (reconciled !== previewSource) setPreviewSource(reconciled);
  }, [fileResources, previewSource, setPreviewSource]);
  const sendMaterialParseCommand = useCallback(async (command: Command) => {
    return sendMaterialParseCommandWithStream(streamRef.current, command);
  }, []);
  const materialParsingTurnKeyRef = useRef<number | null>(null);
  const [materialPanelOpenSignal, setMaterialPanelOpenSignal] = useState(0);
  const materialParseNoticeRef = useRef<{
    sessionId: string | null;
    states: Map<string, string>;
  }>({ sessionId: null, states: new Map() });
  const {
    rows: materialParseRows,
    markParsing: markMaterialParsing,
    markTurnError: markMaterialParsingTurnError,
    retry: retryMaterialParse,
  } = useMaterialParseTracker({
    sessionId: state.sessionId,
    resources: fileResources,
    agentActive,
    sendCommand: sendMaterialParseCommand,
  });
  useEffect(() => {
    const currentSessionId = state.sessionId;
    const nextStates = new Map(
      materialParseRows.map((row) => [
        row.id,
        row.state === "error" ? `error:${row.parseError ?? ""}` : row.state,
      ]),
    );
    const noticeState = materialParseNoticeRef.current;
    if (noticeState.sessionId !== currentSessionId) {
      materialParseNoticeRef.current = {
        sessionId: currentSessionId,
        states: nextStates,
      };
      return;
    }

    const hasNewFailure = materialParseRows.some((row) => {
      if (row.state !== "error") return false;
      return noticeState.states.get(row.id) !== nextStates.get(row.id);
    });
    materialParseNoticeRef.current = {
      sessionId: currentSessionId,
      states: nextStates,
    };
    if (!hasNewFailure) return;
    toast.show({
      message: "素材解析失败",
      tone: "warn",
      sticky: true,
      role: "alert",
      dedupeKey: "material-parse-failed",
      action: {
        label: "查看素材",
        onClick: () => setMaterialPanelOpenSignal((value) => value + 1),
      },
    });
  }, [materialParseRows, state.sessionId, toast]);
  const handleRetryMaterialParse = useCallback(
    (fileId: string) => {
      if (agentActive) {
        showToast(MATERIAL_PARSE_BUSY_REASON);
        return;
      }
      retryMaterialParse(fileId).catch((error) => {
        console.error("[workspace] reparseMaterial failed", error);
        showToast("重试解析失败，请稍后再试");
      });
    },
    [agentActive, retryMaterialParse, showToast],
  );
  const folderSource = useMemo(() => {
    const source = state.folderSources[0] ?? null;
    if (!source || source.provider !== "browser-fs-access") return source;
    const override = browserFolderOverrides[source.id];
    return override
      ? { ...source, status: override.status, error: override.error }
      : source;
  }, [browserFolderOverrides, state.folderSources]);
  const clientCapabilities = useClientCapabilities();
  const folderCapability = deriveFolderCapability(clientCapabilities);
  useEffect(() => {
    const browserSources = state.folderSources.filter(
      (source) => source.provider === "browser-fs-access",
    );
    const currentKeys = new Set(
      browserSources.map((source) => `${source.sessionId}\0${source.id}`),
    );
    for (const [key, value] of activeBrowserFolderKeysRef.current) {
      if (currentKeys.has(key)) continue;
      stopBrowserFolderBridge(value.sessionId, value.folderId);
      activeBrowserFolderKeysRef.current.delete(key);
    }
    setBrowserFolderOverrides((current) => {
      const next: typeof current = {};
      for (const source of browserSources) {
        if (current[source.id]) next[source.id] = current[source.id]!;
      }
      return next;
    });
    let cancelled = false;
    const bridgeLifecycle = new AbortController();
    for (const source of browserSources) {
      void ensureBrowserFolderBridge(source, bridgeLifecycle.signal).then((result) => {
        if (cancelled) return;
        const key = `${source.sessionId}\0${source.id}`;
        if (result.status === "connected") {
          activeBrowserFolderKeysRef.current.set(key, {
            sessionId: source.sessionId,
            folderId: source.id,
          });
          setBrowserFolderOverrides((current) => {
            if (!current[source.id]) return current;
            const { [source.id]: _removed, ...rest } = current;
            return rest;
          });
          return;
        }
        setBrowserFolderOverrides((current) => ({
          ...current,
          [source.id]: {
            status:
              result.status === "missing"
                ? "permission_required"
                : result.status,
            error: result.error,
          },
        }));
      });
    }
    return () => {
      cancelled = true;
      bridgeLifecycle.abort();
      for (const source of browserSources) {
        const key = `${source.sessionId}\0${source.id}`;
        stopBrowserFolderBridge(source.sessionId, source.id);
        activeBrowserFolderKeysRef.current.delete(key);
      }
    };
  }, [state.folderSources]);
  // 真实信号一到,撤掉乐观标记(由真实信号接力维持辉光,避免双重计时)。
  useEffect(() => {
    if (state.streamActive || dim.agentBusy) setSendPending(false);
  }, [state.streamActive, dim.agentBusy]);
  // 兜底:万一这一轮在流激活/agentBusy 之前就夭折(请求静默失败),30s 后强制熄灯,避免辉光卡住。
  useEffect(() => {
    if (!sendPending) return;
    const timer = window.setTimeout(() => setSendPending(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [sendPending]);
  const dataAttrs = useMemo(() => workspaceDataAttrs(dim), [dim]);
  const openAskUser = useMemo(() => selectOpenAskUser(state), [state]);
  const fullpageAsk = useMemo(
    () => selectFullpageAsk(dim, openAskUser),
    [dim, openAskUser],
  );
  const inlineAsk =
    dim.overlay === "askUser" && openAskUser && openAskUser !== fullpageAsk
      ? openAskUser
      : null;
  const hasAskUserCard = inlineAsk !== null || fullpageAsk !== null;
  const viewingHistory = state.viewingVersion !== null;
  const askUserInputDisabled =
    hasAskUserCard &&
    (openAskUser?.status.kind === "running" ||
      openAskUser?.status.kind === "pending");
  const allReviewPatches = useMemo(() => selectPatches(state), [state]);
  const pendingReviewResolutionAvailable =
    dim.content.kind === "pendingReview" && allReviewPatches.length > 0;
  // 既有会话恢复期间，正文/聊天史仍被 hydration 门隐藏；此时若输入可提交，视觉上是
  // “空白新稿”，实际却会把消息写进旧 session。恢复完成且内容表面可画前必须硬禁提交；
  // 4s 展示超时只允许露出已有部分，不能绕过数据归属门。
  const sessionRestoreBlocked =
    hydration.sessionId !== null &&
    (hydration.phase === "waiting" || !hydration.restoreCompleted);
  const sessionRestoreFailed = state.streamError?.kind === "failed";
  const chatInputBlockReason = useMemo(
    () =>
      sessionRestoreBlocked
        ? sessionRestoreChatInputBlockReason(sessionRestoreFailed)
        : getChatInputBlockReason(
            dim,
            askUserInputDisabled,
            viewingHistory,
            hasAskUserCard,
            pendingReviewResolutionAvailable,
          ),
    [
      dim,
      askUserInputDisabled,
      viewingHistory,
      hasAskUserCard,
      pendingReviewResolutionAvailable,
      sessionRestoreBlocked,
      sessionRestoreFailed,
    ],
  );
  const chatInputBlockReasonRef = useRef(chatInputBlockReason);
  chatInputBlockReasonRef.current = chatInputBlockReason;
  const chatInputPlaceholder =
    chatInputBlockReason?.placeholder ?? DEFAULT_CHAT_INPUT_PLACEHOLDER;
  const chatInputEditorDisabled = chatInputBlockReason !== null;
  // 输入框一旦进入可用态就记住(用于 FLIP 区分交互出现 vs 刷新恢复,见 inputWasEverActiveRef)。
  if (!chatInputEditorDisabled) inputWasEverActiveRef.current = true;
  const chatInputSendEnabledWhenDisabled =
    dim.content.kind === "pendingReview" && !askUserInputDisabled;
  const pendingReviewPatches = useMemo(
    () =>
      allReviewPatches.filter((patch) => {
        return patch.status.kind === "reviewing";
      }),
    [allReviewPatches],
  );
  const pendingReviewPatchIdSet = useMemo(
    () => new Set(pendingReviewPatches.map((patch) => patch.id)),
    [pendingReviewPatches],
  );
  // 审批 patch 折叠输入(reviewing/accepted/rejected 的 PM suggestion docSuggestion)。
  const overlayInputs = useMemo<PatchOverlayInput[]>(() => {
    return allReviewPatches.flatMap((tc, order) => {
      if (tc.body.kind !== "docSuggestion") return [];
      const s = tc.status.kind;
      if (s !== "reviewing" && s !== "accepted" && s !== "rejected") return [];
      if (tc.body.data.kind === "suggestion") {
        const overlay = suggestionToPatchOverlay(
          state.doc,
          tc.body.data.data,
          order,
        );
        return overlay ? [overlay] : [];
      }
      return [];
    });
  }, [allReviewPatches, state.doc]);
  // 诊断 p03:改用复数版,结构块 replace 渲染为"删旧+插新"可视对;已被内联
  // overlay 覆盖的 suggestion 跳过,避免双重标记。
  const overlayCoveredIds = useMemo(
    () => new Set(overlayInputs.map((o) => o.id)),
    [overlayInputs],
  );
  const blockPatchInputs = useMemo<BlockPatchInput[]>(() => {
    const inputs = allReviewPatches.flatMap((tc, order) => {
      if (tc.body.kind !== "docSuggestion") return [];
      const s = tc.status.kind;
      if (s !== "reviewing" && s !== "accepted" && s !== "rejected") return [];
      if (tc.body.data.kind !== "suggestion") return [];
      if (overlayCoveredIds.has(tc.body.data.data.id)) return [];
      return suggestionToBlockPatchInputs(tc.body.data.data, order);
    });
    return mergeGranularListBlockPatchInputs(inputs);
  }, [allReviewPatches, overlayCoveredIds]);
  // 数数单一真相源:计数 / 序号 / 正文标记 / 打字调度都从这里派生,天然一致。
  const patchPresentation = useMemo(
    () =>
      state.doc
        ? derivePatchPresentation(state.doc, overlayInputs, blockPatchInputs)
        : null,
    [state.doc, overlayInputs, blockPatchInputs],
  );
  // 修改处数与正文最小标记严格同源：普通 patch 一项，granular 容器按实际 changed/added/removed
  // 行、格或内部块逐项计数；裁决仍回到 target.patchId 对应的整条 suggestion。
  const presentationCount = patchPresentation?.reviewTargets.length ?? 0;
  const visibleReviewTargets = useMemo(
    () =>
      (patchPresentation?.reviewTargets ?? []).filter((target) =>
        pendingReviewPatchIdSet.has(target.patchId),
      ),
    [patchPresentation, pendingReviewPatchIdSet],
  );
  const visibleReviewTargetIds = useMemo(
    () => visibleReviewTargets.map((target) => target.id),
    [visibleReviewTargets],
  );
  const patchMeta = useMemo(() => {
    return buildPatchMeta(patchPresentation?.applied ?? []);
  }, [patchPresentation]);
  // —— 整篇审(大改 ≥70% 走新旧版整篇审,而非内联逐处) ——
  // 候选新文档(干净,含表格/块级改动)由后端 docDiffReady.editedDoc 直接给,前端不必再 materialize
  // (materializeDoc 清不了块级 patch)。
  const editedNewDoc = useMemo(
    () =>
      state.docDiff?.editedDoc
        ? pmDocToViewDocumentSnapshot(
            state.docDiff.editedDoc as PmDoc,
            (state.docDiff.baseVersion ?? state.version) + 1,
          )
        : null,
    [state.docDiff, state.version],
  );
  // 改动幅度 = 改动字数 / (旧文 + 新文 字数)。整段重写 ≈ 1,小改 ≈ 0。
  const changeRatio = useMemo(() => {
    return computeWholeDocReviewChangeRatio({
      patches: allReviewPatches,
      baseDoc: state.doc?.pmDoc ?? null,
      editedDoc: editedNewDoc?.pmDoc ?? null,
    });
  }, [allReviewPatches, state.doc?.pmDoc, editedNewDoc?.pmDoc]);
  // 自检:dropped/conflict 是 PM decoration 无法定位的诚实缺口;正文标记由 decoration 层负责。
  useEffect(() => {
    if (!patchPresentation || !import.meta.env?.DEV) return;
    if (patchPresentation.droppedIds.length > 0) {
      console.warn(
        `[patch] ${patchPresentation.droppedIds.length} 处改动锚点匹配失败、未在正文呈现:`,
        patchPresentation.droppedIds,
      );
    }
    if (patchPresentation.conflictIds.length > 0) {
      console.warn(
        `[patch] ${patchPresentation.conflictIds.length} 处改动已显式冲突、未在正文呈现:`,
        patchPresentation.conflictIds,
      );
    }
  }, [patchPresentation]);
  // 当前审批轮的全部 suggestion id(用于把左侧 patchSummary 气泡对上这一轮、用派生计数纠正显示)。
  const liveHunkKey = useMemo(
    () =>
      allReviewPatches
        .map((p) => p.id)
        .slice()
        .sort()
        .join(","),
    [allReviewPatches],
  );
  const [activeReviewTargetId, setActiveReviewTargetId] = useState<
    string | null
  >(null);
  const previousVisibleReviewTargetIdsRef = useRef<string[]>([]);

  // 改动B:审批入口"标记逐处入场"——review 态进入时，patch 标记按时序逐个点亮，
  // 终点 = 全部点亮 = 现状静态审批态(零跳变；doc 始终是 baseline+overlay，canonical 零改动)。
  // null = 不约束(非审批/恢复态全显示)。reducedMotion → 一次性全入场。
  const hasPatchCalls = allReviewPatches.length > 0;
  // 顶部审批条显示"剩余待处理"处数；正文 diff 仍由 presentationCount 保持全量事实口径。
  const visiblePatchCount = visibleReviewTargetIds.length;
  const reviewEligibility = deriveReviewUiState({
    content: dim.content,
    overlay: dim.overlay,
    hasPatchCalls,
    visiblePatchCount,
    patchRevealing: false,
    presentationCount,
  });
  const effectiveReview = reviewEligibility.effectiveReview;
  // 整篇审触发:审阅中 + 拿到干净新文档 + 改动幅度 ≥ 70% → 走新旧版整篇审
  const WHOLE_DOC_REVIEW_THRESHOLD = 0.7;
  const reviewRenderMode = deriveReviewRenderMode({
    effectiveReview,
    editedNewDoc,
    changeRatio,
    wholeDocReviewThreshold: WHOLE_DOC_REVIEW_THRESHOLD,
    wholeDocument: state.docDiff?.wholeDocument,
  });
  const wholeDocReview = reviewRenderMode.wholeDocReview;
  const awaitingWholeDocReviewMaterial =
    reviewRenderMode.awaitingWholeDocReviewMaterial;
  const inlinePatchReview = reviewRenderMode.inlinePatchReview;
  const {
    finalizeReviewTablePatch,
    patchRevealing,
    revealCursors,
    revealedPatchIds,
    setTableTypedByPatch,
    tableTypedByPatch,
    typedByPatch,
  } = useReviewReveal({
    enabled: inlinePatchReview,
    applied: patchPresentation?.applied ?? [],
    blockPatchInputs,
    patchMeta,
    reducedMotion,
    config: revealConfig,
    replayNonce: revealReplayNonce,
  });
  const reviewUiState = deriveReviewUiState({
    content: dim.content,
    overlay: dim.overlay,
    hasPatchCalls,
    visiblePatchCount,
    patchRevealing,
    presentationCount,
  });
  useLayoutEffect(() => {
    if (!reviewUiState.reviewResolutionAvailable || activeTab === "main") return;
    // pendingReview 与 suggestions 目前只属于 canonical 主稿；聊天锁却是会话级。
    // 多文档场景若仍停在衍生稿，右侧裁决条不会挂载，便会形成“输入已锁、出口不可见”。
    // 在绘制前把可裁决候选收归主稿纸面；用户随后误切衍生稿也会立即回到同一出口。
    setActiveTab("main");
  }, [activeTab, reviewUiState.reviewResolutionAvailable]);
  useLayoutEffect(() => {
    const el = docScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    viewRef.current?.classList.remove("ws-doc-scrolled");
  }, [state.sessionId]);
  // 记住哪些审批轮是「整篇改写」:commit 后该轮 live 信号消失,左侧历史气泡仍应显「整篇改写」而非「N 处」。
  const wholeDocReviewKeysRef = useRef<Set<string>>(new Set());
  const wholeDocReviewKeysSessionRef = useRef<string | null>(state.sessionId);
  useEffect(() => {
    if (wholeDocReviewKeysSessionRef.current === state.sessionId) return;
    wholeDocReviewKeysRef.current.clear();
    wholeDocReviewKeysSessionRef.current = state.sessionId;
  }, [state.sessionId]);
  useEffect(() => {
    const key = buildWholeDocReviewKey(state.sessionId, liveHunkKey);
    if (wholeDocReview && key) wholeDocReviewKeysRef.current.add(key);
  }, [wholeDocReview, state.sessionId, liveHunkKey]);
  useLayoutEffect(() => {
    if (!previewSource) return;
    if (
      !shouldCloseMaterialPreviewForReview({
        contentKind: dim.content.kind,
        wholeDocReview,
      })
    )
      return;
    setPreviewSource(null);
  }, [dim.content.kind, previewSource, wholeDocReview]);
  // 切换新旧版:先记住离开那版的滚动位置(供来回切换恢复各自位置)
  const handleWholeDocVersionChange = useCallback((next: "new" | "old") => {
    setWholeDocVersion((cur) => {
      if (cur !== next && docScrollRef.current) {
        wholeDocScrollMem.current[cur] = docScrollRef.current.scrollTop;
      }
      return next;
    });
  }, []);
  // 新一轮审阅 → 默认回到「新版」并清滚动记忆
  useEffect(() => {
    setWholeDocVersion("new");
    wholeDocScrollMem.current = { new: 0, old: 0 };
  }, [state.docDiff]);
  // 切换后把右侧滚动区恢复到目标版本各自记住的位置
  useLayoutEffect(() => {
    if (!wholeDocReview) return;
    const el = docScrollRef.current;
    if (el) el.scrollTop = wholeDocScrollMem.current[wholeDocVersion] ?? 0;
  }, [wholeDocVersion, wholeDocReview]);
  const unrenderablePatchCount =
    (patchPresentation?.droppedIds.length ?? 0) +
    (patchPresentation?.conflictIds.length ?? 0);
  const effectivePatchRevealing = inlinePatchReview && patchRevealing;
  // 「青简编辑中」统一判定:正文编辑锁提示、审查/导出禁用、「+」新建子文档禁用共用同一条件,
  // 保证 toast 出现时相关入口必然同时不可点。
  const qingjianEditing =
    dataAttrs.tool === "agentBusy" ||
    dataAttrs.tool === "imageProgress" ||
    effectivePatchRevealing;
  // 提示分支顺序:pendingReview 优先于「青简编辑中」——docDiff 一到审批条就升起(刻意设计:
  // 与揭示动画同体平移),此时再浮「请等待青简完成编辑」会压在审批条上(260726 用户报障:错乱)。
  // 揭示动画期间(条已在、光标在正文打字)不出任何锁提示;动画结束后才给「确认或放弃」指引。
  const editLockHint =
    dim.content.kind === "pendingReview"
      ? effectivePatchRevealing
        ? null
        : "请先确认或放弃当前修改候选"
      : qingjianEditing
        ? "请等待青简完成编辑后再做修改"
        : null;
  // 导出/审查按钮 gating:① 文档区为空(无可导出内容);② 青简编辑中;③ 不在可发送态
  // (右侧问卷 / 上方审批条),因为平台导出要把 query 发回对话,这些态下发送会冲突。
  // disable + hover 提示原因,文案按原因分流(e2e-loop-0704 R12:笼统文案让用户找不到入口)。
  const exportDisabledReason = useMemo<string | null>(() => {
    if (dim.content.kind === "empty") return "还没有可导出的内容";
    if (qingjianEditing) return "请等待青简完成编辑";
    if (!chatInputEditorDisabled) return null;
    if (viewingHistory) return "回到当前版本后可导出";
    if (askUserInputDisabled || dim.overlay === "askUser") {
      return "请先完成问卷，再导出";
    }
    if (dim.content.kind === "pendingReview") {
      return "有待处理的修改：请先采纳或撤销正文中的候选（或点「放弃全部」），再导出";
    }
    return "请先完成当前操作，再导出";
  }, [
    dim.content.kind,
    dim.overlay,
    qingjianEditing,
    chatInputEditorDisabled,
    viewingHistory,
    askUserInputDisabled,
  ]);
  const reviewDisabledReason = useMemo<string | null>(() => {
    if (dim.content.kind === "empty") return "还没有可审查的内容";
    if (qingjianEditing) return "请等待青简完成编辑后再审查";
    if (!chatInputEditorDisabled) return null;
    if (viewingHistory) return "回到当前版本后可审查";
    if (askUserInputDisabled || dim.overlay === "askUser") {
      return "请先完成问卷，再审查";
    }
    if (dim.content.kind === "pendingReview") {
      return "文档有待处理的修改，请先处理后再审查";
    }
    return "请先完成当前操作，再审查";
  }, [
    dim.content.kind,
    dim.overlay,
    qingjianEditing,
    chatInputEditorDisabled,
    viewingHistory,
    askUserInputDisabled,
  ]);
  // 新建子文档(公众号稿/小红书稿/翻译)要把 query 发回对话，因此与导出/审查共用
  // 「不可发送态」门禁，并按具体原因给出可执行提示，避免入口看似可点却在下游静默失败。
  const derivativeCreateDisabledReason = useMemo<string | null>(() => {
    if (qingjianEditing) return "请等待青简完成编辑";
    if (!chatInputEditorDisabled) return null;
    if (viewingHistory) return "回到当前版本后可新建稿件";
    if (askUserInputDisabled || dim.overlay === "askUser") {
      return "请先完成问卷，再新建稿件";
    }
    if (dim.content.kind === "pendingReview") {
      return "请先确认或放弃当前修改候选，再新建稿件";
    }
    return "请先完成当前操作，再新建稿件";
  }, [
    qingjianEditing,
    chatInputEditorDisabled,
    viewingHistory,
    askUserInputDisabled,
    dim.overlay,
    dim.content.kind,
  ]);
  const editLockPortalTarget =
    typeof document !== "undefined" ? document.body : null;

  // 出 diff 后(逐字揭示动画结束、审阅条就绪)自动定位并滚到第 1 处 diff:
  // 揭示动画通常把视口带到最后一处,这里把焦点拉回 #1,方便用户从头审。每组 patch 只做一次。
  const autoScrolledReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (effectivePatchRevealing) return; // 等揭示动画收尾
    const ids = visibleReviewTargetIds;
    if (!inlinePatchReview || ids.length === 0) {
      autoScrolledReviewKeyRef.current = null;
      return;
    }
    const key = ids.join(",");
    if (autoScrolledReviewKeyRef.current === key) return;
    autoScrolledReviewKeyRef.current = key;
    const firstId = ids[0]!;
    setActiveReviewTargetId(firstId);
    requestAnimationFrame(() => {
      const el = document.querySelector(reviewTargetSelector(firstId));
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [effectivePatchRevealing, visibleReviewTargetIds, inlinePatchReview]);

  useEffect(() => {
    const previousIds = previousVisibleReviewTargetIdsRef.current;
    previousVisibleReviewTargetIdsRef.current = visibleReviewTargetIds;
    if (!inlinePatchReview || visibleReviewTargetIds.length === 0) {
      if (activeReviewTargetId !== null) setActiveReviewTargetId(null);
      return;
    }
    if (
      activeReviewTargetId &&
      visibleReviewTargetIds.includes(activeReviewTargetId)
    )
      return;
    const previousIndex = activeReviewTargetId
      ? previousIds.indexOf(activeReviewTargetId)
      : -1;
    const nextPatchId =
      previousIndex >= 0
        ? visibleReviewTargetIds[
            Math.min(previousIndex, visibleReviewTargetIds.length - 1)
          ]
        : visibleReviewTargetIds[0];
    setActiveReviewTargetId(nextPatchId ?? null);
  }, [activeReviewTargetId, inlinePatchReview, visibleReviewTargetIds]);

  // 输入框是否已「交接」给右侧条而隐藏 —— 由下面 effect 实测条真在 DOM 才置真,
  // 避免"信号说有条但条没渲染"时把输入框误藏成凭空消失。
  const [inputHandedOff, setInputHandedOff] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false);
  const [reviewLaunchType, setReviewLaunchType] = useState<ReviewType | null>(
    null,
  );

  const loadLexicons = useCallback(async () => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.listLexicons(sessionId);
  }, []);

  const saveLexiconSelection = useCallback(async (enabledLexiconIds: string[]) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.setEnabledLexicons(sessionId, enabledLexiconIds);
  }, []);

  const loadLexiconEntries = useCallback(async (resourceId: string) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.listLexiconEntries(sessionId, resourceId);
  }, []);

  const loadReviewTemplates = useCallback(async (type: ReviewType) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.listReviewTemplates(sessionId, type);
  }, []);

  const saveReviewTemplate = useCallback(
    async (input: {
      id?: string;
      type: ReviewType;
      name: string;
      prompt: string;
    }) => {
      const sessionId = stateRef.current.sessionId;
      const stream = streamRef.current;
      if (!sessionId || !stream) throw new Error("会话未就绪");
      return stream.saveReviewTemplate(sessionId, input);
    },
    [],
  );

  const deleteReviewTemplate = useCallback(async (id: string) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.deleteReviewTemplate(sessionId, id);
  }, []);

  const selectReviewTemplate = useCallback(
    async (type: ReviewType, templateId: string) => {
      const sessionId = stateRef.current.sessionId;
      const stream = streamRef.current;
      if (!sessionId || !stream) throw new Error("会话未就绪");
      await stream.selectReviewTemplate(sessionId, type, templateId);
    },
    [],
  );

  const loadReviewSupplement = useCallback(async (type: ReviewType, templateId?: string) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.getReviewSupplement(sessionId, type, templateId);
  }, []);

  const saveReviewSupplement = useCallback(
    async (type: ReviewType, supplement: string, templateId?: string) => {
      const sessionId = stateRef.current.sessionId;
      const stream = streamRef.current;
      if (!sessionId || !stream) throw new Error("会话未就绪");
      return stream.upsertReviewSupplement(sessionId, type, supplement, templateId);
    },
    [],
  );

  // FLIP 编排:以「接管输入框的条/卡是否真在 DOM」为唯一信号(绕开 askUser pending/running/done 等状态时序),
  // 每次提交后检查;只在条出现/消失的瞬间动手(平时只一次 querySelector,零布局成本)。
  // 条/卡出现:从输入框「框体」矩形几何形变到自身自然落点(box 全程可见,内容到位再由 CSS 浮现),
  // 输入框隐藏被接管;条/卡消失:幽灵框从最后位置形变滑回输入框。纯视觉,不动任何逻辑。
  useLayoutEffect(() => {
    const input = inputMorphRef.current;
    const view = viewRef.current;
    if (!input || !view) return;
    const bar = view.querySelector<HTMLElement>(
      ".ws-float-bar, .patch-nav, .askuser-overlay",
    );
    const present = !!bar;
    const was = prevBarPresentRef.current;
    // 首帧:若卡/条此刻已在 DOM,那是「刷新恢复态」(不是交互中新出现) —— 直接静态交接,
    // 跳过 magicMove,杜绝把卡 pin 到隐藏输入框位置导致刷新后卡不可见+输入锁死。
    const isFirstRun = !flipDidFirstRunRef.current;
    flipDidFirstRunRef.current = true;
    if (isFirstRun && present) {
      prevBarPresentRef.current = true;
      lastBarRectRef.current = bar?.getBoundingClientRect() ?? null;
      setInputHandedOff(true);
      return;
    }
    if (present === was) return; // 平时只一次 querySelector + 比较,零布局成本
    prevBarPresentRef.current = present;
    const morphToken = ++morphTokenRef.current;
    if (present && bar) {
      // 条/卡刚出现:记下它的自然落点(供退出幽灵起点),再几何形变从输入框「框体」矩形展开
      // (量 .wf-input;此刻输入框还没隐藏,测得到真实起点)。随后隐藏输入框交接。
      lastBarRectRef.current = bar.getBoundingClientRect();
      // 刷新恢复:卡是「加载时就已在 DOM」、输入框从未进入可用态(一直锁/morph-out)。此时做
      // 「从输入框矩形飞来」的几何形变,会把卡 pin 到隐藏态输入框的位置 → 卡看不见(=弹框消失+锁死)。
      // 这种场景直接静态交接:卡保持自然落点显示(CSS au-in 入场),只隐藏输入框,不做 magicMove。
      if (!inputWasEverActiveRef.current) {
        setInputHandedOff(true);
        return;
      }
      const inputBox = input.querySelector<HTMLElement>(".wf-input") ?? input;
      bar.style.setProperty("--morph-dur", `${morphTuning.durationMs}ms`); // 同步:形变到位后条内容才淡入
      magicMoveFromRect(bar, inputBox.getBoundingClientRect());
      setInputHandedOff(true);
    } else {
      // 条刚消失(确认/放弃/返回):条已被状态变化卸载,无法再滑它本身 → 造一个「幽灵空框」
      // 从条的最后位置几何形变滑回输入框矩形,到位才显示输入框。这样真实流程点确认也有"条变回输入框"动画。
      const rect = lastBarRectRef.current;
      const inputBox = input.querySelector<HTMLElement>(".wf-input") ?? input;
      if (rect && inputBox) {
        const ghost = document.createElement("div");
        ghost.className = "ws-morph-ghost";
        ghost.style.position = "fixed";
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        view.appendChild(ghost);
        magicMoveToRect(ghost, inputBox.getBoundingClientRect(), {
          onArrive: () => {
            ghost.remove();
            if (
              morphTokenRef.current === morphToken &&
              prevBarPresentRef.current === false
            ) {
              setInputHandedOff(false);
              // 形变返回到位:输入框重现后自动聚焦,用户无需再点一下即可直接打字。
              // 双 rAF 延到 is-morph-hidden(opacity:0)被摘掉、输入框可见后再 focus。
              requestAnimationFrame(() =>
                requestAnimationFrame(() => chatInputRef.current?.focus()),
              );
            }
          },
        });
      } else {
        setInputHandedOff(false);
        // 无动画返回(无 rect / 减少动效):同样把光标聚焦回输入框。
        requestAnimationFrame(() =>
          requestAnimationFrame(() => chatInputRef.current?.focus()),
        );
      }
    }
  });
  const suppressPresentationRun = shouldSuppressPresentationRun({
    hasDocDiff: state.docDiff !== null,
    contentKind: dim.content.kind,
  });
  const effectivePresentationRun = suppressPresentationRun
    ? null
    : presentationRun;
  const {
    findInitialQuery,
    findMode,
    findOpen,
    setFindInitialQuery,
    setFindOpen,
  } = useWorkspaceFind({
    dim,
    viewingVersion: state.viewingVersion,
    presentationRun: effectivePresentationRun,
    editorRef: tiptapEditorRef,
  });
  // 发光特效:打字进行中(且开关开启、非降级)给右栏挂 Apple-Intelligence 环境辉光。
  // 复用全文生成态(locked/drafting)的 ai-inner-glow,用 body data 属性驱动 CSS。
  useEffect(() => {
    const on = effectivePatchRevealing && revealConfig.glow && !reducedMotion;
    if (on) {
      document.body.dataset.patchRevealing = "1";
    } else {
      delete document.body.dataset.patchRevealing;
    }
    return () => {
      delete document.body.dataset.patchRevealing;
    };
  }, [effectivePatchRevealing, revealConfig.glow, reducedMotion]);
  const patchesAccepted = useMemo(
    () =>
      new Set(
        allReviewPatches
          .filter((p) => p.status.kind === "accepted")
          .map((p) => p.id),
      ),
    [allReviewPatches],
  );
  const patchesRejected = useMemo(
    () =>
      new Set(
        allReviewPatches
          .filter((p) => p.status.kind === "rejected")
          .map((p) => p.id),
      ),
    [allReviewPatches],
  );

  const stagePresentationRunForViewDoc = useCallback(
    (finalDoc: ViewDocumentSnapshot) => {
      const current = stateRef.current;
      const alreadyPresented =
        presentedDocumentSnapshotRef.current === finalDoc.version;
      const currentDim = deriveDocDimensions(current);

      if (alreadyPresented) return;
      presentedDocumentSnapshotRef.current = finalDoc.version;

      if (
        shouldSuppressPresentationRun({
          hasDocDiff: current.docDiff !== null,
          contentKind: currentDim.content.kind,
        })
      ) {
        setPresentationRun(null);
        return;
      }

      if (reducedMotionRef.current) {
        setPresentationRun(null);
        return;
      }

      let nextRun: NativePresentationRun | null = null;
      // 动画"是否该播"的判据 = 这篇 doc 是 agent 刚产出的。agentBusy 已统一吸收
      // 后端投影、活跃 stream 与运行中工具；这里保留 streamActive/sawDrafting 作为
      // 恢复旧状态及帧交错时的防御性证据。
      if (
        currentDim.agentBusy ||
        current.streamActive ||
        sawDraftingRef.current
      ) {
        nextRun = {
          id: presentationRunSeqRef.current + 1,
          docVersion: finalDoc.version,
          sessionId: current.sessionId,
          mode: "whole",
          ...(finalDoc.pmDoc ? { finalDoc: finalDoc.pmDoc } : {}),
          baselineSections: [],
          finalSections: cloneViewSections(finalDoc.sections),
        };
      }

      if (nextRun) {
        presentationRunSeqRef.current = nextRun.id;
        logClientEvent("presentationRun.staged", {
          sessionId: current.sessionId ?? undefined,
          meta: {
            performanceNow: clientPerformanceNow(),
            runId: nextRun.id,
            docVersion: nextRun.docVersion,
            eligible: true,
            sectionCount: nextRun.finalSections.length,
          },
        });
        setPresentationRun(nextRun);
        return;
      }

      setPresentationRun(null);
    },
    [],
  );

  const stagePresentationRunForDocFrame = useCallback(
    (wireDoc: DocumentSnapshot) => {
      stagePresentationRunForViewDoc(wireDocToView(wireDoc));
    },
    [stagePresentationRunForViewDoc],
  );

  useEffect(() => {
    // streamActive 继续作为恢复旧状态时的防御性生成信号。
    if (dim.agentBusy || state.streamActive) {
      sawDraftingRef.current = true;
      setPresentationRun((run) =>
        run && run.docVersion === state.doc?.version ? run : null,
      );
      return;
    }

    if (dim.editor === "editable" && state.doc && sawDraftingRef.current) {
      sawDraftingRef.current = false;
      return;
    }

    if (dim.editor !== "editable") {
      sawDraftingRef.current = false;
      setPresentationRun((run) =>
        run && run.docVersion === state.doc?.version ? run : null,
      );
    }
  }, [dim, state.doc, state.streamActive]);

  useEffect(() => {
    setPresentationRun((run) => {
      if (!run) return run;
      // generation_finished 会先交付终稿，但整轮可能仍在执行工具或异步标题生成，
      // 随后服务端才投影 editing。这个窗口里 editor 仍是 locked；
      // 不能据此清掉刚 staged 的同版本 presentationRun，否则 effect cleanup 会在
      // 第一帧后直接回灌成品。run 自身由完成/取消回调或 watchdog 收口；这里只清理
      // 真正失配的版本、会话与 reduced-motion 情形。
      return shouldRetainPresentationRun({
        reducedMotion,
        runDocVersion: run.docVersion,
        currentDocVersion: state.doc?.version ?? null,
        runSessionId: run.sessionId,
        currentSessionId: state.sessionId,
      })
        ? run
        : null;
    });
  }, [reducedMotion, state.doc?.version, state.sessionId]);

  // Create the server stream once. We use a ref-based approach so
  // StrictMode's cleanup/re-mount cycle does NOT dispose the stream
  // while an in-flight SSE request is still active.
  useEffect(() => {
    let effectActive = true;
    if (streamDisposeTimerRef.current !== null) {
      clearTimeout(streamDisposeTimerRef.current);
      streamDisposeTimerRef.current = null;
    }
    const handleFrame = (
      incomingFrame: BridgeFrame,
      streamSessionId: string | null,
      streamGeneration: number,
      afterDeferredDrain = false,
    ) => {
      let frame = incomingFrame;
      const incomingFrameObservability =
        loggedFrameObservabilityOf(incomingFrame);
      const incomingDocument =
        appliedDocVersionFromBroadcastFrame(incomingFrame);
      const incomingGenerationId =
        incomingFrame.kind === "docGenerationEvent" &&
        incomingFrame.data.kind === "generation_finished"
          ? incomingFrame.data.data.generationId
          : incomingFrame.kind === "stream" &&
              incomingFrame.data.kind === "end" &&
              incomingFrame.data.data.finalDocument
            ? `terminal-${incomingFrame.data.data.streamId}`
            : null;
      const terminalDocumentLogFields = incomingDocument
        ? {
            frameKind: incomingFrame.kind,
            frameSeq: incomingFrameObservability?.frameSeq ?? null,
            generationId: incomingGenerationId,
            documentVersion: incomingDocument.version,
            contentHash: incomingDocument.contentHash ?? null,
            frameBytes: incomingFrameObservability?.frameBytes ?? null,
          }
        : null;
      if (streamGenerationRef.current !== streamGeneration) return;
      if (
        !shouldAcceptBridgeFrameForSession({
          frame,
          activeSessionId: activeWorkspaceSessionTargetRef.current,
          streamSessionId,
        })
      ) {
        return;
      }
      observeHydrationFrame(
        frame,
        streamSessionId ?? activeWorkspaceSessionTargetRef.current,
      );

      const terminalReceipt = splitStreamEndFinalDocument(frame);
      if (terminalReceipt) {
        // 生命周期终止与正文冲突是两件事：先无条件解除 active stream，
        // 再让 documentFrame 单独进入 apply/defer/conflict。
        dispatch(terminalReceipt.lifecycleFrame);
        console.info("[terminal-document] terminalized", {
          stage: "terminalized",
          sessionId:
            streamSessionId ?? activeWorkspaceSessionTargetRef.current,
          streamId:
            incomingFrame.kind === "stream" &&
            incomingFrame.data.kind === "end"
              ? incomingFrame.data.data.streamId
              : null,
          ...terminalDocumentLogFields,
        });
        frame = terminalReceipt.documentFrame;
      }

      if (frame.kind === "sessionMeta") {
        activeWorkspaceSessionTargetRef.current = frame.data.sessionId;
        sessionIdRef.current = frame.data.sessionId;
      }
      if (
        frame.kind === "annotationGroupsReady" &&
        (frame.data.invalidatedAnchorCount ?? 0) > 0
      ) {
        showToast({
          message: annotationRemovalToastMessage(frame.data.invalidatedAnchorCount!),
          dedupeKey: "annotation-anchor-invalidated",
        });
      }
      if (isAuthoritativeAskUserCancelFrame(frame)) {
        const sessionId =
          streamSessionId ??
          stateRef.current.sessionId ??
          sessionIdRef.current;
        if (sessionId) {
          askUserCancelMutationTokensRef.current.delete(
            askUserCancelMutationKey(sessionId, frame.data.toolCallId),
          );
        }
      }
      if (frame.kind === "docCommitted") {
        const previousReceipt = reviewCommitReceiptRef.current;
        reviewCommitReceiptRef.current = {
          sessionId: frame.data.sessionId,
          revision: previousReceipt.revision + 1,
          version:
            previousReceipt.sessionId === frame.data.sessionId
              ? Math.max(previousReceipt.version, frame.data.version)
              : frame.data.version,
        };
        if (frame.data.notice) {
          toast.show({
            message: frame.data.notice,
            tone: "warn",
            dedupeKey: `doc-commit-notice:${frame.data.sessionId}:${frame.data.version}`,
          });
        }
      }
      // 本地发起的审阅请求若返回 no-op，说明服务端目标已被其它请求结算；
      // 不能让这个“成功响应”清掉本地仍可见的候选，交由请求完成回调明确提示。
      if (
        frame.kind === "docStateChanged" &&
        frame.data.reviewCompletion === "noop" &&
        reviewCloseInFlightRef.current !== null &&
        selectPatches(stateRef.current).length > 0
      ) {
        return;
      }
      if (
        frame.kind === "docStateChanged" &&
        frame.data.reviewCompletion === "noop" &&
        reviewCloseInFlightRef.current !== null
      ) {
        showToast("修改已经提交，无需重复操作");
      }
      // 服务端与编辑器两侧共用同一个完整性门。即使旧服务端或异常恢复回放了空正文，
      // 客户端也保留上一有效文档，禁止编辑器坍缩为空。
      if (
        frame.kind === "documentSnapshotWritten" &&
        stateRef.current.doc?.pmDoc &&
        isAbnormalDocumentCollapse(
          stateRef.current.doc.pmDoc,
          frame.data.doc.doc,
        )
      ) {
        console.error("[workspace] blocked collapsed document snapshot", {
          sessionId: stateRef.current.sessionId,
          previousVersion: stateRef.current.doc.version,
          incomingVersion: frame.data.doc.version,
        });
        showToast("检测到文档异常坍缩，已保留上一版正文");
        return;
      }
      // 只在确实会写版本的低频帧上比较整篇正文，避免聊天 delta 高频流反复序列化 PM 树。
      if (broadcastContentFrameWritesDocumentVersion(frame)) {
        const locallyOwnedReviewSnapshot =
          frame.kind === "documentSnapshotWritten" &&
          reviewCloseInFlightRef.current !== null;
        const bypassDirtyDecision =
          docConflictReconcileSessionRef.current ===
            (streamSessionId ?? activeWorkspaceSessionTargetRef.current) ||
          locallyOwnedReviewSnapshot;
        const dirty = {
          editorDirty:
            !bypassDirtyDecision &&
            docViewRef.current?.hasLocalDocumentChanges() === true,
          pendingDocWrite:
            !bypassDirtyDecision && pendingDocWriteRef.current,
          queuedDocWrite:
            !bypassDirtyDecision && queuedPmDocRef.current !== null,
          scheduledDocWrite:
            !bypassDirtyDecision && scheduledDocWriteRef.current,
        };
        // editorDirty 会受只读投影/React 基线切换影响，只能作为“需要证明”的
        // 粗信号。所有携带完整 PM 的版本帧统一用同一条强证明：live 正文与来帧
        // 规范化相等，且编辑器没有待保存事务。docDiffReady 首帧和迟到 canonical
        // 快照都走这里；真实用户编辑与版本分叉仍不能越过。
        const incomingDocumentComparison = incomingDocument === null
          ? "unavailable"
          : docViewRef.current?.compareIncomingDocument(
              incomingDocument.pmDoc,
            ) ?? "unavailable";
        const incomingDocumentMatchesEditor =
          incomingDocumentComparison === "equivalent";
        const decision = decideBroadcastDocumentFrame({
          frame,
          ...dirty,
          incomingDocumentMatchesEditor,
          incomingDocumentComparisonUnavailable:
            incomingDocument !== null &&
            incomingDocumentComparison === "unavailable",
          // 本标签提交审阅的权威快照、显式冲突重载都必须直接应用；只有普通
          // 广播里的 pendingReview 同基线回放需要 reconcile 保留候选。
          reviewActive:
            !bypassDirtyDecision &&
            stateRef.current.docState.kind === "pendingReview",
          reviewBaseVersion: stateRef.current.docDiff?.baseVersion ?? null,
          afterDeferredDrain,
        });
        if (decision.kind === "defer") {
          const deferred = deferredDocumentFrameRef.current;
          const deferredVersion = deferred
            ? appliedDocVersionFromBroadcastFrame(deferred.frame)?.version ?? -1
            : -1;
          if (!deferred || (incomingDocument?.version ?? -1) >= deferredVersion) {
            deferredDocumentFrameRef.current = {
              frame,
              streamSessionId,
              streamGeneration,
            };
          }
          console.info("[workspace] canonical document frame deferred", {
            stage: "deferred",
            sessionId:
              streamSessionId ?? activeWorkspaceSessionTargetRef.current,
            reason: decision.reason,
            version: incomingDocument?.version ?? null,
            editorDirty: dirty.editorDirty,
            pendingDocWrite: dirty.pendingDocWrite,
            queuedDocWrite: dirty.queuedDocWrite,
            scheduledDocWrite: dirty.scheduledDocWrite,
            incomingDocumentMatchesEditor,
            incomingDocumentComparison,
            ...terminalDocumentLogFields,
          });
          if (!deferredDocumentFrameDrainRef.current) {
            deferredDocumentFrameDrainRef.current = true;
            void (async () => {
              try {
                // generation_finished 可能正好撞上编辑器 400ms debounce。主动
                // flush 后再等私有 updateDoc 回执，把它变成可判定的保存 drain。
                await docViewRef.current?.flushPendingDocSave();
                await waitForPendingDocSaveDrain();
              } catch (error) {
                console.warn(
                  "[workspace] local save failed before deferred canonical replay",
                  error,
                );
              } finally {
                deferredDocumentFrameDrainRef.current = false;
              }
              // 让 manualDocSaved/编辑器 canonical 同步先完成一个 task，再重判；
              // 若此时 editor 仍 dirty，会进入 conflict 而不是再次 defer。
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, 0);
              });
              const queued = deferredDocumentFrameRef.current;
              deferredDocumentFrameRef.current = null;
              if (
                !queued ||
                streamGenerationRef.current !== queued.streamGeneration ||
                (
                  queued.streamSessionId !== null &&
                  activeWorkspaceSessionTargetRef.current !== queued.streamSessionId
                )
              ) {
                return;
              }
              handleFrame(
                queued.frame,
                queued.streamSessionId,
                queued.streamGeneration,
                true,
              );
            })();
          }
          return;
        }
        if (decision.kind === "reconcile") {
          if (incomingDocument) {
            knownDocVersionsRef.current.remember(
              appliedDocWriteBaseline(incomingDocument),
              "streamApply",
            );
          }
          console.info("[workspace] canonical review baseline reconciled", {
            stage: "reconciled",
            sessionId:
              streamSessionId ?? activeWorkspaceSessionTargetRef.current,
            reason: decision.reason,
            version: incomingDocument?.version ?? null,
            editorDirty: dirty.editorDirty,
            pendingDocWrite: dirty.pendingDocWrite,
            queuedDocWrite: dirty.queuedDocWrite,
            scheduledDocWrite: dirty.scheduledDocWrite,
            incomingDocumentMatchesEditor,
            incomingDocumentComparison,
            ...terminalDocumentLogFields,
          });
          return;
        }
        if (decision.kind === "conflict") {
          const conflicted = incomingDocument;
          conflictedDocumentFrameRef.current = frame;
          if (conflicted) {
            knownDocVersionsRef.current.remember(
              appliedDocWriteBaseline(conflicted),
              "streamConflict",
            );
            dispatch({
              kind: "documentFrameConflict",
              actualDocumentSnapshot: conflicted.version,
            });
          }
          console.warn("[workspace] canonical document frame conflicted", {
            stage: "conflicted",
            sessionId:
              streamSessionId ?? activeWorkspaceSessionTargetRef.current,
            reason: decision.reason,
            version: conflicted?.version ?? null,
            editorDirty: dirty.editorDirty,
            pendingDocWrite: dirty.pendingDocWrite,
            queuedDocWrite: dirty.queuedDocWrite,
            scheduledDocWrite: dirty.scheduledDocWrite,
            incomingDocumentMatchesEditor,
            incomingDocumentComparison,
            ...terminalDocumentLogFields,
          });
          return;
        }
        // 走到这里这一帧就会被应用:把它带来的版本登记为"本会话已知产出"。
        // agent 生成流写出的版本正是从这条路进来的——它不是外部并发,后续冲突要静默重放。
        // 反之被上面守卫挡掉的帧不登记:本地没应用它,那才是真分叉,该弹横幅。
        const applied = incomingDocument;
        if (applied) {
          knownDocVersionsRef.current.remember(
            appliedDocWriteBaseline(applied),
            "streamApply",
          );
          console.info("[terminal-document] applied", {
            stage: "applied",
            sessionId:
              streamSessionId ?? activeWorkspaceSessionTargetRef.current,
            streamId:
              incomingFrame.kind === "stream" &&
              incomingFrame.data.kind === "end"
                ? incomingFrame.data.data.streamId
                : null,
            editorDirty: dirty.editorDirty,
            pendingDocWrite: dirty.pendingDocWrite,
            queuedDocWrite: dirty.queuedDocWrite,
            scheduledDocWrite: dirty.scheduledDocWrite,
            incomingDocumentMatchesEditor,
            incomingDocumentComparison,
            ...terminalDocumentLogFields,
          });
        }
      }
      if (frame.kind === "documentSnapshotWritten") {
        stagePresentationRunForDocFrame(frame.data.doc);
      }
      if (
        frame.kind === "sessionRestoreCompleted" &&
        docConflictReconcileSessionRef.current === frame.data.sessionId
      ) {
        docConflictReconcileSessionRef.current = null;
      }
      if (frame.kind === "derivativeGenFinished") {
        const previousFinishedAt = finishedDerivativeGenerationRef.current.get(
          frame.data.docId,
        );
        if (!previousFinishedAt || frame.data.generatedAt > previousFinishedAt) {
          finishedDerivativeGenerationRef.current.set(
            frame.data.docId,
            frame.data.generatedAt,
          );
        }
        setDerivatives((current) =>
          reconcileFinishedDerivativeGenerations(
            current,
            finishedDerivativeGenerationRef.current,
          ),
        );
        // Agent 逐稿完成时跟随最新完成的译稿；最终自然停在最后一种语言。
        setActiveTranslationDocId(frame.data.docId);
        const stream = streamRef.current;
        const sessionId = stateRef.current.sessionId;
        if (stream && sessionId) {
          void retryDisposedServerStreamOnce(
            stream,
            () => streamRef.current,
            (currentStream) => currentStream.listDerivatives(sessionId),
          )
            .then((items) => {
              setDerivatives(reconcileFinishedDerivativeGenerations(
                items,
                finishedDerivativeGenerationRef.current,
              ));
            })
            .catch((error) => {
              console.error(
                "[workspace] refresh finished translation failed",
                error,
              );
            });
        }
      }
      if (
        frame.kind === "docGenerationEvent" &&
        frame.data.kind === "generation_finished"
      ) {
        stagePresentationRunForViewDoc(
          pmDocToViewDocumentSnapshot(
            frame.data.data.doc,
            frame.data.data.finalVersion,
          ),
        );
      }
      if (frame.kind === "folderSourceOperationResult") {
        const result = frame.data;
        if (!result.ok) {
          if (result.op === "attach") {
            pendingBrowserAttachRef.current.delete(result.requestId);
          }
          showToast(folderSourceOperationFailureToast(result));
        } else if (result.op === "detach") {
          const sessionId =
            activeWorkspaceSessionTargetRef.current ??
            stateRef.current.sessionId ??
            sessionIdRef.current;
          if (sessionId) {
            void forgetBrowserFolderSource(sessionId, result.folderId).catch(
              (error) => {
                console.warn(
                  "[workspace] browser folder bridge cleanup failed",
                  error,
                );
              },
            );
          }
        } else if (result.op === "attach") {
          const pending = pendingBrowserAttachRef.current.get(
            result.requestId,
          );
          if (!pending) return;
          if (result.clientSourceId !== pending.picked.clientSourceId) return;
          pendingBrowserAttachRef.current.delete(result.requestId);
          void rememberAttachedBrowserFolderSource({
            sessionId: pending.sessionId,
            folderId: result.folderId,
            picked: pending.picked,
          })
            .then(() => {
              activeBrowserFolderKeysRef.current.set(
                `${pending.sessionId}\0${result.folderId}`,
                { sessionId: pending.sessionId, folderId: result.folderId },
              );
            })
            .catch((error) => {
              console.error(
                "[workspace] browser folder bridge start failed",
                error,
              );
              showToast("文件夹已连接，但浏览器桥接未就绪，请刷新后重试");
            });
        }
      }
      if (frame.kind === "docWriteResult") {
        const isLatestOwnMutation =
          frame.data.clientMutationId === latestDocMutationIdRef.current;
        const ack = docWriteAckRef.current.get(frame.data.clientMutationId);
        const savedPmDoc = lastSentPmDocRef.current;
        const savedBaseline = lastSentDocWriteBaselineRef.current;
        const queuedBeforeResult = queuedPmDocRef.current;
        if (!shouldHandleDocWriteResult({
          isLatestOwnMutation,
          hasMatchingWaiter: ack !== undefined,
        })) {
          return;
        }
        docWriteAckRef.current.delete(frame.data.clientMutationId);
        if (isLatestOwnMutation) {
          pendingDocWriteRef.current = false;
          latestDocMutationIdRef.current = null;
          if (frame.data.ok) {
            docVersionRef.current = frame.data.docVersion;
            // 落库成功即结算重放链
            silentConflictReplayDepthRef.current = 0;
            if (savedPmDoc) {
              const canonicalHash = acknowledgedDocWriteContentHash(
                frame.data,
                savedPmDoc,
              );
              baseContentHashRef.current = canonicalHash;
              knownDocVersionsRef.current.remember(
                {
                  expectedDocumentSnapshot: frame.data.docVersion,
                  baseContentHash: canonicalHash,
                  baseHasSubstantiveContent:
                    pmDocHasSubstantiveContent(savedPmDoc),
                },
                "selfWrite",
              );
            }
          } else if (!("conflict" in frame.data)) {
            queuedPmDocRef.current = null;
          }
        }
        const writeConflict =
          !frame.data.ok && "conflict" in frame.data
            ? frame.data.conflict
            : null;
        const silentlyReconcileEmptyConflict =
          writeConflict !== null &&
          isEmptyScaffoldConflict({
            baseline: savedBaseline,
            submittedDoc: savedPmDoc,
            queuedDoc: queuedBeforeResult?.pmDoc ?? null,
          });
        // 冲突静默重放:服务端现版本若是本会话自己产出的(本标签上一笔写入,或 agent 生成流
        // 刚推进、本标签也已应用的那一版),这笔只是基线取早了,不是别人在改。用该版本的
        // canonical 基线重发即可,用户不该看到"文档已被更新"。版本不在已知账本里才是真外部并发。
        const conflictResolution = resolveDocWriteConflict({
          conflict: writeConflict,
          isLatestOwnMutation,
          hasSubmittedDoc: savedPmDoc !== null,
          knownActualVersion: writeConflict
            ? knownDocVersionsRef.current.get(writeConflict.actualDocumentSnapshot)
            : null,
          replayedAgainstActual: writeConflict
            ? replayedConflictVersionsRef.current.has(
                writeConflict.actualDocumentSnapshot,
              )
            : false,
          replayDepth: silentConflictReplayDepthRef.current,
        });
        if (conflictResolution.kind === "silentReplay" && writeConflict) {
          replayedConflictVersionsRef.current.add(
            writeConflict.actualDocumentSnapshot,
          );
          silentConflictReplayDepthRef.current += 1;
          const replayPmDoc = savedPmDoc!;
          const replayBaseline: DocWriteBaseline = conflictResolution.baseline;
          ack?.resolve();
          window.setTimeout(() => {
            sendDocWriteRef.current(replayPmDoc, undefined, replayBaseline).catch((error) => {
              console.error("[workspace] 自冲突重放失败", error);
            });
          }, 0);
          return;
        }
        if (silentlyReconcileEmptyConflict) {
          queuedPmDocRef.current = null;
          lastSentPmDocRef.current = null;
          lastSentDocWriteBaselineRef.current = null;
          ack?.resolve();
          resolvePendingDocSaveDrain();
          const sessionId =
            streamSessionId ??
            stateRef.current.sessionId ??
            sessionIdRef.current;
          if (
            sessionId &&
            writeConflict.actualDocumentSnapshot >
              stateRef.current.version
          ) {
            docConflictReconcileSessionRef.current = sessionId;
            void restoreExistingSession(sessionId).catch((error) => {
              if (docConflictReconcileSessionRef.current === sessionId) {
                docConflictReconcileSessionRef.current = null;
              }
              console.error(
                "[workspace] conflict 后权威文档恢复失败",
                error,
              );
            });
          }
          return;
        }
        dispatch(frame);
        // 诊断 p01:手动保存成功后把已保存文档同步进 canonical state.doc——
        // 此前只更新版本号,审阅/拒绝从陈旧 state.doc 重渲染时手动内容会"消失"。
        const hasQueuedPmDoc = queuedPmDocRef.current !== null;
        const shouldDispatchManualDocSaved =
          shouldDispatchManualDocSavedForWriteResult({
            isLatestOwnMutation,
            writeOk: frame.data.ok,
            hasLastSentPmDoc: savedPmDoc !== null,
            hasQueuedPmDoc,
          });
        if (frame.data.ok && savedPmDoc && shouldDispatchManualDocSaved) {
          dispatch({
            kind: "manualDocSaved",
            pmDoc: savedPmDoc,
            version: frame.data.docVersion,
          });
        }
        if (ack) {
          if (frame.data.ok) {
            ack.resolve();
          } else {
            ack.reject(
              new PendingDocSaveError(
                docWriteResultMessage(frame.data),
                frame.data,
              ),
            );
          }
        }
        if (isLatestOwnMutation && frame.data.ok && queuedPmDocRef.current) {
          const queued = queuedPmDocRef.current;
          queuedPmDocRef.current = null;
          // 仅本标签上一笔成功回执可安全把同一条本地编辑链推进到新基线；
          // 外部 agent/标签快照没有这个因果保证，绝不能如此 rebase。
          const rebasedQueued: QueuedDocWrite = {
            ...queued,
            baseline: {
              expectedDocumentSnapshot: frame.data.docVersion,
              baseContentHash: baseContentHashRef.current,
              baseHasSubstantiveContent: Boolean(
                savedPmDoc && pmDocHasSubstantiveContent(savedPmDoc),
              ),
            },
          };
          scheduledDocWriteRef.current = true;
          window.setTimeout(() => {
            scheduledDocWriteRef.current = false;
            if (
              streamGenerationRef.current !== rebasedQueued.streamGeneration ||
              sessionIdRef.current !== rebasedQueued.sessionId ||
              streamRef.current !== rebasedQueued.stream
            ) {
              console.warn(
                "[workspace] discarded queued updateDoc after session boundary",
              );
              resolvePendingDocSaveDrain();
              return;
            }
            sendDocWriteRef.current(
              rebasedQueued.pmDoc,
              rebasedQueued,
              rebasedQueued.baseline,
            ).catch((error) => {
              console.error("[workspace] queued updateDoc failed", error);
            });
          }, 0);
        } else if (isLatestOwnMutation && frame.data.ok) {
          resolvePendingDocSaveDrain();
        } else if (isLatestOwnMutation && !frame.data.ok) {
          rejectPendingDocSaveDrain(
            new PendingDocSaveError(
              docWriteResultMessage(frame.data),
              frame.data,
            ),
          );
        }
        return;
      }
      dispatch(frame);
    };

    const startWorkspaceStream = (
      targetSessionId: string | null,
      options: {
        resetSessionState: boolean;
        preservePreviousStream?: ServerStream | null;
      },
    ): ServerStream => {
      const previousStream = streamRef.current;
      const abandoningDocSave =
        pendingDocWriteRef.current ||
        queuedPmDocRef.current !== null ||
        scheduledDocWriteRef.current;
      if (abandoningDocSave) {
        console.warn(
          "[workspace] discarding undrained updateDoc at session boundary",
        );
        const error = new PendingDocSaveError(
          "会话已切换，旧会话的待保存内容已停止发送。",
        );
        if (docSaveRetryTimerRef.current !== null) {
          clearTimeout(docSaveRetryTimerRef.current);
          docSaveRetryTimerRef.current = null;
        }
        queuedPmDocRef.current = null;
        pendingDocWriteRef.current = false;
        scheduledDocWriteRef.current = false;
        latestDocMutationIdRef.current = null;
        for (const waiter of docWriteAckRef.current.values()) {
          waiter.reject(error);
        }
        docWriteAckRef.current.clear();
        rejectPendingDocSaveDrain(error);
      }
      const streamGeneration = streamGenerationRef.current + 1;
      streamGenerationRef.current = streamGeneration;
      activeWorkspaceSessionTargetRef.current = targetSessionId;
      sessionIdRef.current = targetSessionId;
      restoreExistingSessionIdRef.current = targetSessionId;
      docConflictReconcileSessionRef.current = null;
      lastSentPmDocRef.current = null;
      lastSentDocWriteBaselineRef.current = null;
      deferredDocumentFrameRef.current = null;
      deferredDocumentFrameDrainRef.current = false;
      conflictedDocumentFrameRef.current = null;
      // 已知产出账本按会话隔离:换会话后旧文档的版本号不能再当"自产"用
      knownDocVersionsRef.current.clear();
      replayedConflictVersionsRef.current.clear();
      silentConflictReplayDepthRef.current = 0;
      startSessionPromisesBySessionRef.current.clear();
      startNewSessionPromiseRef.current = null;
      activeFolderAttachRef.current?.controller.abort(
        new DOMException("Folder attach superseded by session switch", "AbortError"),
      );
      activeFolderAttachRef.current = null;
      pendingBrowserAttachRef.current.clear();
      setSendPending(false);
      beginWorkspaceHydration(targetSessionId);

      if (options.resetSessionState && targetSessionId) {
        const storedTitle = sessionTitleFromStore(targetSessionId);
        setTitle(storedTitle ?? "");
        dispatch({
          kind: "sessionMeta",
          data: {
            sessionId: targetSessionId,
            title: storedTitle ?? "未命名草稿",
          },
        });
      }

      if (previousStream !== options.preservePreviousStream) {
        previousStream?.dispose();
      }
      // 资源注册表是模块级单例,切换会话会残留上一个会话的素材("串了")。
      // 建立新 stream 前先清空;本会话的素材随后由 restore/实时 resourceUpserted 帧重建。
      resources.reset();

      const stream = new ServerStream((action) => {
        if (streamGenerationRef.current === streamGeneration) dispatch(action);
      });
      streamRef.current = stream;
      stream.subscribe((frame: BridgeFrame) => {
        handleFrame(frame, targetSessionId, streamGeneration);
      });

      if (targetSessionId) {
        restoreExistingSession(targetSessionId).catch((e) => {
          if (
            streamGenerationRef.current === streamGeneration &&
            activeWorkspaceSessionTargetRef.current === targetSessionId
          ) {
            console.error("[workspace] session restore failed", e);
          }
        });
      }

      return stream;
    };

    const initialSessionId = workspaceSessionIdFromHash(window.location.hash);
    if (streamRef.current === null) {
      startWorkspaceStream(initialSessionId, { resetSessionState: false });
    }

    const syncHashSession = async () => {
      const nextSessionId = workspaceSessionIdFromHash(window.location.hash);
      if (
        nextSessionId === activeWorkspaceSessionTargetRef.current &&
        streamRef.current
      )
        return;
      // 会话边界必须先于文档保存等待作废旧发送；否则旧上传/保存 continuation
      // 会在这 300ms 窗口继续向新会话投影解析态或发送消息。
      cancelWorkspaceTurnDispatch(turnDispatchGateRef.current, nextSessionId);
      setSendPending(false);
      // hash/popstate 切换不会触发组件 cleanup；先以旧 sessionId 捕获当前编辑器正文，
      // 正常 flush 超时/失败时把最新正文和旧 stream 转交后台链，再立即切换会话。
      const fallbackDocSave = preparePageExitDocSaveRef.current();
      let preservedPreviousStream: ServerStream | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("session boundary doc save timed out")),
            300,
          );
          flushPendingDocSaveRef.current().then(
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            (error) => {
              window.clearTimeout(timer);
              reject(error);
            },
          );
        });
      } catch (error) {
        console.error(
          "[workspace] failed to flush updateDoc before session switch",
          error,
        );
        preservedPreviousStream =
          fallbackDocSave?.({ deferUntilPendingSettles: true })
            ?.preservedStream ?? null;
      }
      startWorkspaceStream(nextSessionId, {
        resetSessionState: true,
        preservePreviousStream: preservedPreviousStream,
      });
    };

    // hashchange:用户改地址栏 hash(含 session 参数)即重切会话。
    // popstate:浏览器前进/后退(history 导航)同样可能换到另一会话的 URL,
    // 但 pushState/replaceState 本身不触发 hashchange,只有 back/forward 才补发 popstate,
    // 故一并监听 popstate,使前进后退在两会话间切换也能正确重载(不再串台停在原会话)。
    window.addEventListener("hashchange", syncHashSession);
    window.addEventListener("popstate", syncHashSession);
    return () => {
      effectActive = false;
      window.removeEventListener("hashchange", syncHashSession);
      window.removeEventListener("popstate", syncHashSession);
      // 延迟释放让开发 StrictMode 的立即 cleanup/re-run 有机会取消 dispose，
      // 避免误杀首轮在途 SSE；真实离开工作区时定时器会关闭客户端通道。
      const streamToDispose = streamRef.current;
      if (!streamToDispose) return;
      // 子编辑器随后卸载会把 400ms 防抖正文推入保存队列；先同步捕获当前正文，
      // 供正常 flush 失败/超时时走 beacon/keepalive，避免编辑器销毁后无法取回内容。
      const fallbackDocSave = preparePageExitDocSaveRef.current();
      streamDisposeTimerRef.current = setTimeout(() => {
        streamDisposeTimerRef.current = null;
        if (!fallbackDocSave) {
          streamToDispose.dispose();
          if (streamRef.current === streamToDispose) streamRef.current = null;
          return;
        }
        void (async () => {
          let timeout: ReturnType<typeof setTimeout> | null = null;
          let handoffOwnsStream = false;
          try {
            await Promise.race([
              flushPendingDocSaveRef.current(),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("workspace exit doc save timed out")),
                  300,
                );
              }),
            ]);
          } catch (error) {
            console.error(
              "[workspace] failed to flush updateDoc before workspace exit",
              error,
            );
            const handoff = fallbackDocSave({
              deferUntilPendingSettles: true,
            });
            handoffOwnsStream =
              handoff?.preservedStream === streamToDispose;
          } finally {
            if (timeout !== null) clearTimeout(timeout);
            if (!handoffOwnsStream) {
              streamToDispose.dispose();
              if (streamRef.current === streamToDispose) {
                streamRef.current = null;
              }
            }
          }
        })();
      }, 75);
    };
  }, [
    beginWorkspaceHydration,
    clearHydrationTimers,
    rejectPendingDocSaveDrain,
    markMaterialParsing,
    markMaterialParsingTurnError,
    observeHydrationFrame,
    resolvePendingDocSaveDrain,
    restoreExistingSession,
    sendAttachFolderSelection,
    showToast,
    stagePresentationRunForDocFrame,
    stagePresentationRunForViewDoc,
    toast,
  ]);

  // 组件卸载时清掉在排的瞬态保存重试定时器,防孤儿定时器卸载后用旧态杂散重发。
  useEffect(() => {
    return () => {
      clearHydrationTimers();
      if (docSaveRetryTimerRef.current !== null) {
        clearTimeout(docSaveRetryTimerRef.current);
        docSaveRetryTimerRef.current = null;
      }
    };
  }, [clearHydrationTimers]);

  // Mirror content and tool dimensions onto <body> for CSS state hooks.
  useEffect(() => {
    const body = document.body;
    body.dataset.content = dataAttrs.content;
    body.dataset.tool = dataAttrs.tool;
    body.dataset.wsState = workspaceVisualState(dim);
    return () => {
      delete body.dataset.content;
      delete body.dataset.tool;
      delete body.dataset.wsState;
    };
  }, [dataAttrs, dim]);

  useEffect(() => {
    if (state.title && state.title !== "未命名草稿") setTitle(state.title);
  }, [state.title]);

  const refreshDerivatives = useCallback(async () => {
    const stream = streamRef.current;
    const requestSessionId = stateRef.current.sessionId;
    if (!stream || !requestSessionId) return;
    const requestGeneration = derivativeListGenerationRef.current + 1;
    derivativeListGenerationRef.current = requestGeneration;
    let nextDerivatives: DerivativeItem[];
    try {
      nextDerivatives = await retryDisposedServerStreamOnce(
        stream,
        () => streamRef.current,
        (currentStream) => currentStream.listDerivatives(requestSessionId),
      );
    } catch (error) {
      // 离开工作区会 dispose 旧控制器的流并清空其 ref；随后重开的流属于新的
      // React 实例，旧请求既无法也不应跨实例补发。新实例会自行刷新列表。
      if (
        isServerStreamDisposedError(error) &&
        streamRef.current !== stream
      ) {
        return;
      }
      throw error;
    }
    if (
      stateRef.current.sessionId !== requestSessionId ||
      derivativeListGenerationRef.current !== requestGeneration
    ) {
      return;
    }
    setDerivatives(reconcileFinishedDerivativeGenerations(
      nextDerivatives,
      finishedDerivativeGenerationRef.current,
    ));
  }, []);

  useEffect(() => {
    setDerivatives([]);
    setActiveTab("main");
    setActiveTranslationDocId(null);
    finishedDerivativeGenerationRef.current.clear();
    if (!state.sessionId) return;
    void refreshDerivatives().catch((error) =>
      console.error("[workspace] list derivatives failed", error),
    );
  }, [refreshDerivatives, state.sessionId]);

  useEffect(() => {
    if (!state.sessionId || state.version <= 0) return;
    const timer = window.setTimeout(
      () =>
        void refreshDerivatives().catch((error) =>
          console.error(
            "[workspace] refresh derivatives after commit failed",
            error,
          ),
        ),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [refreshDerivatives, state.sessionId, state.version]);

  useEffect(() => {
    if (activeTab === "main") return;
    void refreshDerivatives().catch((error) =>
      console.error("[workspace] refresh derivatives on tab activate failed", error),
    );
  }, [activeTab, refreshDerivatives]);

  // 衍生稿元数据不做常驻轮询：正常完成由 derivativeGenFinished 帧刷新，切换 Tab
  // 也会刷新一次。生成中的活动视图仅在 DerivativeView 内按 2s 轮询单稿正文，
  // 完成、视图卸载/切换或 3 分钟兜底超时即停止，避免 listDerivatives 泄漏。

  const handleCreateDerivative = useCallback(
    async (params: DerivativeGenerateParams) => {
      const stream = streamRef.current;
      const sessionId = stateRef.current.sessionId;
      if (!stream || !sessionId) {
        showToast("会话未就绪");
        return;
      }
      setDerivativeCreating(true);
      const descriptor = DTYPE_REGISTRY[derivativeCreateDtype];
      const createdItems: DerivativeItem[] = [];
      let failedTargetLang: string | undefined;
      try {
        const targetLanguages =
          descriptor.dtype === "translate"
            ? (params.targetLanguages ?? [])
            : [undefined];
        if (descriptor.dtype === "translate" && targetLanguages.length === 0) {
          throw new Error("请至少选择一种目标语言");
        }
        for (const targetLang of targetLanguages) {
          failedTargetLang = targetLang;
          createdItems.push(
            await stream.createDerivative(
              sessionId,
              descriptor.dtype,
              params.templateId,
              params.privatePrompt,
              params.writingStyleId,
              params.layoutStyleId,
              targetLang,
            ),
          );
          failedTargetLang = undefined;
        }
        const item = createdItems[0]!;
        await refreshDerivatives();
        setDerivativeCreateOpen(false);
        if (descriptor.dtype === "translate") {
          // 不让会话里既有的空译稿截留选中态；提交后立即展示本批首个目标语种。
          setActiveTranslationDocId(item.docId);
        }
        setPendingDerivativeGeneration(item.docId);
        setActiveTab(descriptor.dtype === "translate" ? "translate" : item.docId);
        const templateName =
          descriptor.templates.find(
            (template) => template.id === params.templateId,
          )?.name ?? params.templateId;
        if (descriptor.dtype === "translate") {
          const targets = createdItems.map((created) => ({
            docId: created.docId,
            targetLang: created.targetLang ?? "目标语言",
          }));
          sendDerivativeQueryRef.current(
            buildTranslationAgentQuery(targets),
            buildTranslationDisplayCard(
              targets.map((target) => target.targetLang),
              templateName,
              params.privatePrompt,
            ),
            undefined,
            { kind: "derivative", docId: item.docId },
          );
        } else {
          const lines = [{ label: "模板", value: templateName }];
          if (params.privatePrompt.trim()) {
            lines.push({ label: "补充", value: params.privatePrompt.trim() });
          }
          sendDerivativeQueryRef.current(
            descriptor.queryText(item.docId),
            {
              title: descriptor.cardTitle(false),
              lines,
              status: "done",
            },
            undefined,
            { kind: "derivative", docId: item.docId },
          );
        }
      } catch (error) {
        console.error("[workspace] create derivative failed", error);
        if (
          descriptor.dtype === "translate" &&
          createdItems.length > 0 &&
          failedTargetLang
        ) {
          try {
            await refreshDerivatives();
          } catch (refreshError) {
            console.error(
              "[workspace] refresh derivatives after partial create failed",
              refreshError,
            );
          }
          setDerivativeCreateOpen(false);
          const createdLanguages = createdItems
            .map((created) => created.targetLang ?? "目标语言")
            .join("、");
          showToast(
            `已创建${createdLanguages}；${failedTargetLang}创建失败，可重试未完成语种`,
          );
          return;
        }
        showToast(
          `创建${DTYPE_REGISTRY[derivativeCreateDtype].label}失败 · 请重试`,
        );
      } finally {
        setDerivativeCreating(false);
      }
    },
    [derivativeCreateDtype, refreshDerivatives, showToast],
  );

  useEffect(() => {
    const hydratedTitle = hydratedSessionTitle(title);
    const currentTitle =
      hydratedTitle ?? sessionTitleFromStore(state.sessionId);
    setCurrentSession(state.sessionId, currentTitle);
    if (state.sessionId && hydratedTitle) {
      updateSessionTitle(state.sessionId, hydratedTitle);
    }
    return () => setCurrentSession(null);
  }, [setCurrentSession, state.sessionId, title, updateSessionTitle]);

  useEffect(
    () =>
      chatInputBus.subscribe((text) => {
        window.setTimeout(() => {
          chatInputRef.current?.insertText(text);
        }, 0);
      }),
    [],
  );

  // 一点即发(二维码过期刷新等):预填后下一拍提交,等输入框状态落定。
  useEffect(
    () =>
      chatInputBus.subscribeSend((text) => {
        submitImmediateChatInputSend({
          chatInput: chatInputRef.current,
          text,
          viewingHistory: stateRef.current.viewingVersion !== null,
          submit: () => handleSubmitChatRef.current(),
          showToast,
        });
      }),
    [showToast],
  );

  useEffect(() => {
    const syncViewingVersion = () => {
      if (!HISTORY_ENTRY_ENABLED) {
        dispatch({ kind: "viewingVersionSet", version: null, versionId: null });
        return;
      }
      dispatch({
        kind: "viewingVersionSet",
        version: workspaceViewingVersionFromHash(window.location.hash),
        versionId: workspaceViewingVersionIdFromHash(window.location.hash),
      });
    };
    syncViewingVersion();
    window.addEventListener("hashchange", syncViewingVersion);
    return () => window.removeEventListener("hashchange", syncViewingVersion);
  }, []);

  const closeViewingVersion = useCallback(() => {
    window.location.hash = workspaceHashWithViewingVersion(
      window.location.hash,
      null,
    );
  }, []);

  useEffect(() => {
    const versionId = state.viewingVersionId;
    if (state.viewingVersion === null) {
      dispatch({ kind: "historySnapshotSet", doc: null });
      return;
    }
    const sessionId =
      state.sessionId ?? workspaceSessionIdFromHash(window.location.hash);
    if (!versionId || !sessionId) {
      dispatch({ kind: "historySnapshotSet", doc: null });
      closeViewingVersion();
      showToast("历史版本链接已失效");
      return;
    }

    let cancelled = false;
    fetch(workspaceHistorySnapshotUrl(versionId, sessionId))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HistorySnapshot;
      })
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({
          kind: "historySnapshotSet",
          doc: pmDocToViewDocumentSnapshot(
            snapshot.doc as PmDoc,
            snapshot.docVersion,
          ),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[workspace] history snapshot load failed", error);
        dispatch({ kind: "historySnapshotSet", doc: null });
        showToast("历史版本加载失败");
        closeViewingVersion();
      });

    return () => {
      cancelled = true;
    };
  }, [
    closeViewingVersion,
    showToast,
    state.sessionId,
    state.viewingVersion,
    state.viewingVersionId,
  ]);

  const {
    flushPendingDocSave,
    getLatestExportPmDoc,
    handleCreateBlankDoc,
    handleEditorChange,
    handleFillTemplate,
    preparePageExitDocSave,
  } = useWorkspaceDocumentEditor({
    tiptapEditor,
    tiptapEditorRef,
    state,
    stateRef,
    streamRef,
    streamGenerationRef,
    sessionIdRef,
    startNewSessionPromiseRef,
    docVersionRef,
    baseContentHashRef,
    pendingDocWriteRef,
    queuedPmDocRef,
    scheduledDocWriteRef,
    latestDocMutationIdRef,
    lastSentPmDocRef,
    lastSentDocWriteBaselineRef,
    docWriteAckRef,
    docSaveRetryTimerRef,
    sendDocWriteRef,
    pendingBlankFocusRef,
    fillTemplatePromiseRef,
    presentationRunRef,
    docViewRef,
    pageExitDocSaveFingerprintRef,
    foregroundDocSaveDepthRef,
    dispatch,
    showToast,
    showBackgroundDocSaveFailure,
    rejectPendingDocSaveDrain,
    resolvePendingDocSaveDrain,
    waitForPendingDocSaveDrain,
  });
  flushPendingDocSaveRef.current = flushPendingDocSave;
  preparePageExitDocSaveRef.current = preparePageExitDocSave;

  const clearPresentationRun = useCallback(() => {
    setPresentationRun(null);
  }, []);

  useEffect(() => {
    if (!presentationRun) return;

    const watchedRun = presentationRun;
    const startedAt = clientPerformanceNow();
    const timeoutMs = presentationRunWatchdogMs(watchedRun);
    const timer = setTimeout(() => {
      const current = presentationRunRef.current;
      if (
        !current ||
        current.id !== watchedRun.id ||
        current.docVersion !== watchedRun.docVersion
      ) {
        return;
      }
      const performanceNow = clientPerformanceNow();
      logClientEvent("presentationRun.watchdog_clear", {
        sessionId: current.sessionId ?? undefined,
        meta: {
          performanceNow,
          runId: current.id,
          docVersion: current.docVersion,
          mode: current.mode,
          timeoutMs,
          elapsedMs: Math.max(0, Math.round(performanceNow - startedAt)),
        },
      });
      setPresentationRun(null);
    }, timeoutMs);

    return () => clearTimeout(timer);
  }, [presentationRun]);

  useEffect(() => {
    if (suppressPresentationRun && presentationRun) setPresentationRun(null);
  }, [suppressPresentationRun, presentationRun]);

  useEffect(() => {
    if (presentationRun) setHasReplayablePresentation(true);
  }, [presentationRun]);

  useEffect(() => {
    if (replaySessionIdRef.current === state.sessionId) return;
    replaySessionIdRef.current = state.sessionId;
    setHasReplayablePresentation(
      Boolean(presentationRun && presentationRun.sessionId === state.sessionId),
    );
  }, [presentationRun, state.sessionId]);

  const handleReplayLastPresentation = useCallback(() => {
    const cachedRun = docViewRef.current?.getLastPresentationRun();
    const current = stateRef.current;
    if (
      !cachedRun ||
      !current.doc ||
      cachedRun.docVersion !== current.doc.version ||
      cachedRun.sessionId !== current.sessionId
    ) {
      setHasReplayablePresentation(false);
      showToast("先生成一次");
      return;
    }

    const nextRun = cloneNativePresentationRun(cachedRun);
    nextRun.id = presentationRunSeqRef.current + 1;
    presentationRunSeqRef.current = nextRun.id;
    setPresentationRun(nextRun);
    setHasReplayablePresentation(true);
    showToast("重播上次动效");
  }, [showToast]);

  // Start a server session at most once, then reuse it for every later
  // message. Gating on session existence (not document content state) is what
  // prevents R15: a plain-text first turn leaves docState "init", and the
  // old code would start a SECOND session on the next message → sessionMeta
  // reset wiped the chat. Logic lives in the shared, unit-tested helper.
  const ensureSessionId = useCallback(
    (stream: ServerStream): Promise<string> => {
      const activeTarget = activeWorkspaceSessionTargetRef.current;
      if (activeTarget) return Promise.resolve(activeTarget);
      return ensureSessionIdOnce(
        stream,
        stateRef,
        sessionIdRef,
        startNewSessionPromiseRef,
        replaceWorkspaceSessionHash,
      );
    },
    [],
  );

  const handleAttachFolder = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const stream = streamRef.current;
    if (!stream) {
      showToast("连接未就绪");
      throw new Error("连接未就绪");
    }
    if (
      folderSource?.provider === "browser-fs-access" &&
      folderSource.status === "permission_required"
    ) {
      const result = await requestBrowserFolderPermission(folderSource);
      signal?.throwIfAborted();
      if (result.status === "connected") {
        setBrowserFolderOverrides((current) => {
          const { [folderSource.id]: _removed, ...rest } = current;
          return rest;
        });
        activeBrowserFolderKeysRef.current.set(
          `${folderSource.sessionId}\0${folderSource.id}`,
          { sessionId: folderSource.sessionId, folderId: folderSource.id },
        );
        showToast("文件夹授权已恢复");
        return;
      }
      setBrowserFolderOverrides((current) => ({
        ...current,
        [folderSource.id]: {
          status:
            result.status === "missing" ? "permission_required" : result.status,
          error: result.error,
        },
      }));
      showToast(result.error);
      return;
    }
    const selectFolderSource = window.electron?.isDesktop
      ? window.electron.selectFolderSource
      : undefined;

    let desktopSelection: Awaited<
      ReturnType<NonNullable<typeof selectFolderSource>>
    > | null = null;
    let browserSelection: PickedBrowserFolderSource | null = null;
    if (selectFolderSource) {
      try {
        desktopSelection = await selectFolderSource();
      } catch (error) {
        console.error("[workspace] selectFolderSource failed", error);
        showToast("选择文件夹失败，请重试");
        throw error;
      }
      signal?.throwIfAborted();
      if (!desktopSelection) {
        throw new DOMException("Folder selection cancelled", "AbortError");
      }
    } else if (
      folderCapability.enabled &&
      typeof window.showDirectoryPicker === "function"
    ) {
      try {
        browserSelection = await pickBrowserFolderSource(
          sessionIdRef.current ?? "pending",
        );
      } catch (error) {
        // 用户在系统选择器里点了取消(AbortError)→ 不弹任何提示(原来会弹一条英文 toast)。
        if (isAbortError(error)) throw error;
        console.error("[workspace] showDirectoryPicker failed", error);
        showToast(
          error instanceof Error ? error.message : "选择文件夹失败，请重试",
        );
        throw error;
      }
      signal?.throwIfAborted();
    } else {
      showToast(folderCapability.reason ?? "当前浏览器不支持本地文件夹访问");
      throw new Error("当前环境不支持本地文件夹访问");
    }

    let sessionId: string;
    try {
      sessionId = await ensureSessionId(stream);
    } catch (error) {
      console.error(
        "[workspace] ensure session for attachFolder failed",
        error,
      );
      showToast("会话创建失败，请重试");
      throw error;
    }
    signal?.throwIfAborted();

    const selection: FolderAttachSelection = desktopSelection
      ? {
          provider: "desktop-local",
          selectionToken: desktopSelection.selectionToken,
        }
      : { provider: "browser-fs-access", picked: browserSelection! };
    const operationController = new AbortController();
    const forwardAbort = () => operationController.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    activeFolderAttachRef.current?.controller.abort(
      new DOMException("Folder attach superseded", "AbortError"),
    );
    activeFolderAttachRef.current = {
      sessionId,
      controller: operationController,
    };
    try {
      await sendAttachFolderSelection(stream, sessionId, selection, {
        signal: operationController.signal,
      });
    } catch (error) {
      if (error instanceof FolderAttachTimeoutError) {
        showToast(error.message);
      } else if (!isAbortError(error)) {
        console.error("[workspace] attachFolder failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        showToast("连接文件夹失败，请重试");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      if (activeFolderAttachRef.current?.controller === operationController) {
        activeFolderAttachRef.current = null;
      }
    }
  }, [
    ensureSessionId,
    folderCapability.enabled,
    folderCapability.reason,
    folderSource,
    sendAttachFolderSelection,
    showToast,
  ]);

  const handleDetachFolder = useCallback(
    async (folderId: string) => {
      const stream = streamRef.current;
      const sessionId = stateRef.current.sessionId ?? sessionIdRef.current;
      if (!stream || !sessionId) {
        showToast("会话未就绪");
        return;
      }

      const command: Extract<Command, { kind: "detachFolder" }> = {
        kind: "detachFolder",
        data: { sessionId, folderId },
      };
      try {
        validateCommand(command);
      } catch (error) {
        console.error("[workspace] detachFolder validation failed", error);
        showToast("命令校验失败 · 见 console");
        return;
      }

      try {
        await stream.sendCommand(command);
      } catch (error) {
        console.error("[workspace] detachFolder failed", error);
        showToast("断开文件夹失败，请重试");
      }
    },
    [showToast],
  );

  const {
    handleCancelActiveStream,
    handleSubmitChat,
  } =
    useWorkspaceChatActions({
      dim,
      askUserInputDisabled,
      tiptapEditor,
      state,
      stateRef,
      streamRef,
      chatInputRef,
      handleSubmitChatRef,
      fillTemplatePromiseRef,
      lastRetriableSendRef,
      reviewCloseInFlightRef,
      restoreExistingSessionIdRef,
      turnDispatchGateRef,
      dispatch,
      setPreviewSource,
      setSendPending,
      flushPendingDocSave,
      markMaterialParsing,
      markMaterialParsingTurnError,
      materialParsingTurnKeyRef,
      ensureSessionId,
      showToast,
      toast,
      handleBackHome,
      restoreExistingSession,
      activeDocument: activeDocumentTurnTarget.activeDocument,
    });

  const sendDerivativeQuery = useCallback(
    (
      text: string,
      displayCard: ActionCardData,
      reviewContext?: ReviewContext,
      targetOverride?: ActiveDocumentTarget,
    ) => {
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return;
      }
      const dispatchToken = beginWorkspaceTurnDispatch(
        turnDispatchGateRef.current,
        stateRef.current.sessionId,
      );
      const clientMessageId = newClientMessageId();
      dispatch({
        kind: "chatMessageAdded",
        data: {
          message: {
            id: clientMessageId,
            role: { kind: "user" },
            ts: new Date().toISOString(),
            parts: [{ kind: "actionCard", data: displayCard }],
            chips: [],
          },
        },
      });
      void prepareAndDispatchWorkspaceTurn({
        gate: turnDispatchGateRef.current,
        token: dispatchToken,
        prepare: async () => {
          const sessionId = await ensureSessionId(stream);
          return {
            kind: "sendMessage",
            data: {
              sessionId,
              text,
              skills: [],
              chips: [],
              fileIds: [],
              clientMessageId,
              activeDocument:
                targetOverride ?? activeDocumentTurnTarget.activeDocument,
              displayCard,
              ...(!reviewContext ? { turnKind: "generateDerivative" as const } : {}),
              ...(reviewContext ? { reviewContext } : {}),
            },
          } satisfies Extract<Command, { kind: "sendMessage" }>;
        },
        dispatch: async (command) => {
          lastRetriableSendRef.current = command;
          await stream.sendCommand(command);
        },
      }).catch((error) => {
        if (
          !isWorkspaceTurnDispatchCurrent(
            turnDispatchGateRef.current,
            dispatchToken,
          )
        ) {
          return;
        }
        console.error("[workspace] derivative query send failed", error);
        showToast("生成指令发送失败,请重试");
      });
    },
    [activeDocumentTurnTarget.activeDocument, ensureSessionId, showToast],
  );
  sendDerivativeQueryRef.current = sendDerivativeQuery;

  const handleAiModify = useCallback(
    async (target: AiModifyTarget): Promise<boolean> =>
      runAiModifyTarget({
        target,
        getBlockReason: () => chatInputBlockReasonRef.current,
        isTextRangeAllowed: (from, to) =>
          !tiptapEditor ||
          isEditorRangeWithinSingleTextBlock(tiptapEditor, from, to) ||
          // 原子块(图表/图片/公式等)整块引用放行。
          isEditorRangeSingleAtomBlock(tiptapEditor, from, to),
        flushPendingDocSave,
        insertChip: (spec) => chatInputRef.current?.insertChip(spec) ?? false,
        onToast: showToast,
        onSaveFailure: (error) => showToast(docSaveFailureToastMessage(error)),
      }),
    [flushPendingDocSave, showToast, tiptapEditor],
  );

  const {
    activePatchIndex,
    currentPatchId,
    currentReviewTargetId,
    handleAcceptAll,
    handleCancelAskUser,
    handleCommit,
    handleJumpNext,
    handleJumpPrev,
    handlePatchVerdict,
    handleRejectAll,
    handleSubmitAskUserAnswers,
    handleSubmitPlan,
    isReviewSubmitting,
    reviewSettlementRetryPending,
    remainingPatches,
    reviewedCount,
    submittingAskUserId,
  } = useWorkspaceReviewActions({
    state,
    stateRef,
    streamRef,
    askUserCancelMutationTokensRef,
    reviewCommitReceiptRef,
    reviewCloseInFlightRef,
    dispatch,
    showToast,
    allReviewPatches,
    pendingReviewPatches,
    visibleReviewTargets,
    visibleReviewTargetIds,
    activeReviewTargetId,
    setActiveReviewTargetId,
    finalizeReviewTablePatch,
    setTableTypedByPatch,
  });

  // 用户在预览里编辑素材摘要并保存:乐观更新 registry(保留 metadata.fileId 不丢预览能力),
  // 再发 updateMaterialSummary 命令落库;服务端 resourceUpdated(带 fileId)回正。
  const handleEditSummary = useCallback(
    (materialId: string, summary: string) => {
      if (agentActive) {
        showToast("正在生成中，请稍后再保存摘要");
        return false;
      }
      if (!state.sessionId) {
        showToast("会话未就绪");
        return false;
      }
      const command: Command = {
        kind: "updateMaterialSummary",
        data: { sessionId: state.sessionId, materialId, summary },
      };
      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] updateMaterialSummary validation failed", e);
        showToast("操作失败，请重试");
        return false;
      }
      const stream = streamRef.current;
      if (!stream) {
        // 没有连接就别做乐观更新(否则本地显示已保存但没落库)。
        showToast("未连接服务 · 请稍后重试");
        return false;
      }
      const ref = { id: materialId, domain: { kind: "file" } as const };
      const snapshot = resources.get(ref);
      if (!snapshot) {
        showToast("素材已不在");
        return false;
      }
      const mutation = workspaceMutations.tryRun(
        resourceMutationKey(ref.domain.kind, ref.id),
        {
          capture: () => snapshot,
          applyOptimistic: () => {
            resources.applyUpdate(ref, summary);
            setPreviewSource((current) =>
              current?.id === materialId
                ? { ...current, abstract: summary }
                : current,
            );
          },
          commit: () =>
            stream.updateMaterialSummary(
              command.data.sessionId,
              command.data.materialId,
              command.data.summary,
            ),
          rollback: (previous) => {
            if (!resources.get(ref)) return;
            resources.upsert(previous);
            setPreviewSource((current) =>
              current?.id === materialId
                ? {
                    ...current,
                    abstract: previous.summary ?? "",
                  }
                : current,
            );
          },
        },
      );
      if (!mutation) {
        showToast("摘要正在保存，请稍候");
        return false;
      }
      mutation.promise.catch((e) => {
        console.error("[workspace] updateMaterialSummary failed", e);
        showToast("摘要保存失败 · 已恢复原内容");
      });
      return true;
    },
    [agentActive, setPreviewSource, state.sessionId, showToast],
  );

  // 移除已上传到项目里的副本:先弹产品确认框,确认后仍走 removeMaterial 命令链。
  const handleRemoveMaterial = useCallback(
    async (source: AssetSource) => {
      const requestSessionId = state.sessionId;
      if (!requestSessionId) {
        showToast("会话未就绪");
        return;
      }
      const accepted = await confirm({
        title: `移除「${source.name}」？`,
        message: "仅移除已上传到项目里的副本，你电脑上的原始文件不受影响。",
        confirmLabel: "移除副本",
        cancelLabel: "取消",
      });
      if (!accepted) {
        return;
      }
      if (
        !workspaceMountedRef.current ||
        stateRef.current.sessionId !== requestSessionId ||
        activeWorkspaceSessionTargetRef.current !== requestSessionId
      ) {
        return;
      }
      const command: Command = {
        kind: "removeMaterial",
        data: { sessionId: requestSessionId, materialId: source.id },
      };
      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] removeMaterial validation failed", e);
        showToast("操作失败，请重试");
        return;
      }
      const stream = streamRef.current;
      if (!stream) {
        showToast("未连接服务 · 请稍后重试");
        return;
      }
      // 若正在预览被删素材则关预览(真正的移除等服务端 resourceRemoved 帧回来)。
      setPreviewSource((cur) => (cur && cur.id === source.id ? null : cur));
      stream.sendCommand(command).catch((e) => {
        console.error("[workspace] removeMaterial failed", e);
        showToast("删除失败 · 请重试");
      });
    },
    [confirm, state.sessionId, showToast],
  );

  return {
    viewRef,
    dataAttrs,
    hydration,
    sessionRestoreBlocked,
    title,
    setTitle,
    handleBackHome,
    showToast,
    exportAnchorRef,
    reviewAnchorRef,
    exportDisabledReason,
    reviewDisabledReason,
    derivativeCreateDisabledReason,
    exportMenuOpen,
    setExportMenuOpen,
    reviewMenuOpen,
    setReviewMenuOpen,
    reviewLaunchType,
    setReviewLaunchType,
    loadLexicons,
    saveLexiconSelection,
    loadLexiconEntries,
    loadReviewTemplates,
    saveReviewTemplate,
    deleteReviewTemplate,
    selectReviewTemplate,
    loadReviewSupplement,
    saveReviewSupplement,
    flushPendingDocSave,
    getLatestExportPmDoc,
    state,
    dispatchAnnotationGroups,
    derivatives,
    activeTab,
    setActiveTab,
    activeDocumentTurnTarget,
    activeTranslationDocId,
    setActiveTranslationDocId,
    derivativeCreateOpen,
    setDerivativeCreateOpen,
    derivativeCreateDtype,
    setDerivativeCreateDtype,
    derivativeCreating,
    pendingDerivativeGeneration,
    setPendingDerivativeGeneration,
    handleCreateDerivative,
    refreshDerivatives,
    sendDerivativeQuery,
    effectivePatchRevealing,
    reviewUiState,
    liveHunkKey,
    wholeDocReview,
    wholeDocReviewKeysRef,
    chatScrollRef,
    debugMode,
    inputHandedOff,
    inputMorphRef,
    chatInputEditorDisabled,
    inputContentOut,
    chatInputRef,
    chatInputPlaceholder,
    agentActive,
    chatInputSendEnabledWhenDisabled,
    handleSubmitChat,
    handleCancelActiveStream,
    setPreviewSource,
    handleRemoveMaterial,
    folderSource,
    folderCapability,
    handleAttachFolder,
    handleDetachFolder,
    materialParseRows,
    handleRetryMaterialParse,
    materialPanelOpenSignal,
    handleEditSummary,
    hasModelKey,
    modelKeyGate,
    inlineAsk,
    handleCancelAskUser,
    handleSubmitAskUserAnswers,
    previewExit,
    docScrollRef,
    dim,
    handleFillTemplate,
    handleCreateBlankDoc,
    handleRetryRestore,
    wholeDocVersion,
    editedNewDoc,
    handleWholeDocVersionChange,
    patchesAccepted,
    patchesRejected,
    reviewedCount,
    remainingPatches,
    activePatchIndex,
    visiblePatchCount,
    unrenderablePatchCount,
    inlinePatchReview,
    isReviewSubmitting,
    reviewSettlementRetryPending,
    awaitingWholeDocReviewMaterial,
    fullpageAsk,
    submittingAskUserId,
    docViewRef,
    patchMeta,
    currentPatchId,
    overlayInputs,
    blockPatchInputs,
    patchPresentation,
    currentReviewTargetId,
    revealedPatchIds,
    revealCursors,
    typedByPatch,
    tableTypedByPatch,
    streamRef,
    effectivePresentationRun,
    reducedMotion,
    handleAiModify,
    handleSubmitPlan,
    handleJumpPrev,
    handleJumpNext,
    handleRejectAll,
    handleAcceptAll,
    handleCommit,
    handlePatchVerdict,
    closeViewingVersion,
    setTiptapEditor,
    markDocumentSurfaceReady,
    handleEditorChange,
    clearPresentationRun,
    findOpen,
    findMode,
    tiptapEditor,
    findInitialQuery,
    setFindOpen,
    setFindInitialQuery,
    editLockHint,
    editLockPortalTarget,
    devToolsOpen,
    handleRevealReplay,
    demoBarKind,
    demoBarShown,
    handleMorphKind,
    handleMorphEnter,
    handleMorphReturn,
    setDevToolsOpen,
    previewSource,
  };
}

export type WorkspacePageController = ReturnType<
  typeof useWorkspacePageController
>;

function patchIdSelector(patchId: string): string {
  const escape =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape
      : (value: string) => value.replace(/["\\]/g, "\\$&");
  return `[data-patch-id="${escape(patchId)}"]:not(.wf-patch-del)`;
}

function reviewTargetSelector(targetId: string): string {
  const escape =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape
      : (value: string) => value.replace(/["\\]/g, "\\$&");
  return `[data-review-target-id="${escape(targetId)}"],${patchIdSelector(targetId)}`;
}
