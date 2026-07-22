import type {
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
import type { PmDoc } from "@qingagent/pm-schema";
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
  clearPendingFiles,
  clearPendingFolderSource,
  deriveFolderCapability,
  peekPendingFiles,
  peekPendingFolderSource,
  useClientCapabilities,
  useToast,
} from "../../../system";
import { useConfirm } from "../../../system/ConfirmProvider";
import { useModelKeyConfigured } from "../../../system/modelKeyGate";
import { resources, useResourceList } from "../../../system/resources";
import { validateCommand } from "../../../system/validators";
import type { ChatInputHandle } from "../data/chatInputTypes";
import { buildWholeDocReviewKey } from "../components/ChatMessageList";
import type { DerivativeGenerateParams } from "../components/derivatives/DerivativeGenerateModal";
import {
  DTYPE_REGISTRY,
  type DerivativeDtype,
} from "../components/derivatives/dtypeRegistry";
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
} from "../data/chatInputBlockReason";
import { logClientEvent } from "../data/clientLog";
import { cloneViewSections } from "../data/cloneViewDoc";
import { installAnnotationGroupDecorations } from "../data/annotationDecorations";
import { deriveDocDimensions } from "../data/docDimensions";
import {
  buildAttachFolderCommand,
  folderAttachSelectionFromPending,
  folderSourceOperationFailureToast,
  type FolderAttachSelection,
} from "../data/folderAttach";
import {
  cloneNativePresentationRun,
  type NativePresentationRun,
} from "../data/nativeDiffAnimation";
import {
  PendingDocSaveError,
  docSaveFailureToastMessage,
  docWriteResultMessage,
  type PendingDocSaveWaiter,
} from "../data/pendingDocSave";
import type {
  BlockPatchInput,
  PatchOverlayInput,
  ViewDocumentSnapshot,
} from "../data/protocol";
import {
  derivePatchPresentation,
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
import { ServerStream } from "../data/serverStream";
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
import type { AssetSource } from "../data/sources";
import {
  MATERIAL_PARSE_BUSY_REASON,
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
import { useAutoScroll } from "../useAutoScroll";
import { useAssetPreviewState } from "./useAssetPreviewState";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useReviewReveal } from "./useReviewReveal";
import { useWorkspaceChatActions } from "./useWorkspaceChatActions";
import { useWorkspaceChrome } from "./useWorkspaceChrome";
import { useWorkspaceDebugControls } from "./useWorkspaceDebugControls";
import {
  useWorkspaceDocumentEditor,
  type QueuedDocWrite,
  type SendDocWrite,
} from "./useWorkspaceDocumentEditor";
import { useWorkspaceFind } from "./useWorkspaceFind";
import { useWorkspaceReviewActions } from "./useWorkspaceReviewActions";
export { RightPane } from "../components/RightPane";
export {
  buildPageExitDocSaveCommand,
  flushDocSaveOnPageExit,
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

export function useWorkspacePageController() {
  // 初始化不带标题(空),真实会话标题加载后再 setTitle 覆盖。
  const [title, setTitle] = useState("");
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
  const [derivatives, setDerivatives] = useState<DerivativeItem[]>([]);
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
    ) => void
  >(() => undefined);
  const [activeTab, setActiveTab] = useState<"main" | string>("main");
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
  const streamDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startNewSessionPromiseRef = useRef<Promise<string> | null>(null);
  const startSessionPromisesBySessionRef = useRef<Map<string, Promise<string>>>(
    new Map(),
  );
  const restoreExistingSessionIdRef = useRef<string | null>(null);
  const lastRetriableSendRef = useRef<Extract<
    Command,
    { kind: "sendMessage" }
  > | null>(null);
  const reviewCloseInFlightRef = useRef<Promise<void> | null>(null);
  const pendingBrowserAttachRef = useRef<{
    sessionId: string;
    picked: PickedBrowserFolderSource;
  } | null>(null);
  const activeBrowserFolderKeysRef = useRef<
    Map<string, { sessionId: string; folderId: string }>
  >(new Map());
  const docVersionRef = useRef(state.version);
  const pendingDocWriteRef = useRef(false);
  const queuedPmDocRef = useRef<QueuedDocWrite | null>(null);
  const scheduledDocWriteRef = useRef(false);
  const latestDocMutationIdRef = useRef<string | null>(null);
  const docWriteAckRef = useRef<Map<string, PendingDocSaveWaiter>>(new Map());
  const docSaveDrainWaitersRef = useRef<PendingDocSaveWaiter[]>([]);
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
  const presentationRunSeqRef = useRef(0);
  const sawDraftingRef = useRef(false);
  const presentedDocumentSnapshotRef = useRef<number | null>(null);
  const sendDocWriteRef = useRef<SendDocWrite>(() =>
    Promise.resolve(),
  );
  const flushPendingDocSaveRef = useRef<() => Promise<void>>(() =>
    Promise.resolve(),
  );
  const preparePageExitDocSaveRef = useRef<() => (() => void) | null>(
    () => null,
  );
  const reducedMotionRef = useRef(false);
  stateRef.current = state;
  sessionIdRef.current = state.sessionId ?? sessionIdRef.current;
  docVersionRef.current = state.version;
  presentationRunRef.current = presentationRun;
  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const showToast = useCallback(
    (msg: string, durationMs?: number) => toast.show(msg, durationMs),
    [toast],
  );
  useEffect(() => {
    if (!tiptapEditor || tiptapEditor.isDestroyed) return;
    return installAnnotationGroupDecorations(
      tiptapEditor,
      state.docState.kind === "pendingReview" ? [] : state.annotationGroups,
      (groups, unlocatedGroupCount) => {
        dispatch({ kind: "annotationGroupsChanged", groups });
        if (unlocatedGroupCount > 0) {
          showToast(`${unlocatedGroupCount}处因文档已改动未能定位`);
        }
      },
      state.previewGroups,
    );
  }, [showToast, state.annotationGroups, state.docState.kind, state.previewGroups, tiptapEditor]);
  const dispatchAnnotationGroups = useCallback((groups: AnnotationGroup[]) => {
    dispatch({ kind: "annotationGroupsChanged", groups });
  }, []);
  tiptapEditorRef.current = tiptapEditor;
  useEffect(() => {
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
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

  const createAttachFolderResultWaiter = useCallback(
    (
      stream: ServerStream,
      sessionId: string,
      selection: FolderAttachSelection,
      options: { awaitBrowserBridge?: boolean } = {},
    ): {
      promise: Promise<void>;
      cancel: () => void;
    } => {
      let unsubscribe: (() => void) | null = null;
      const promise = new Promise<void>((resolve, reject) => {
        unsubscribe = stream.subscribe((frame: BridgeFrame) => {
          if (
            frame.kind !== "folderSourceOperationResult" ||
            frame.data.op !== "attach"
          )
            return;
          unsubscribe?.();
          unsubscribe = null;
          const result = frame.data;
          if (!result.ok) {
            reject(new Error(folderSourceOperationFailureToast(result)));
            return;
          }
          if (
            selection.provider !== "browser-fs-access" ||
            !options.awaitBrowserBridge
          ) {
            resolve();
            return;
          }
          void rememberAttachedBrowserFolderSource({
            sessionId,
            folderId: result.folderId,
            picked: selection.picked,
          })
            .then(() => {
              activeBrowserFolderKeysRef.current.set(
                `${sessionId}\0${result.folderId}`,
                { sessionId, folderId: result.folderId },
              );
              resolve();
            })
            .catch((error) => {
              console.error(
                "[workspace] browser folder bridge start failed",
                error,
              );
              reject(
                new Error("连接文件夹失败：浏览器桥接未就绪，请刷新或重试"),
              );
            });
        });
      });
      return {
        promise,
        cancel() {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
    [],
  );

  const sendAttachFolderSelection = useCallback(
    async (
      stream: ServerStream,
      sessionId: string,
      selection: FolderAttachSelection,
      options: { awaitBrowserBridge?: boolean } = {},
    ): Promise<void> => {
      const command = buildAttachFolderCommand(sessionId, selection);
      const attachResult = createAttachFolderResultWaiter(
        stream,
        sessionId,
        selection,
        options,
      );
      let usedGlobalPending = false;
      if (selection.provider === "browser-fs-access") {
        if (!options.awaitBrowserBridge) {
          pendingBrowserAttachRef.current = {
            sessionId,
            picked: selection.picked,
          };
          usedGlobalPending = true;
        }
      }

      try {
        validateCommand(command);
      } catch (error) {
        attachResult.cancel();
        if (usedGlobalPending) pendingBrowserAttachRef.current = null;
        console.error("[workspace] attachFolder validation failed", error);
        showToast("命令校验失败 · 见 console");
        throw error;
      }

      try {
        await stream.sendCommand(command);
        await attachResult.promise;
      } catch (error) {
        attachResult.cancel();
        if (usedGlobalPending) pendingBrowserAttachRef.current = null;
        throw error;
      }
    },
    [createAttachFolderResultWaiter, showToast],
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

  const hasModelKey = useModelKeyConfigured();

  const dim = useMemo(() => deriveDocDimensions(state), [state]);
  // Agent 在跑 = 真实信号(流已激活 / 后端 agentBusy)并联乐观 sendPending。
  // 输入框据此挂环境辉光,覆盖"刚发出→流激活"的空窗,以及生成期间不流式输出的 writeDraft 长憋。
  const agentActive = state.streamActive || dim.agentBusy || sendPending;
  const fileResources = useResourceList({ kind: "file" });
  const sendMaterialParseCommand = useCallback(async (command: Command) => {
    return sendMaterialParseCommandWithStream(streamRef.current, command);
  }, []);
  const {
    rows: materialParseRows,
    markParsing: markMaterialParsing,
    retry: retryMaterialParse,
  } = useMaterialParseTracker({
    sessionId: state.sessionId,
    resources: fileResources,
    agentActive,
    sendCommand: sendMaterialParseCommand,
  });
  const handleRetryMaterialParse = useCallback(
    (fileId: string) => {
      if (agentActive) {
        showToast(MATERIAL_PARSE_BUSY_REASON);
        return;
      }
      retryMaterialParse(fileId).catch((error) => {
        console.error("[workspace] reparseMaterial failed", error);
        showToast(
          error instanceof Error && error.message
            ? error.message
            : "重试解析失败，请稍后再试",
        );
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
    for (const source of browserSources) {
      void ensureBrowserFolderBridge(source).then((result) => {
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
  const chatInputBlockReason = useMemo(
    () =>
      getChatInputBlockReason(
        dim,
        askUserInputDisabled,
        viewingHistory,
        hasAskUserCard,
      ),
    [dim, askUserInputDisabled, viewingHistory, hasAskUserCard],
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
  // 导出按钮 gating:① 文档区为空(无可导出内容);② 不在可发送态(右侧问卷 / 上方审批条),
  // 因为平台导出要把 query 发回对话,这两态下发送会冲突。disable + hover 提示原因。
  // 文案按原因分流(e2e-loop-0704 R12:笼统的"完成问卷或处理未提交修改"让用户找不到入口)。
  const exportDisabledReason = useMemo<string | null>(() => {
    if (dim.content.kind === "empty") return "还没有可导出的内容";
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
    chatInputEditorDisabled,
    viewingHistory,
    askUserInputDisabled,
  ]);
  const allReviewPatches = useMemo(() => selectPatches(state), [state]);
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
    return allReviewPatches.flatMap((tc, order) => {
      if (tc.body.kind !== "docSuggestion") return [];
      const s = tc.status.kind;
      if (s !== "reviewing" && s !== "accepted" && s !== "rejected") return [];
      if (tc.body.data.kind !== "suggestion") return [];
      if (overlayCoveredIds.has(tc.body.data.data.id)) return [];
      return suggestionToBlockPatchInputs(tc.body.data.data, order);
    });
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
  const editLockHint =
    dataAttrs.tool === "agentBusy" ||
    dataAttrs.tool === "imageProgress" ||
    effectivePatchRevealing
      ? "请等待青简完成编辑后再做修改"
      : dim.content.kind === "pendingReview"
        ? "请先确认或放弃当前修改候选"
        : null;
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

  const loadReviewSupplement = useCallback(async (type: ReviewType) => {
    const sessionId = stateRef.current.sessionId;
    const stream = streamRef.current;
    if (!sessionId || !stream) throw new Error("会话未就绪");
    return stream.getReviewSupplement(sessionId, type);
  }, []);

  const saveReviewSupplement = useCallback(
    async (type: ReviewType, supplement: string) => {
      const sessionId = stateRef.current.sessionId;
      const stream = streamRef.current;
      if (!sessionId || !stream) throw new Error("会话未就绪");
      return stream.upsertReviewSupplement(sessionId, type, supplement);
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
      // 动画"是否该播"的判据 = 这篇 doc 是 agent 刚产出的。P0 把 deriveDocDimensions().agentBusy
      // 改成读后端投影态(生成进行中不保证发 agentBusy:true),故并联前端可靠的 streamActive
      // (= activeStreamIds>0,正是 P0 前 agentBusy 的来源),恢复"生成后播放"的触发。
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
    // streamActive 并联:生成进行中前端可靠为真(P0 前 agentBusy 即由它推导)。
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
      // generation_finished 会先交付终稿并清 busy，随后服务端才可能完成异步标题生成、
      // 投影 editing。这个窗口里 docState 仍是 drafting，editor 因而暂时 locked；
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
    if (streamDisposeTimerRef.current !== null) {
      clearTimeout(streamDisposeTimerRef.current);
      streamDisposeTimerRef.current = null;
    }
    const handleFrame = (
      frame: BridgeFrame,
      streamSessionId: string | null,
      streamGeneration: number,
    ) => {
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

      if (frame.kind === "sessionMeta") {
        activeWorkspaceSessionTargetRef.current = frame.data.sessionId;
        sessionIdRef.current = frame.data.sessionId;
      }
      if (frame.kind === "documentSnapshotWritten") {
        stagePresentationRunForDocFrame(frame.data.doc);
      }
      if (frame.kind === "derivativeGenFinished") {
        const stream = streamRef.current;
        const sessionId = stateRef.current.sessionId;
        if (stream && sessionId) {
          void stream
            .listDerivatives(sessionId)
            .then(setDerivatives)
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
          if (result.op === "attach") pendingBrowserAttachRef.current = null;
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
        } else if (pendingBrowserAttachRef.current) {
          const pending = pendingBrowserAttachRef.current;
          pendingBrowserAttachRef.current = null;
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
        docWriteAckRef.current.delete(frame.data.clientMutationId);
        if (isLatestOwnMutation) {
          pendingDocWriteRef.current = false;
          latestDocMutationIdRef.current = null;
          if (frame.data.ok) {
            docVersionRef.current = frame.data.docVersion;
          } else {
            queuedPmDocRef.current = null;
          }
        }
        dispatch(frame);
        // 诊断 p01:手动保存成功后把已保存文档同步进 canonical state.doc——
        // 此前只更新版本号,审阅/拒绝从陈旧 state.doc 重渲染时手动内容会"消失"。
        const savedPmDoc = lastSentPmDocRef.current;
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
          scheduledDocWriteRef.current = true;
          window.setTimeout(() => {
            scheduledDocWriteRef.current = false;
            if (
              streamGenerationRef.current !== queued.streamGeneration ||
              sessionIdRef.current !== queued.sessionId ||
              streamRef.current !== queued.stream
            ) {
              console.warn(
                "[workspace] discarded queued updateDoc after session boundary",
              );
              resolvePendingDocSaveDrain();
              return;
            }
            sendDocWriteRef.current(queued.pmDoc, queued).catch((error) => {
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
      options: { resetSessionState: boolean },
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
      startSessionPromisesBySessionRef.current.clear();
      startNewSessionPromiseRef.current = null;
      pendingBrowserAttachRef.current = null;
      setSendPending(false);

      if (options.resetSessionState && targetSessionId) {
        setTitle("");
        dispatch({
          kind: "sessionMeta",
          data: { sessionId: targetSessionId, title: "未命名草稿" },
        });
      }

      previousStream?.dispose();
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
    const createdInitialStream = streamRef.current === null;
    const stream =
      streamRef.current ??
      startWorkspaceStream(initialSessionId, {
        resetSessionState: false,
      });

    // Check for pending text/files from NewSessionPage
    const pending = sessionStorage.getItem("qingagent:pending-message");
    const files = peekPendingFiles();
    const pendingFolder = peekPendingFolderSource();
    // 新建页选的技能(0702:此前 skills 写死 [],技能被整个丢掉)。防御性解析:坏 JSON/坏形状一律当没有。
    const pendingSkills: Extract<
      Command,
      { kind: "sendMessage" }
    >["data"]["skills"] = (() => {
      try {
        const raw = sessionStorage.getItem("qingagent:pending-skills");
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(
            (s): s is { id: string } =>
              Boolean(s) && typeof s.id === "string" && s.id.length > 0,
          )
          .map((s) => ({ id: s.id, version: null }));
      } catch {
        return [];
      }
    })();
    // 新建页输入框的 chips(WYSIWYG):气泡按 richText 的 {{chip:N}} 原位内联渲染,与输入框所见一致。
    const pendingRichText = sessionStorage.getItem(
      "qingagent:pending-richtext",
    );
    const pendingChips: ChatChip[] = (() => {
      try {
        const raw = sessionStorage.getItem("qingagent:pending-chips");
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
          (c): c is ChatChip =>
            Boolean(c) &&
            typeof c.label === "string" &&
            c.kind &&
            typeof c.kind.kind === "string",
        );
      } catch {
        return [];
      }
    })();

    if (
      createdInitialStream &&
      !initialSessionId &&
      (pending != null || files.length > 0 || pendingFolder !== null)
    ) {
      const messageText = pending ?? "";

      const sendPending = async () => {
        // 乐观气泡与服务端直播 user 帧共用同一 id(clientMessageId),按 id 去重合一。
        // WYSIWYG:有 chips 时气泡 body 用 richText({{chip:N}} 原位内联),与新建页输入框所见一致。
        // e2e-loop-0704 R15 回归:气泡必须在建会话/传文件 await **之前**先落地——此前放在
        // await 之后,新建页跳转后的头 1-2 秒(带附件更久)工作区完全空白、用户消息无影,
        // 自动化用例把这个空窗当成"首提丢失需重输"(服务端实锤消息其实已在跑)。
        const clientMessageId = `m-user-${Date.now()}`;
        if (messageText.length > 0 || pendingChips.length > 0) {
          const displayBody =
            pendingChips.length > 0 && pendingRichText
              ? pendingRichText
              : messageText;
          dispatch({
            kind: "chatMessageAdded",
            data: {
              message: {
                id: clientMessageId,
                role: { kind: "user" },
                ts: new Date().toISOString(),
                parts: [{ kind: "text", data: { body: displayBody } }],
                chips: pendingChips.length > 0 ? pendingChips : null,
              },
            },
          });
        }
        const sessionPromise = startNewSessionOnce(
          stream,
          sessionIdRef,
          startNewSessionPromiseRef,
          replaceWorkspaceSessionHash,
        );
        const [uploadedAssets, sessionId] = await Promise.all([
          uploadFiles(files),
          sessionPromise,
        ]);
        const fileIds = uploadedAssets.map((asset) => asset.fileId);
        markMaterialParsing(uploadedAssets);
        if (pendingFolder) {
          await sendAttachFolderSelection(
            stream,
            sessionId,
            folderAttachSelectionFromPending(pendingFolder),
            {
              awaitBrowserBridge:
                pendingFolder.provider === "browser-fs-access",
            },
          );
          if (peekPendingFolderSource() === pendingFolder)
            clearPendingFolderSource();
        }
        const command: Extract<Command, { kind: "sendMessage" }> = {
          kind: "sendMessage",
          data: {
            sessionId,
            text: messageText,
            mentions: [],
            skills: pendingSkills,
            chips: pendingChips,
            fileIds,
            clientMessageId,
            // richText({{chip:N}} 原位):服务端据此内联展开给模型 + 作气泡体(WYSIWYG)。
            ...(pendingChips.length > 0 && pendingRichText
              ? { richText: pendingRichText }
              : {}),
          },
        };
        lastRetriableSendRef.current = command;
        await stream.sendCommand(command);
        if (sessionStorage.getItem("qingagent:pending-message") === pending) {
          sessionStorage.removeItem("qingagent:pending-message");
        }
        sessionStorage.removeItem("qingagent:pending-skills");
        sessionStorage.removeItem("qingagent:pending-richtext");
        sessionStorage.removeItem("qingagent:pending-chips");
        if (peekPendingFiles() === files) clearPendingFiles();
      };

      sendPending().catch((e) => {
        console.error("[workspace] pending-message send failed", e);
        const message = e instanceof Error ? e.message : "";
        showToast(
          message.startsWith("连接文件夹失败")
            ? `${message}，请重选或重试`
            : "发送失败 · 请重试",
        );
      });
    }

    const syncHashSession = async () => {
      const nextSessionId = workspaceSessionIdFromHash(window.location.hash);
      if (
        nextSessionId === activeWorkspaceSessionTargetRef.current &&
        streamRef.current
      )
        return;
      // hash/popstate 切换不会触发组件 cleanup；先以旧 sessionId 捕获当前编辑器正文，
      // 正常 flush 超时/失败时复用退出页的 beacon/keepalive 兜底，再清旧会话队列。
      const fallbackDocSave = preparePageExitDocSaveRef.current();
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
        fallbackDocSave?.();
      }
      startWorkspaceStream(nextSessionId, { resetSessionState: true });
    };

    // hashchange:用户改地址栏 hash(含 session 参数)即重切会话。
    // popstate:浏览器前进/后退(history 导航)同样可能换到另一会话的 URL,
    // 但 pushState/replaceState 本身不触发 hashchange,只有 back/forward 才补发 popstate,
    // 故一并监听 popstate,使前进后退在两会话间切换也能正确重载(不再串台停在原会话)。
    window.addEventListener("hashchange", syncHashSession);
    window.addEventListener("popstate", syncHashSession);
    return () => {
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
            fallbackDocSave();
          } finally {
            if (timeout !== null) clearTimeout(timeout);
            streamToDispose.dispose();
            if (streamRef.current === streamToDispose) streamRef.current = null;
          }
        })();
      }, 75);
    };
  }, [
    rejectPendingDocSaveDrain,
    markMaterialParsing,
    resolvePendingDocSaveDrain,
    restoreExistingSession,
    sendAttachFolderSelection,
    showToast,
    stagePresentationRunForDocFrame,
    stagePresentationRunForViewDoc,
  ]);

  // 组件卸载时清掉在排的瞬态保存重试定时器,防孤儿定时器卸载后用旧态杂散重发。
  useEffect(() => {
    return () => {
      if (docSaveRetryTimerRef.current !== null) {
        clearTimeout(docSaveRetryTimerRef.current);
        docSaveRetryTimerRef.current = null;
      }
    };
  }, []);

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
    const sessionId = stateRef.current.sessionId;
    if (!stream || !sessionId) return;
    setDerivatives(await stream.listDerivatives(sessionId));
  }, []);

  useEffect(() => {
    if (!state.sessionId) {
      setDerivatives([]);
      setActiveTab("main");
      return;
    }
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

  // 对话工具可在弹框之外完成衍生稿重生成；活动衍生视图持续观察 generatedAt，
  // 新时间戳进入 props 后 DerivativeView 会自行重取正文，避免必须切 Tab 才看到改稿。
  useEffect(() => {
    if (activeTab === "main" || activeTab === "translate" || !state.sessionId)
      return;
    const timer = window.setInterval(
      () =>
        void refreshDerivatives().catch((error) =>
          console.error("[workspace] poll derivative generation failed", error),
        ),
      2_000,
    );
    return () => window.clearInterval(timer);
  }, [activeTab, refreshDerivatives, state.sessionId]);

  const handleCreateDerivative = useCallback(
    async (params: DerivativeGenerateParams) => {
      const stream = streamRef.current;
      const sessionId = stateRef.current.sessionId;
      if (!stream || !sessionId) {
        showToast("会话未就绪");
        return;
      }
      setDerivativeCreating(true);
      try {
        const descriptor = DTYPE_REGISTRY[derivativeCreateDtype];
        const targetLanguages =
          descriptor.dtype === "translate"
            ? (params.targetLanguages ?? [])
            : [undefined];
        if (descriptor.dtype === "translate" && targetLanguages.length === 0) {
          throw new Error("请至少选择一种目标语言");
        }
        const createdItems: DerivativeItem[] = [];
        for (const targetLang of targetLanguages) {
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
        }
        const item = createdItems[0]!;
        await refreshDerivatives();
        setDerivativeCreateOpen(false);
        setPendingDerivativeGeneration(
          descriptor.dtype === "translate" ? null : item.docId,
        );
        setActiveTab(descriptor.dtype === "translate" ? "translate" : item.docId);
        const templateName =
          descriptor.templates.find(
            (template) => template.id === params.templateId,
          )?.name ?? params.templateId;
        const lines = [{ label: "模板", value: templateName }];
        if (params.privatePrompt.trim()) {
          lines.push({ label: "补充", value: params.privatePrompt.trim() });
        }
        if (descriptor.dtype === "translate") {
          await stream.generateTranslations(
            sessionId,
            createdItems.map((created) => created.docId),
          );
        } else {
          sendDerivativeQueryRef.current(descriptor.queryText(item.docId), {
            title: descriptor.cardTitle(false),
            lines,
          });
        }
      } catch (error) {
        console.error("[workspace] create derivative failed", error);
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
    setCurrentSession(state.sessionId, title);
    if (state.sessionId) updateSessionTitle(state.sessionId, title);
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
    pendingDocWriteRef,
    queuedPmDocRef,
    scheduledDocWriteRef,
    latestDocMutationIdRef,
    lastSentPmDocRef,
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

  const handleAttachFolder = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream) {
      showToast("连接未就绪");
      return;
    }
    if (
      folderSource?.provider === "browser-fs-access" &&
      folderSource.status === "permission_required"
    ) {
      const result = await requestBrowserFolderPermission(folderSource);
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
        return;
      }
      if (!desktopSelection) return;
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
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        console.error("[workspace] showDirectoryPicker failed", error);
        showToast(
          error instanceof Error ? error.message : "选择文件夹失败，请重试",
        );
        return;
      }
    } else {
      showToast(folderCapability.reason ?? "当前浏览器不支持本地文件夹访问");
      return;
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
      return;
    }

    const selection: FolderAttachSelection = desktopSelection
      ? {
          provider: "desktop-local",
          selectionToken: desktopSelection.selectionToken,
        }
      : { provider: "browser-fs-access", picked: browserSelection! };
    try {
      await sendAttachFolderSelection(stream, sessionId, selection);
    } catch (error) {
      console.error("[workspace] attachFolder failed", error);
      showToast("连接文件夹失败，请重试");
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

  const { handleCancelActiveStream, handleSubmitChat } =
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
      dispatch,
      setPreviewSource,
      setSendPending,
      flushPendingDocSave,
      markMaterialParsing,
      ensureSessionId,
      showToast,
      toast,
      handleBackHome,
      restoreExistingSession,
    });

  const sendDerivativeQuery = useCallback(
    (
      text: string,
      displayCard: ActionCardData,
      reviewContext?: ReviewContext,
    ) => {
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return;
      }
      const clientMessageId = `m-user-${Date.now()}`;
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
      void (async () => {
        const sessionId = await ensureSessionId(stream);
        await stream.sendCommand({
          kind: "sendMessage",
          data: {
            sessionId,
            text,
            mentions: [],
            skills: [],
            chips: [],
            fileIds: [],
            clientMessageId,
            displayCard,
            ...(reviewContext ? { reviewContext } : {}),
          },
        });
      })().catch((error) => {
        console.error("[workspace] derivative query send failed", error);
        showToast("生成指令发送失败,请重试");
      });
    },
    [ensureSessionId, showToast],
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
    remainingPatches,
    reviewedCount,
    submittingAskUserId,
  } = useWorkspaceReviewActions({
    state,
    stateRef,
    streamRef,
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
      // 乐观更新:只传 summary,applyUpdate 保留既有 metadata(含 fileId)。
      resources.applyUpdate(
        { id: materialId, domain: { kind: "file" } },
        summary,
      );
      stream.sendCommand(command).catch((e) => {
        console.error("[workspace] updateMaterialSummary failed", e);
        showToast("摘要保存失败 · 请重试");
      });
      return true;
    },
    [agentActive, state.sessionId, showToast],
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
    title,
    setTitle,
    handleBackHome,
    showToast,
    exportAnchorRef,
    reviewAnchorRef,
    exportDisabledReason,
    exportMenuOpen,
    setExportMenuOpen,
    reviewMenuOpen,
    setReviewMenuOpen,
    reviewLaunchType,
    setReviewLaunchType,
    loadLexicons,
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
    handleEditSummary,
    hasModelKey,
    inlineAsk,
    handleCancelAskUser,
    handleSubmitAskUserAnswers,
    previewExit,
    docScrollRef,
    dim,
    handleFillTemplate,
    handleCreateBlankDoc,
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
