import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import {
  countDocVisibleChars,
  countVisibleChars,
  aiIrToPm,
  normalizePmDoc,
  pmToLegacySections,
  type PmDoc,
  type PmNode,
} from "@qingagent/pm-schema";
import { routeToHash } from "../../shell";
import {
  clearWorkspaceArrive,
  computeWorkspaceDocRect,
  peekWorkspaceArrive,
  setHomeArrive,
} from "../new-session/transition/origin";
import {
  chatInputBus,
  clearPendingFiles,
  clearPendingFolderSource,
  deriveFolderCapability,
  peekPendingFiles,
  peekPendingFolderSource,
  useClientCapabilities,
  useToast,
  type PendingFolderSource,
} from "../../system";
import { useConfirm } from "../../system/ConfirmProvider";
import "./workspace.css";
import "./workspace-ink-skin.css";
import { AskUserOverlay } from "./components/AskUserOverlay";
import { AssetPreview } from "./components/AssetPreview";
import { MorphDebugPanel, type DemoBarKind } from "./components/MorphDebugPanel";
import { ChatInput } from "./components/ChatInput";
import type { ChatInputHandle, ChatInputSnapshot } from "./components/ChatInput";
import { buildWholeDocReviewKey, ChatMessageList, shouldShowPreTokenLoading } from "./components/ChatMessageList";
import { ScrollToBottomButton } from "./components/ScrollToBottomButton";
import { TaskPill } from "./components/TaskPill";
import type { StarterBlankTarget } from "./components/StarterPanel";
import { buildTemplateSkeleton } from "./data/starterTemplates";
import type { StarterTemplate } from "./data/starterTemplates";
import {
  DocToolbar,
  isEditorRangeWithinSingleTextBlock,
  isEditorRangeSingleAtomBlock,
} from "./components/DocToolbar";
import { DocWordCount } from "./components/DocWordCount";
import { ContextDebugPill } from "./components/ContextDebugPill";
import type { DocumentSnapshotViewHandle } from "./components/DocumentSnapshotView";
import { ExportIcon, extractAskUser, HistoryIcon, RightPane } from "./components/RightPane";
export { RightPane } from "./components/RightPane";
import { ExportMenu } from "./components/ExportMenu";
import { RevealTuningPanel } from "./components/RevealTuningPanel";
import { HumanCursorOverlay } from "./components/HumanCursorOverlay";
import { HumanCursorTuningPanel } from "./components/HumanCursorTuningPanel";
import {
  canRetryStreamError,
  shouldStickStreamErrorToast,
  streamErrorActionLabel,
  streamErrorToastMessage,
  streamErrorToastRole,
  streamErrorToastTone,
} from "./components/streamErrorPresenter";
import { WorkspaceTooltip } from "./components/WorkspaceTooltip";
import { ServerStream } from "./data/serverStream";
import { magicMoveFromRect, magicMoveToRect, morphTuning } from "./data/barMorph";
import {
  ensureSessionIdOnce,
  replaceWorkspaceSessionHash,
  startNewSessionOnce,
} from "./data/sessionLifecycle";
import {
  ensureBrowserFolderBridge,
  forgetBrowserFolderSource,
  pickBrowserFolderSource,
  rememberAttachedBrowserFolderSource,
  requestBrowserFolderPermission,
  stopBrowserFolderBridge,
  type PickedBrowserFolderSource,
} from "./data/browserFolderBridge";
import {
  DEFAULT_CHAT_INPUT_PLACEHOLDER,
  HISTORY_CHAT_INPUT_BLOCK_REASON,
  getChatInputBlockReason,
} from "./data/chatInputBlockReason";
import {
  checkPatchPresentationConsistency,
  derivePatchPresentation,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInput,
  suggestionToBlockPatchInputs,
  suggestionToPatchOverlay,
  wireDocToView,
} from "./data/protocol";
import type {
  AppliedPatch,
  BlockPatchInput,
  PatchOverlayInput,
  ViewBlock,
  ViewBlockSeqDiff,
  ViewDocSpan,
  ViewListRowDiff,
  ViewTableRowDiff,
  ViewDocumentSnapshot,
} from "./data/protocol";
import type { AssetSource } from "./data/sources";
import type {
  AskUserAnswers,
  ToolCallSpec,
} from "./data/protocol";
import type {
  ChatChip,
  Command,
  LegacySection,
  DocumentSnapshot,
  HistorySnapshot,
  BridgeFrame,
  FolderSource,
  FolderSourceOperationResult,
  ReviewOutcome,
  ReviewOutcomeHunk,
} from "@qingagent/contract-ts";
import {
  initialWorkspaceState,
  selectOpenAskUser,
  selectPatches,
  workspaceReducer,
  type WorkspaceAction,
} from "./data/workspaceState";
import { deriveDocDimensions } from "./data/docDimensions";
import {
  buildCancelStreamCommands,
  canEditDocument,
  selectFullpageAsk,
  workspaceDataAttrs,
  workspaceHashWithViewingVersion,
  workspaceHistorySnapshotUrl,
  workspaceSessionIdFromHash,
  workspaceViewingVersionFromHash,
  workspaceViewingVersionIdFromHash,
  workspaceVisualState,
} from "./data/workspacePageView";
import {
  buildNativeDiffInstructions,
  cloneNativePresentationRun,
  planNativeTiming,
  type NativePresentationRun,
} from "./data/nativeDiffAnimation";
import { logClientEvent } from "./data/clientLog";
import {
  getRevealPresentationConfig,
  subscribeRevealPresentationConfig,
} from "./data/revealPresentationConfig";
import { deriveReviewUiState } from "./data/reviewUiState";
import {
  classifyDocSaveError,
  TRANSIENT_DOC_SAVE_TOAST,
} from "./data/docSaveError";
import {
  MATERIAL_PARSE_BUSY_REASON,
  useMaterialParseTracker,
  type UploadedAsset,
} from "./data/useMaterialParseTracker";
import { planRevealTypewriter, revealNewPartLen } from "./data/revealTypewriter";
import { validateCommand } from "../../system/validators";
import { resources, useResourceList } from "../../system/resources";
import type { ChatChipSpec } from "./components/ChatInput";
import { useAutoScroll } from "./useAutoScroll";
import { useSessionStore } from "../../stores/sessionStore";
import { uploadAssetFile } from "./data/uploadAsset";
import { useModelKeyConfigured, goConfigureModel } from "../../system/modelKeyGate";
import {
  buildPatchMeta,
  buildPatchVerdictCommand,
  buildReviewGroupCommitSelection,
  buildReviewGroupRejectSelection,
  buildReviewOutcome,
  canUseDocumentEditing,
  computeWholeDocReviewChangeRatio,
  deriveReviewRenderMode,
  reviewBatchIdFromPatch,
  sendReviewOutcomeFollowup,
  shouldCloseMaterialPreviewForReview,
  shouldDispatchManualDocSavedForWriteResult,
  shouldSuppressPresentationRun,
} from "./data/reviewActions";
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
  shouldSuppressPresentationRun,
} from "./data/reviewActions";
import {
  buildAttachFolderCommand,
  folderAttachSelectionFromPending,
  folderSourceOperationFailureToast,
  type FolderAttachSelection,
} from "./data/folderAttach";
import {
  PendingDocSaveError,
  docSaveFailureToastMessage,
  docWriteResultMessage,
  reviewCommitFramesLeavePendingReview,
  runAfterPendingDocSave,
  type PendingDocSaveWaiter,
} from "./data/pendingDocSave";
export {
  PendingDocSaveError,
  docSaveFailureToastMessage,
  reviewCommitFramesLeavePendingReview,
  runAfterPendingDocSave,
} from "./data/pendingDocSave";
import {
  clientPerformanceNow,
  presentationRunWatchdogMs,
  restoreExistingSessionWithRetry,
  rollbackOptimisticChatSend,
  shouldAcceptBridgeFrameForSession,
  submitImmediateChatInputSend,
  toContractChip,
  uploadFiles,
} from "./data/sessionFrameGuards";
export {
  bridgeFrameSessionId,
  isRetriableSessionRestoreError,
  restoreExistingSessionWithRetry,
  rollbackOptimisticChatSend,
  sendFailureToastMessage,
  shouldAcceptBridgeFrameForSession,
  submitImmediateChatInputSend,
} from "./data/sessionFrameGuards";
import {
  createClientMutationId,
  flushDocSaveOnPageExit,
  pageExitDocSaveFingerprint,
  pmDocHasSubstantiveContent,
} from "./data/pageExitSave";
export {
  buildPageExitDocSaveCommand,
  flushDocSaveOnPageExit,
  pageExitDocSaveFingerprint,
  shouldFlushDocSaveOnPageExit,
} from "./data/pageExitSave";
import { cloneViewSections } from "./data/cloneViewDoc";

// 历史版本入口特性开关:后端(版本快照/操作流水/读取 API)已就绪,前端列表/查看 UI 尚未迭代,
// 暂时隐藏文档纸右上角的"历史"按钮(及其"即将上线"toast)。功能做完翻为 true 即可恢复入口。
const HISTORY_ENTRY_ENABLED = false;
const STREAM_ERROR_TOAST_KEY = "workspace-stream-error";

function buildBlankStarterDoc(): PmDoc {
  return aiIrToPm({
    title: null,
    blocks: [
      { type: "paragraph", runs: [] },
    ],
  });
}

function focusStarterBlankTarget(editor: Editor, target: StarterBlankTarget): boolean {
  if (editor.isDestroyed) return false;
  const targetNode = ({ body: "paragraph" } satisfies Record<StarterBlankTarget, "paragraph">)[target];
  let focusPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== targetNode) return true;
    focusPos = pos + 1;
    return false;
  });
  if (focusPos === null) return false;
  const maxPos = Math.max(1, editor.state.doc.content.size);
  editor.chain().focus(Math.min(focusPos, maxPos)).run();
  return true;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setReducedMotion(query.matches);
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}

/** Human-readable label maps for BigPlan answer values. */
const GENRE_LABELS: Record<string, string> = {
  prd: "PRD",
  weekly: "周报",
  essay: "公众号文章",
  academic: "学术/创作",
};
const LENGTH_LABELS: Record<string, string> = {
  short: "精简版",
  medium: "标准版",
  long: "详细版",
};
const FOCUS_LABELS: Record<string, string> = {
  product: "产品进展",
  growth: "用户增长",
  ops: "运营效率",
  tech: "技术架构",
};

export async function sendMaterialParseCommandWithStream(
  stream: Pick<ServerStream, "sendCommand"> | null,
  command: Command,
): Promise<unknown> {
  if (!stream) throw new Error("连接未就绪");
  return stream.sendCommand(command);
}

export function WorkspacePage() {
  // 初始化不带标题(空),真实会话标题加载后再 setTitle 覆盖。
  const [title, setTitle] = useState("");
  // 调试调参面板(入场/鼠标/动效)默认隐藏,Ctrl+Shift+H 唤起/收起。
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  // 调试:演示「输入框 ⇄ 操作条」几何形变(Magic Move)。选条类型(问卷/审批),
  // 三段式:输入框内容先淡出 → 金边空框几何形变到条 → 条内容淡入。
  const [demoBarKind, setDemoBarKind] = useState<DemoBarKind>("bigplan");
  const [demoBarShown, setDemoBarShown] = useState(false);
  // 进场第一段:输入框「框内元素」先淡出(只剩金边空框)再开始形变
  const [inputContentOut, setInputContentOut] = useState(false);
  // 「debug 模式」(持久化):默认关。关时思考只在进行中显示滚动文案条、完成即从对话流隐去、不可展开;
  // 开时思考条常驻、点击可展开全文(=旧行为)。Ctrl+Shift+D 切换。
  const [debugMode, setDebugMode] = useState(() => {
    try {
      return localStorage.getItem("qingagent:debug-mode") === "1";
    } catch {
      return false;
    }
  });
  const [previewSource, setPreviewSource] = useState<AssetSource | null>(null);
  // 预览出场:previewSource 清空后,先保留挂载 + closing=true 播出场动画,200ms 后再真正卸载。
  const [previewExit, setPreviewExit] = useState<{ source: AssetSource | null; closing: boolean }>({
    source: null,
    closing: false,
  });
  useEffect(() => {
    if (previewSource) {
      setPreviewExit({ source: previewSource, closing: false });
      return;
    }
    setPreviewExit((cur) => (cur.source ? { source: cur.source, closing: true } : cur));
    const t = setTimeout(() => setPreviewExit({ source: null, closing: false }), 200);
    return () => clearTimeout(t);
  }, [previewSource]);
  const [goalLabel, setGoalLabel] = useState<string | null>(null);
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [submittingAskUserId, setSubmittingAskUserId] = useState<string | null>(null);
  const [presentationRun, setPresentationRun] = useState<NativePresentationRun | null>(null);
  const presentationRunRef = useRef<NativePresentationRun | null>(null);
  const [hasReplayablePresentation, setHasReplayablePresentation] = useState(false);
  // 乐观"请求在途"标记:用户点发送的那一刻即置真,补上"气泡已发出、但流还没激活"的空窗
  // (此前那段没有任何 loading,容易被误以为断网)。真实 streamActive/agentBusy 一到就交棒、撤掉。
  const [sendPending, setSendPending] = useState(false);
  const [externalToolConnected, setExternalToolConnected] = useState(false);
  const [externalPatchCount, setExternalPatchCount] = useState(0);
  const pendingExternalReviewRef = useRef(false);
  const [browserFolderOverrides, setBrowserFolderOverrides] = useState<Record<string, {
    status: FolderSource["status"];
    error: string | null;
  }>>({});
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
  const homeReturnTransitionRef = useRef(false);
  const homeReturnTimerRef = useRef<number | null>(null);
  // 整篇审(大改)新旧版切换态 + 新旧各自滚动位置记忆
  const [wholeDocVersion, setWholeDocVersion] = useState<"new" | "old">("new");
  const wholeDocScrollMem = useRef<{ new: number; old: number }>({ new: 0, old: 0 });
  const exportAnchorRef = useRef<HTMLDivElement>(null);
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
  const startNewSessionPromiseRef = useRef<Promise<string> | null>(null);
  const startSessionPromisesBySessionRef = useRef<Map<string, Promise<string>>>(new Map());
  const restoreExistingSessionIdRef = useRef<string | null>(null);
  const lastRetriableSendRef = useRef<Extract<Command, { kind: "sendMessage" }> | null>(null);
  const reviewCloseInFlightRef = useRef<Promise<void> | null>(null);
  const pendingBrowserAttachRef = useRef<{
    sessionId: string;
    picked: PickedBrowserFolderSource;
  } | null>(null);
  const activeBrowserFolderKeysRef = useRef<Map<string, { sessionId: string; folderId: string }>>(new Map());
  const docVersionRef = useRef(state.version);
  const pendingDocWriteRef = useRef(false);
  const queuedPmDocRef = useRef<PmDoc | null>(null);
  const scheduledDocWriteRef = useRef(false);
  const latestDocMutationIdRef = useRef<string | null>(null);
  const docWriteAckRef = useRef<Map<string, PendingDocSaveWaiter>>(new Map());
  const docSaveDrainWaitersRef = useRef<PendingDocSaveWaiter[]>([]);
  const pendingBlankFocusRef = useRef<StarterBlankTarget | null>(null);
  // 模板填充在途 promise:单飞去重(review #2)+ 发送消息前等它落定,避免 sendMessage 与骨架
  // updateDoc 竞发(sendMessage 先被处理会置 streamId,后到的骨架写被拒、模板永久丢失,review #6)。
  const fillTemplatePromiseRef = useRef<Promise<void> | null>(null);
  // 瞬态保存重试的退避定时器:存起来,组件卸载/切会话时清掉,杜绝孤儿定时器用旧态杂散重发。
  const docSaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foregroundDocSaveDepthRef = useRef(0);
  const pageExitDocSaveFingerprintRef = useRef<string | null>(null);
  // 诊断 p01:记住最近一次发出的手动保存文档,保存成功后同步进 state.doc。
  const lastSentPmDocRef = useRef<PmDoc | null>(null);
  const presentationRunSeqRef = useRef(0);
  const sawDraftingRef = useRef(false);
  const presentedDocumentSnapshotRef = useRef<number | null>(null);
  const sendDocWriteRef = useRef<(doc: PmDoc) => Promise<void>>(() => Promise.resolve());
  const reducedMotionRef = useRef(false);
  stateRef.current = state;
  sessionIdRef.current = state.sessionId ?? sessionIdRef.current;
  docVersionRef.current = state.version;
  presentationRunRef.current = presentationRun;
  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null);
  tiptapEditorRef.current = tiptapEditor;
  const toast = useToast();
  const confirm = useConfirm();
  const showToast = useCallback(
    (msg: string, durationMs?: number) => toast.show(msg, durationMs),
    [toast],
  );
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
          if (frame.kind !== "folderSourceOperationResult" || frame.data.op !== "attach") return;
          unsubscribe?.();
          unsubscribe = null;
          const result = frame.data;
          if (!result.ok) {
            reject(new Error(folderSourceOperationFailureToast(result)));
            return;
          }
          if (selection.provider !== "browser-fs-access" || !options.awaitBrowserBridge) {
            resolve();
            return;
          }
          void rememberAttachedBrowserFolderSource({
            sessionId,
            folderId: result.folderId,
            picked: selection.picked,
          }).then(() => {
            activeBrowserFolderKeysRef.current.set(
              `${sessionId}\0${result.folderId}`,
              { sessionId, folderId: result.folderId },
            );
            resolve();
          }).catch((error) => {
            console.error("[workspace] browser folder bridge start failed", error);
            reject(new Error("连接文件夹失败：浏览器桥接未就绪，请刷新或重试"));
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
      const attachResult = createAttachFolderResultWaiter(stream, sessionId, selection, options);
      let usedGlobalPending = false;
      if (selection.provider === "browser-fs-access") {
        if (!options.awaitBrowserBridge) {
          pendingBrowserAttachRef.current = { sessionId, picked: selection.picked };
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

  // 把奶白文档纸的左边 / 右边 viewport 坐标写成 CSS 变量,供 doc-topbar / patch-nav /
  // editor glow 等 fixed 层精准跟随。优先实测 .ws-right,这样窄屏横向滚动时也会同步;
  // 首帧或 jsdom 无布局时再回退 computeWorkspaceDocRect(= 新建页翻转落点几何)。
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const apply = () => {
      const measured = docScrollRef.current?.getBoundingClientRect();
      const r =
        measured && measured.width > 0
          ? { left: measured.left, right: measured.right }
          : (() => {
              const fallback = computeWorkspaceDocRect();
              return { left: fallback.left, right: fallback.left + fallback.width };
            })();
      el.style.setProperty("--doc-left", `${r.left}px`);
      el.style.setProperty("--doc-right", `${r.right}px`);
      // 同步到 :root:「请等待完成编辑」提示条 portal 到 document.body(#25),不在 #view-workspace
      // 子树里,读不到写在 #view-workspace 上的 --doc-left/--doc-right → 会 fallback 到 50vw 全屏居中。
      // 写一份到 documentElement,让 body 层 portal 也能按文稿真实左右边居中。
      document.documentElement.style.setProperty("--doc-left", `${r.left}px`);
      document.documentElement.style.setProperty("--doc-right", `${r.right}px`);
    };
    const body = el.querySelector<HTMLElement>(".ws-body");
    apply();
    window.addEventListener("resize", apply);
    body?.addEventListener("scroll", apply, { passive: true });
    return () => {
      window.removeEventListener("resize", apply);
      body?.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--doc-left");
      document.documentElement.style.removeProperty("--doc-right");
    };
  }, []);

  // 悬浮输入框会盖住对话内容 → 测它的实际高度写入 --ws-input-h,给对话滚动区留等高底部空白
  // (自适应禁用态/多行,内容永远能完整滚到输入框上方)。
  useEffect(() => {
    const el = viewRef.current;
    const left = el?.querySelector<HTMLElement>(".ws-left");
    const wrap = el?.querySelector<HTMLElement>(".ws-input-wrap");
    if (!left || !wrap) return;
    const apply = () => left.style.setProperty("--ws-input-h", `${wrap.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // 工作区满铺(去掉外层页框 .web-page-frame 的 1440 居中 + 浅色底,让玄青桌面铺满整屏)已上移到
  // App.tsx:按路由同步拼 web-page-frame--workspace,首帧 paint 前生效——避免此前用 paint 后的
  // useEffect 加类,导致首页深色到达帧切来后先闪一帧浅色窄框。

  useLayoutEffect(() => {
    const arrive = peekWorkspaceArrive();
    if (!arrive) return;
    const view = viewRef.current;
    if (!view) return;
    view.classList.add("ws-arriving");

    let rafA = 0;
    let rafB = 0;
    let timer = 0;
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        clearWorkspaceArrive();
        view.classList.remove("ws-arriving");
        view.classList.add("ws-arrive-revealing");
        timer = window.setTimeout(() => {
          view.classList.remove("ws-arrive-revealing");
        }, 760);
      });
    });

    return () => {
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      if (timer) window.clearTimeout(timer);
      view.classList.remove("ws-arriving", "ws-arrive-revealing");
    };
  }, []);

  // 滚动条自动隐:滚动时给容器挂 show-sb 显出细条,停滚 ~800ms 后摘掉淡出。
  // 正文区(docScroll)额外:上滚超 40px 时给 #view-workspace 挂 ws-doc-scrolled,让右上角图标切深色。
  useEffect(() => {
    const doc = docScrollRef.current;
    const chat = chatScrollRef.current;
    const view = viewRef.current;
    const timers = new WeakMap<HTMLElement, number>();
    const bind = (el: HTMLElement | null, onDoc = false) => {
      if (!el) return () => {};
      const onScroll = () => {
        el.classList.add("show-sb");
        const prev = timers.get(el);
        if (prev) window.clearTimeout(prev);
        timers.set(el, window.setTimeout(() => el.classList.remove("show-sb"), 800));
        if (onDoc && view) view.classList.toggle("ws-doc-scrolled", el.scrollTop > 40);
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => el.removeEventListener("scroll", onScroll);
    };
    const unDoc = bind(doc, true);
    const unChat = bind(chat);
    return () => {
      unDoc();
      unChat();
    };
  }, []);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSessionTitle = useSessionStore((s) => s.updateSessionTitle);
  const reducedMotion = usePrefersReducedMotion();
  reducedMotionRef.current = reducedMotion;

  useAutoScroll(chatScrollRef);

  const hasModelKey = useModelKeyConfigured();

  const handleBackHome = useCallback(() => {
    if (homeReturnTransitionRef.current) return;
    const sessionId = state.sessionId ?? workspaceSessionIdFromHash(window.location.hash);
    const goHome = () => {
      window.location.hash = routeToHash("home");
    };
    if (!sessionId) {
      goHome();
      return;
    }

    homeReturnTransitionRef.current = true;
    const view = viewRef.current;
    const rect = computeWorkspaceDocRect();
    view?.classList.add("ws-returning");

    const handoff = () => {
      setHomeArrive({
        rect,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        source: "workspace",
        sessionId,
      });
      goHome();
    };

    if (reducedMotion) {
      handoff();
      return;
    }
    homeReturnTimerRef.current = window.setTimeout(handoff, 260);
  }, [reducedMotion, state.sessionId]);

  useEffect(() => {
    return () => {
      if (homeReturnTimerRef.current !== null) {
        window.clearTimeout(homeReturnTimerRef.current);
      }
    };
  }, []);

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
        showToast(error instanceof Error && error.message ? error.message : "重试解析失败，请稍后再试");
      });
    },
    [agentActive, retryMaterialParse, showToast],
  );
  const folderSource = useMemo(() => {
    const source = state.folderSources[0] ?? null;
    if (!source || source.provider !== "browser-fs-access") return source;
    const override = browserFolderOverrides[source.id];
    return override ? { ...source, status: override.status, error: override.error } : source;
  }, [browserFolderOverrides, state.folderSources]);
  const clientCapabilities = useClientCapabilities();
  const folderCapability = deriveFolderCapability(clientCapabilities);
  useEffect(() => {
    const browserSources = state.folderSources.filter((source) => source.provider === "browser-fs-access");
    const currentKeys = new Set(browserSources.map((source) => `${source.sessionId}\0${source.id}`));
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
          activeBrowserFolderKeysRef.current.set(key, { sessionId: source.sessionId, folderId: source.id });
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
            status: result.status === "missing" ? "permission_required" : result.status,
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
        const overlay = suggestionToPatchOverlay(state.doc, tc.body.data.data, order);
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
  // 诊断 p03 计数诚实:连输入都没进的 suggestion(此前被静默丢弃)也计入不可视。
  const unpresentedPatchCount = useMemo(() => {
    const presented = new Set<string>([
      ...overlayInputs.map((o) => o.id),
      ...blockPatchInputs.map((b) => b.patchId),
    ]);
    let missing = 0;
    for (const tc of allReviewPatches) {
      if (tc.body.kind !== "docSuggestion" || tc.body.data.kind !== "suggestion") continue;
      const s = tc.status.kind;
      if (s !== "reviewing" && s !== "accepted" && s !== "rejected") continue;
      if (!presented.has(tc.body.data.data.id)) missing += 1;
    }
    return missing;
  }, [allReviewPatches, overlayInputs, blockPatchInputs]);
  // 数数单一真相源:计数 / 序号 / 正文标记 / 打字调度都从这里派生,天然一致。
  const patchPresentation = useMemo(
    () =>
      state.doc
        ? derivePatchPresentation(state.doc, overlayInputs, blockPatchInputs)
        : null,
    [state.doc, overlayInputs, blockPatchInputs],
  );
  const docWithPatches = patchPresentation?.doc ?? state.doc;
  // 修改处数按「正文实际渲染的绿色 diff 段数」算 = 真正落地的 patch 数(applied)。
  // 一个 editDraft 若产出多段不连续的 diff(如替换文本里多了几处空格 →
  // buildDraftDiff 切成多个 hunk),正文里有几段绿,就显示几处。
  // 注:同一 patchId 的 delete+insert 对(块级替换)在 applied 里已按 patchId 去重为 1 条,
  // 红+绿对照只算 1 处,不会被重复计数。
  const presentationCount = patchPresentation?.applied.length ?? 0;
  const visibleReviewPatchIds = useMemo(
    () =>
      (patchPresentation?.applied ?? [])
        .map((patch) => patch.id)
        .filter((id): id is string => Boolean(id) && pendingReviewPatchIdSet.has(id)),
    [patchPresentation, pendingReviewPatchIdSet],
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
  // 自检:内部不一致(序号/计数/标记不自洽)=数数逻辑 bug → 报错;
  // dropped(锚点失败、正文少几处)=完整性缺口 → 警告。"一旦数量不对,自己立刻知道"。
  useEffect(() => {
    if (!patchPresentation || !import.meta.env?.DEV) return;
    const violations = checkPatchPresentationConsistency(patchPresentation);
    if (violations.length > 0) {
      console.error("[patch] 计数/序号内部不一致(数数逻辑 bug):", violations);
    }
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
    () => allReviewPatches.map((p) => p.id).slice().sort().join(","),
    [allReviewPatches],
  );
  const [activePatchId, setActivePatchId] = useState<string | null>(null);
  const previousVisibleReviewPatchIdsRef = useRef<string[]>([]);
  const autoCommitReviewKeyRef = useRef<string | null>(null);

  // 改动B:审批入口"标记逐处入场"——review 态进入时，patch 标记按时序逐个点亮，
  // 终点 = 全部点亮 = 现状静态审批态(零跳变；doc 始终是 baseline+overlay，canonical 零改动)。
  // null = 不约束(非审批/恢复态全显示)。reducedMotion → 一次性全入场。
  // 改动B 入场动效可调参数(并发数/间隔/末尾停留/发光),由 RevealTuningPanel 调,localStorage 持久化。
  const [revealConfig, setRevealConfig] = useState(() => getRevealPresentationConfig());
  useEffect(() => subscribeRevealPresentationConfig(setRevealConfig), []);

  // Ctrl+Shift+H 唤起/收起调试调参面板(入场/鼠标/动效);默认隐藏。
  // (不用 Ctrl+Shift+T —— 与浏览器"重开关闭的标签页"冲突。)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "H" || e.key === "h")) {
        // 编辑器/输入框聚焦时让位:Mod+Shift+H 在编辑器内是 TipTap 高亮(F2 快捷键表),
        // 不能既高亮又弹调参面板。
        const target = e.target as HTMLElement | null;
        if (e.defaultPrevented || target?.closest?.(".wf-doc, [contenteditable], input, textarea")) {
          return;
        }
        e.preventDefault();
        setDevToolsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 收起调参面板时,顺手收回演示条 + 复位输入框内容。
  useEffect(() => {
    if (!devToolsOpen) {
      setDemoBarShown(false);
      setInputContentOut(false);
    }
  }, [devToolsOpen]);

  // 三段式进场:段1 输入框内容淡出 → 段2(延时,等淡出稳定)显示条、effect 做几何形变
  //   → 段3 条内容淡入(由 CSS --morph-dur 在形变到位后触发)。
  const MORPH_FADE_MS = 180;
  const morphEnterFresh = useCallback(() => {
    setInputContentOut(true);
    window.setTimeout(() => setDemoBarShown(true), MORPH_FADE_MS);
  }, []);
  // 返回:卸载演示条 → 由上面的 effect 用「幽灵空框」把它几何形变滑回输入框(与真实流程点确认完全一致)。
  const handleMorphReturn = useCallback(() => {
    setDemoBarShown(false);
    setInputContentOut(false);
  }, []);
  // 进场按钮:没在场→直接进场;已在场→先返回再进场(完整重播)。
  const handleMorphEnter = useCallback(() => {
    if (!demoBarShown) {
      morphEnterFresh();
      return;
    }
    handleMorphReturn();
    window.setTimeout(morphEnterFresh, morphTuning.durationMs + MORPH_FADE_MS + 140);
  }, [demoBarShown, handleMorphReturn, morphEnterFresh]);
  // 切条类型:在场时先返回再用新类型进场。
  const handleMorphKind = useCallback(
    (k: DemoBarKind) => {
      setDemoBarKind(k);
      if (demoBarShown) {
        handleMorphReturn();
        window.setTimeout(morphEnterFresh, morphTuning.durationMs + MORPH_FADE_MS + 140);
      }
    },
    [demoBarShown, handleMorphReturn, morphEnterFresh],
  );

  // Ctrl+Shift+D 切换「debug 模式」(持久化 + body[data-debug] 供 CSS);编辑器聚焦时让位。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        const target = e.target as HTMLElement | null;
        if (e.defaultPrevented || target?.closest?.(".wf-doc, [contenteditable], input, textarea")) {
          return;
        }
        e.preventDefault();
        setDebugMode((v) => {
          const next = !v;
          try {
            localStorage.setItem("qingagent:debug-mode", next ? "1" : "0");
          } catch {
            /* ignore */
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    document.body.dataset.debug = debugMode ? "1" : "0";
  }, [debugMode]);
  const {
    concurrency: cfgConcurrency,
    stepDelayMs: cfgStepDelayMs,
    charsPerTick: cfgCharsPerTick,
    tailHoldMs: cfgTailHoldMs,
  } = revealConfig;
  // 重播 nonce:递增即重跑下方 reveal 调度(供面板"重播入场")。
  const [revealReplayNonce, setRevealReplayNonce] = useState(0);
  const handleRevealReplay = useCallback(() => {
    setRevealReplayNonce((n) => n + 1);
  }, []);

  const [revealedPatchIds, setRevealedPatchIds] = useState<ReadonlySet<string> | null>(null);
  // 改动B 微调(逐字打字版):
  // - revealedPatchIds:已"开始入场"(mount 标记)的处;null = 不约束(非审批/恢复态全显示)。
  // - typedByPatch:每处新增文案已"打"出的字符数(SpanView 据此截断 newPart);null = 全显示。
  // - revealCursors:当前正在打字的那几处(打字头位置,可并发)→ 通道号 lane。现仅用于给 RevealCursor
  //   打 data-hc-lane 锚点(供拟人鼠标 HumanCursorOverlay 定位);Agent·N 名字已迁移到鼠标承载,光标不带文字。
  // - patchRevealing:整个打字过程布尔(隐藏顶部审批条 / 左侧 loading / 右栏发光)。
  const [typedByPatch, setTypedByPatch] = useState<ReadonlyMap<string, number> | null>(null);
  const [revealCursors, setRevealCursors] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [patchRevealing, setPatchRevealing] = useState(false);
  const hasPatchCalls = allReviewPatches.length > 0;
  // 顶部审批条显示"剩余待处理"处数；正文 diff 仍由 presentationCount 保持全量事实口径。
  const visiblePatchCount = visibleReviewPatchIds.length;
  const reviewUiState = deriveReviewUiState({
    content: dim.content,
    overlay: dim.overlay,
    hasPatchCalls,
    visiblePatchCount,
    patchRevealing,
    presentationCount,
  });
  const effectiveReview = reviewUiState.effectiveReview;
  const showForceUnlock = reviewUiState.showForceUnlock;
  // 整篇审触发:审阅中 + 拿到干净新文档 + 改动幅度 ≥ 70% → 走新旧版整篇审
  const WHOLE_DOC_REVIEW_THRESHOLD = 0.7;
  const reviewRenderMode = deriveReviewRenderMode({
    effectiveReview,
    editedNewDoc,
    changeRatio,
    wholeDocReviewThreshold: WHOLE_DOC_REVIEW_THRESHOLD,
  });
  const wholeDocReview = reviewRenderMode.wholeDocReview;
  const awaitingWholeDocReviewMaterial = reviewRenderMode.awaitingWholeDocReviewMaterial;
  const inlinePatchReview = reviewRenderMode.inlinePatchReview;
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
    if (!shouldCloseMaterialPreviewForReview({
      contentKind: dim.content.kind,
      wholeDocReview,
    })) return;
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
    (patchPresentation?.conflictIds.length ?? 0) +
    unpresentedPatchCount;
  const effectivePatchRevealing = inlinePatchReview && patchRevealing;
  const editLockHint =
    dataAttrs.tool === "agentBusy" ||
    dataAttrs.tool === "imageProgress" ||
    effectivePatchRevealing
      ? "请等待青简完成编辑后再做修改"
      : dim.content.kind === "pendingReview"
        ? "请先确认或放弃当前修改候选"
        : null;
  const editLockPortalTarget = typeof document !== "undefined" ? document.body : null;

  // 出 diff 后(逐字揭示动画结束、审阅条就绪)自动定位并滚到第 1 处 diff:
  // 揭示动画通常把视口带到最后一处,这里把焦点拉回 #1,方便用户从头审。每组 patch 只做一次。
  const autoScrolledReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (effectivePatchRevealing) return; // 等揭示动画收尾
    const ids = visibleReviewPatchIds;
    if (!inlinePatchReview || ids.length === 0) {
      autoScrolledReviewKeyRef.current = null;
      return;
    }
    const key = ids.join(",");
    if (autoScrolledReviewKeyRef.current === key) return;
    autoScrolledReviewKeyRef.current = key;
    const firstId = ids[0]!;
    setActivePatchId(firstId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-patch-id="${firstId}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [effectivePatchRevealing, visibleReviewPatchIds, inlinePatchReview]);

  useEffect(() => {
    const previousIds = previousVisibleReviewPatchIdsRef.current;
    previousVisibleReviewPatchIdsRef.current = visibleReviewPatchIds;
    if (!inlinePatchReview || visibleReviewPatchIds.length === 0) {
      if (activePatchId !== null) setActivePatchId(null);
      return;
    }
    if (activePatchId && visibleReviewPatchIds.includes(activePatchId)) return;
    const previousIndex = activePatchId ? previousIds.indexOf(activePatchId) : -1;
    const nextPatchId = previousIndex >= 0
      ? visibleReviewPatchIds[Math.min(previousIndex, visibleReviewPatchIds.length - 1)]
      : visibleReviewPatchIds[0];
    setActivePatchId(nextPatchId ?? null);
  }, [activePatchId, inlinePatchReview, visibleReviewPatchIds]);

  // 输入框是否已「交接」给右侧条而隐藏 —— 由下面 effect 实测条真在 DOM 才置真,
  // 避免"信号说有条但条没渲染"时把输入框误藏成凭空消失。
  const [inputHandedOff, setInputHandedOff] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // FLIP 编排:以「接管输入框的条/卡是否真在 DOM」为唯一信号(绕开 askUser pending/running/done 等状态时序),
  // 每次提交后检查;只在条出现/消失的瞬间动手(平时只一次 querySelector,零布局成本)。
  // 条/卡出现:从输入框「框体」矩形几何形变到自身自然落点(box 全程可见,内容到位再由 CSS 浮现),
  // 输入框隐藏被接管;条/卡消失:幽灵框从最后位置形变滑回输入框。纯视觉,不动任何逻辑。
  useLayoutEffect(() => {
    const input = inputMorphRef.current;
    const view = viewRef.current;
    if (!input || !view) return;
    const bar = view.querySelector<HTMLElement>(".ws-float-bar, .patch-nav, .askuser-overlay");
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
            if (morphTokenRef.current === morphToken && prevBarPresentRef.current === false) {
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
  const effectivePresentationRun = suppressPresentationRun ? null : presentationRun;
  // 打字只覆盖"真正落地"的 patch(applied),与正文可见处、计数严格一致。
  const appliedIdsKey = useMemo(
    () => (patchPresentation?.applied ?? []).map((a) => a.id).join(","),
    [patchPresentation],
  );
  // 在 effect 内读最新 patchMeta 算每处目标字数,但不让 meta 引用进 effect 依赖
  // (meta 与 appliedIdsKey 同源,key 变时 meta 也新)。
  const patchMetaRef = useRef(patchMeta);
  patchMetaRef.current = patchMeta;
  useEffect(() => {
    if (!inlinePatchReview || appliedIdsKey === "") {
      setRevealedPatchIds(null);
      setTypedByPatch(null);
      setRevealCursors(new Map());
      setPatchRevealing(false);
      return;
    }
    const ids = appliedIdsKey.split(",");
    if (reducedMotion) {
      setRevealedPatchIds(new Set(ids));
      setTypedByPatch(null); // 降级:不逐字,全显示
      setRevealCursors(new Map());
      setPatchRevealing(false);
      return;
    }
    const stepDelayMs = Math.max(20, cfgStepDelayMs);
    const tailHoldMs = Math.max(0, cfgTailHoldMs);

    // 每处新增文案的目标字数(纯删除/无新增处为 0,不占打字头、瞬时入场)。
    const meta = patchMetaRef.current;
    const targetOf = (id: string): number => {
      const m = meta.get(id);
      return m ? revealNewPartLen(m.before, m.after) : 0;
    };

    const frames = planRevealTypewriter(ids, targetOf, cfgConcurrency, cfgCharsPerTick);

    const applyFrame = (f: (typeof frames)[number]) => {
      setRevealedPatchIds(new Set(f.revealed));
      setTypedByPatch(new Map(f.typed));
      setRevealCursors(new Map(f.cursors.map((c) => [c.id, c.lane])));
    };

    setPatchRevealing(true);
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      // 末批光标停留片刻收尾,再升起审批条(此时帧已无光标)
      endTimer = setTimeout(() => {
        setRevealCursors(new Map());
        setPatchRevealing(false);
      }, tailHoldMs);
    };

    applyFrame(frames[0]!); // 首帧:光标就位(typed=0),随后逐字冒出
    if (frames.length <= 1) {
      finish();
      return () => {
        if (endTimer) clearTimeout(endTimer);
      };
    }

    let i = 1;
    const timer = setInterval(() => {
      applyFrame(frames[i]!);
      i += 1;
      if (i >= frames.length) {
        clearInterval(timer);
        finish();
      }
    }, stepDelayMs);

    return () => {
      clearInterval(timer);
      if (endTimer) clearTimeout(endTimer);
    };
    // 仅"调度参数"(并发/节拍/每拍字数/末尾停留)纳入依赖→拖动滑块即实时重播预览;
    // glow 不入依赖,避免切换发光开关把正在进行的打字动画重置(发光由下方独立 effect 处理)。
  }, [
    inlinePatchReview,
    appliedIdsKey,
    reducedMotion,
    cfgConcurrency,
    cfgStepDelayMs,
    cfgCharsPerTick,
    cfgTailHoldMs,
    revealReplayNonce,
  ]);

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
        allReviewPatches.filter((p) => p.status.kind === "rejected").map((p) => p.id),
      ),
    [allReviewPatches],
  );

  const stagePresentationRunForViewDoc = useCallback((finalDoc: ViewDocumentSnapshot) => {
    const current = stateRef.current;
    const alreadyPresented = presentedDocumentSnapshotRef.current === finalDoc.version;
    const currentDim = deriveDocDimensions(current);

    if (alreadyPresented) return;
    presentedDocumentSnapshotRef.current = finalDoc.version;

    if (shouldSuppressPresentationRun({
      hasDocDiff: current.docDiff !== null,
      contentKind: currentDim.content.kind,
    })) {
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
  }, []);

  const stagePresentationRunForDocFrame = useCallback((wireDoc: DocumentSnapshot) => {
    stagePresentationRunForViewDoc(wireDocToView(wireDoc));
  }, [stagePresentationRunForViewDoc]);

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
      if (reducedMotion) return null;
      if (run.docVersion !== state.doc?.version) return null;
      if (
        dim.editor !== "editable" &&
        !dim.agentBusy &&
        !state.streamActive &&
        dim.content.kind !== "pendingReview"
      ) {
        return null;
      }
      if (run.sessionId !== state.sessionId) return null;
      return run;
    });
  }, [dim, reducedMotion, state.doc?.version, state.sessionId, state.streamActive]);

  // Create the server stream once. We use a ref-based approach so
  // StrictMode's cleanup/re-mount cycle does NOT dispose the stream
  // while an in-flight SSE request is still active.
  useEffect(() => {
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
      if (frame.kind === "chatMessageAdded" && frame.data.message.id.startsWith("external-")) {
        pendingExternalReviewRef.current = true;
        setExternalToolConnected(true);
      }
      if (frame.kind === "docDiffReady" && pendingExternalReviewRef.current) {
        pendingExternalReviewRef.current = false;
        setExternalPatchCount(frame.data.suggestions.length);
      }
      if (frame.kind === "documentSnapshotWritten") {
        stagePresentationRunForDocFrame(frame.data.doc);
      }
      if (
        frame.kind === "docGenerationEvent" &&
        frame.data.kind === "generation_finished"
      ) {
        stagePresentationRunForViewDoc(
          pmDocToViewDocumentSnapshot(frame.data.data.doc, frame.data.data.finalVersion),
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
            void forgetBrowserFolderSource(sessionId, result.folderId).catch((error) => {
              console.warn("[workspace] browser folder bridge cleanup failed", error);
            });
          }
        } else if (pendingBrowserAttachRef.current) {
          const pending = pendingBrowserAttachRef.current;
          pendingBrowserAttachRef.current = null;
          void rememberAttachedBrowserFolderSource({
            sessionId: pending.sessionId,
            folderId: result.folderId,
            picked: pending.picked,
          }).then(() => {
            activeBrowserFolderKeysRef.current.set(
              `${pending.sessionId}\0${result.folderId}`,
              { sessionId: pending.sessionId, folderId: result.folderId },
            );
          }).catch((error) => {
            console.error("[workspace] browser folder bridge start failed", error);
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
        if (
          frame.data.ok &&
          savedPmDoc &&
          shouldDispatchManualDocSaved
        ) {
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
            ack.reject(new PendingDocSaveError(docWriteResultMessage(frame.data), frame.data));
          }
        }
        if (isLatestOwnMutation && frame.data.ok && queuedPmDocRef.current) {
          const queued = queuedPmDocRef.current;
          queuedPmDocRef.current = null;
          scheduledDocWriteRef.current = true;
          window.setTimeout(() => {
            scheduledDocWriteRef.current = false;
            sendDocWriteRef.current(queued).catch((error) => {
              console.error("[workspace] queued updateDoc failed", error);
            });
          }, 0);
        } else if (isLatestOwnMutation && frame.data.ok) {
          resolvePendingDocSaveDrain();
        } else if (isLatestOwnMutation && !frame.data.ok) {
          rejectPendingDocSaveDrain(
            new PendingDocSaveError(docWriteResultMessage(frame.data), frame.data),
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
    const stream = streamRef.current ?? startWorkspaceStream(initialSessionId, {
      resetSessionState: false,
    });

    // Check for pending text/files from NewSessionPage
    const pending = sessionStorage.getItem("qingagent:pending-message");
    const files = peekPendingFiles();
    const pendingFolder = peekPendingFolderSource();
    // 新建页选的技能(0702:此前 skills 写死 [],技能被整个丢掉)。防御性解析:坏 JSON/坏形状一律当没有。
    const pendingSkills: Extract<Command, { kind: "sendMessage" }>["data"]["skills"] = (() => {
      try {
        const raw = sessionStorage.getItem("qingagent:pending-skills");
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter((s): s is { id: string } => Boolean(s) && typeof s.id === "string" && s.id.length > 0)
          .map((s) => ({ id: s.id, version: null }));
      } catch {
        return [];
      }
    })();
    // 新建页输入框的 chips(WYSIWYG):气泡按 richText 的 {{chip:N}} 原位内联渲染,与输入框所见一致。
    const pendingRichText = sessionStorage.getItem("qingagent:pending-richtext");
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
            pendingChips.length > 0 && pendingRichText ? pendingRichText : messageText;
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
        const [uploadedAssets, sessionId] = await Promise.all([uploadFiles(files), sessionPromise]);
        const fileIds = uploadedAssets.map((asset) => asset.fileId);
        markMaterialParsing(uploadedAssets);
        if (pendingFolder) {
          await sendAttachFolderSelection(
            stream,
            sessionId,
            folderAttachSelectionFromPending(pendingFolder),
            { awaitBrowserBridge: pendingFolder.provider === "browser-fs-access" },
          );
          if (peekPendingFolderSource() === pendingFolder) clearPendingFolderSource();
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
            ...(pendingChips.length > 0 && pendingRichText ? { richText: pendingRichText } : {}),
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

    const syncHashSession = () => {
      const nextSessionId = workspaceSessionIdFromHash(window.location.hash);
      if (nextSessionId === activeWorkspaceSessionTargetRef.current && streamRef.current) return;
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
      // 不在 cleanup dispose stream:开发 StrictMode 会立即 cleanup/re-run,
      // 误杀在途 SSE 会复现首轮生成丢帧。
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
    const sessionId = state.sessionId ?? workspaceSessionIdFromHash(window.location.hash);
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
        return await res.json() as HistorySnapshot;
      })
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({
          kind: "historySnapshotSet",
          doc: pmDocToViewDocumentSnapshot(snapshot.doc as PmDoc, snapshot.docVersion),
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
  }, [closeViewingVersion, showToast, state.sessionId, state.viewingVersion, state.viewingVersionId]);

  const sendDocWrite = useCallback(
    (pmDoc: PmDoc): Promise<void> => {
      const stream = streamRef.current;
      const sessionId = sessionIdRef.current;
      if (!stream || !sessionId) {
        const error = new PendingDocSaveError("连接未就绪，刚才的手动编辑未保存。");
        showBackgroundDocSaveFailure(error);
        rejectPendingDocSaveDrain(error);
        return Promise.reject(error);
      }

      const legacySections = pmToLegacySections(pmDoc) as unknown as LegacySection[];
      const clientMutationId = createClientMutationId();
      const command: Command = {
        kind: "updateDoc",
        data: {
          sessionId,
          expectedDocumentSnapshot: docVersionRef.current,
          doc: pmDoc,
          legacySections,
          clientMutationId,
        },
      };

      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] updateDoc validation failed", e);
        const error = new PendingDocSaveError("保存失败，请检查文档内容后重试。");
        showBackgroundDocSaveFailure(error);
        rejectPendingDocSaveDrain(error);
        return Promise.reject(error);
      }

      pendingDocWriteRef.current = true;
      latestDocMutationIdRef.current = clientMutationId;
      lastSentPmDocRef.current = pmDoc;

      const ackPromise = new Promise<void>((resolve, reject) => {
        docWriteAckRef.current.set(clientMutationId, { resolve, reject });
      });

      const failAck = (error: Error) => {
        const waiter = docWriteAckRef.current.get(clientMutationId);
        docWriteAckRef.current.delete(clientMutationId);
        if (latestDocMutationIdRef.current === clientMutationId) {
          pendingDocWriteRef.current = false;
          latestDocMutationIdRef.current = null;
          queuedPmDocRef.current = null;
          scheduledDocWriteRef.current = false;
        }
        waiter?.reject(error);
        rejectPendingDocSaveDrain(error);
      };

      // 保存路径已是单飞 + 队列(同一时刻仅一条 updateDoc 在途)。瞬态网络失败
      // (Failed to fetch / 请求被取消)请求多半没到服务端,用同一 expectedDocumentSnapshot
      // 静默重试是安全的;重试期间保持单飞占用,不弹刺眼错误。内容始终在编辑器里(下次编辑/
      // 离开页面都会兜底重存),所以瞬态最终失败也只给温和文案,不吓用户。
      const MAX_TRANSIENT_DOC_SAVE_RETRIES = 2;
      const canRetryDocSave = () =>
        sessionIdRef.current === sessionId &&
        latestDocMutationIdRef.current === clientMutationId &&
        docWriteAckRef.current.has(clientMutationId);

      const attemptDocSaveSend = (attempt: number): void => {
        stream
          .sendCommand(command)
          .then(() => {
            // SSE 结束但 ack 未到(请求被取消/服务端未回 docWriteResult):内容仍在编辑器,
            // 不当硬失败弹红错;静默收尾,靠下次编辑或离开页面兜底重存。
            if (!docWriteAckRef.current.has(clientMutationId)) return;
            failAck(
              new PendingDocSaveError("保存未收到服务端确认,下次编辑会自动重存。"),
            );
          })
          .catch((e) => {
            const isTransient = classifyDocSaveError(e) === "transient";
            if (
              isTransient &&
              attempt < MAX_TRANSIENT_DOC_SAVE_RETRIES &&
              canRetryDocSave()
            ) {
              console.warn(
                `[workspace] updateDoc 瞬态失败,自动重试 ${attempt + 1}/${MAX_TRANSIENT_DOC_SAVE_RETRIES}`,
                e,
              );
              docSaveRetryTimerRef.current = setTimeout(() => {
                docSaveRetryTimerRef.current = null;
                // fire 时再判一次:退避窗口内若切了会话 / 被取代 / 已卸载,绝不用旧态重发。
                if (!canRetryDocSave()) return;
                attemptDocSaveSend(attempt + 1);
              }, 300 * (attempt + 1));
              return;
            }
            const error = isTransient
              ? new PendingDocSaveError(TRANSIENT_DOC_SAVE_TOAST)
              : e instanceof Error
                ? new PendingDocSaveError(`保存请求失败：${e.message}`)
                : new PendingDocSaveError("保存请求失败，请重试。");
            console.error("[workspace] updateDoc failed", e);
            failAck(error);
            showBackgroundDocSaveFailure(error);
          });
      };

      attemptDocSaveSend(0);

      return ackPromise;
    },
    [rejectPendingDocSaveDrain, showBackgroundDocSaveFailure],
  );

  useEffect(() => {
    sendDocWriteRef.current = sendDocWrite;
  }, [sendDocWrite]);

  const focusPendingBlankTarget = useCallback(() => {
    const target = pendingBlankFocusRef.current;
    if (!target) return;
    window.requestAnimationFrame(() => {
      const editor = tiptapEditorRef.current;
      if (!editor || editor.isDestroyed || !editor.isEditable) return;
      if (focusStarterBlankTarget(editor, target)) {
        pendingBlankFocusRef.current = null;
      }
    });
  }, []);

  useEffect(() => {
    if (!pendingBlankFocusRef.current || !tiptapEditor) return;
    focusPendingBlankTarget();
  }, [focusPendingBlankTarget, tiptapEditor, state.docState.kind, state.doc]);

  // 空引导态点击模板「填充」:惰性创建会话 → 把骨架写入文档(走和手动编辑一致的 updateDoc 路径)。
  // 单飞(review #2):in-flight 期间重复点击直接忽略——双击会并发两条 expectedDocumentSnapshot=0
  // 的 updateDoc,第二条必撞 conflict,且把 latestDocMutationIdRef 覆盖成失败那条,造成
  // "服务端已填充成功、前端却显示失败+空文档"的三重误导。promise 存 ref,发送消息前可等它落定(review #6)。
  const handleFillTemplate = useCallback(
    (template: StarterTemplate) => {
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接未就绪 · 请稍候重试");
        return;
      }
      // 上一次填充/其它 doc 写还在途:忽略本次点击,不制造并发首写
      if (fillTemplatePromiseRef.current) return;
      if (pendingDocWriteRef.current || scheduledDocWriteRef.current) return;
      let skeleton: PmDoc;
      try {
        skeleton = buildTemplateSkeleton(template);
      } catch (e) {
        console.error("[workspace] build template skeleton failed", e);
        showToast("填充失败 · 模板异常");
        return;
      }
      // 单飞守卫保证 in-flight 期间不会有第二次填充覆盖 ref,finally 直接置空即可
      fillTemplatePromiseRef.current = (async () => {
        try {
          await ensureSessionIdOnce(
            stream,
            stateRef,
            sessionIdRef,
            startNewSessionPromiseRef,
            replaceWorkspaceSessionHash,
          );
          await sendDocWriteRef.current(skeleton);
        } catch (e) {
          console.error("[workspace] fill template failed", e);
          showToast("填充失败 · 请重试");
        } finally {
          fillTemplatePromiseRef.current = null;
        }
      })();
    },
    [showToast],
  );

  const handleCreateBlankDoc = useCallback(
    (target: StarterBlankTarget) => {
      let blankDoc: PmDoc;
      try {
        blankDoc = buildBlankStarterDoc();
      } catch (e) {
        console.error("[workspace] build blank starter doc failed", e);
        showToast("创建失败 · 空文档异常");
        return;
      }
      pendingBlankFocusRef.current = target;
      dispatch({
        kind: "manualDocSaved",
        pmDoc: blankDoc,
        version: stateRef.current.version,
      });
      focusPendingBlankTarget();
    },
    [focusPendingBlankTarget, showToast],
  );

  const handleEditorChange = useCallback(
    (pmDoc: PmDoc): Promise<void> => {
      const current = stateRef.current;
      if (
        !canEditDocument(
          deriveDocDimensions(current),
          current.viewingVersion,
        ) ||
        presentationRunRef.current !== null ||
        !current.doc
      ) {
        return Promise.resolve();
      }

      // 廉价判断在前(review E2):有 session 的常规编辑(绝大多数)直接短路,不白跑整树遍历
      if (!current.sessionId && !pmDocHasSubstantiveContent(pmDoc)) {
        dispatch({
          kind: "manualDocSaved",
          pmDoc,
          version: current.version,
        });
        return Promise.resolve();
      }

      const persistDoc = (): Promise<void> => {
        if (pendingDocWriteRef.current || scheduledDocWriteRef.current) {
          queuedPmDocRef.current = pmDoc;
          return waitForPendingDocSaveDrain();
        }
        return sendDocWriteRef.current(pmDoc);
      };

      if (!current.sessionId) {
        const stream = streamRef.current;
        if (!stream) {
          const error = new PendingDocSaveError("连接未就绪，刚才的手动编辑未保存。");
          showBackgroundDocSaveFailure(error);
          rejectPendingDocSaveDrain(error);
          return Promise.reject(error);
        }
        return ensureSessionIdOnce(
          stream,
          stateRef,
          sessionIdRef,
          startNewSessionPromiseRef,
          replaceWorkspaceSessionHash,
        ).then(() => persistDoc());
      }

      if (pendingDocWriteRef.current || scheduledDocWriteRef.current) {
        queuedPmDocRef.current = pmDoc;
        return waitForPendingDocSaveDrain();
      }
      return sendDocWriteRef.current(pmDoc);
    },
    [rejectPendingDocSaveDrain, showBackgroundDocSaveFailure, waitForPendingDocSaveDrain],
  );

  const flushPendingDocSave = useCallback(async () => {
    foregroundDocSaveDepthRef.current += 1;
    try {
      await docViewRef.current?.flushPendingDocSave();
      await waitForPendingDocSaveDrain();
    } finally {
      foregroundDocSaveDepthRef.current = Math.max(0, foregroundDocSaveDepthRef.current - 1);
    }
  }, [waitForPendingDocSaveDrain]);

  const getLatestExportPmDoc = useCallback((): PmDoc | null => {
    const editor = tiptapEditorRef.current;
    if (editor && !editor.isDestroyed) {
      try {
        return normalizePmDoc(editor.getJSON());
      } catch (error) {
        console.error("[workspace] export live doc validation failed", error);
      }
    }
    return stateRef.current.doc?.pmDoc ?? null;
  }, []);

  useEffect(() => {
    const pageExitFlush = () => {
      const editor = tiptapEditorRef.current;
      const sessionId = sessionIdRef.current;
      if (!editor || editor.isDestroyed || !sessionId) return;
      const current = stateRef.current;
      if (
        !current.doc ||
        !canEditDocument(deriveDocDimensions(current), current.viewingVersion)
      ) {
        return;
      }

      let pmDoc: PmDoc;
      try {
        pmDoc = normalizePmDoc(editor.getJSON());
      } catch (error) {
        console.error("[workspace] page-exit updateDoc validation failed", error);
        return;
      }

      const expectedDocumentSnapshot = docVersionRef.current;
      const fingerprint = pageExitDocSaveFingerprint({
        sessionId,
        expectedDocumentSnapshot,
        pmDoc,
      });
      if (pageExitDocSaveFingerprintRef.current === fingerprint) return;

      try {
        const result = flushDocSaveOnPageExit({
          sessionId,
          expectedDocumentSnapshot,
          pmDoc,
          baselineDoc: current.doc.pmDoc ?? null,
          hasPendingDocSave:
            pendingDocWriteRef.current ||
            queuedPmDocRef.current !== null ||
            scheduledDocWriteRef.current,
        });
        if (result !== "skipped") pageExitDocSaveFingerprintRef.current = fingerprint;
      } catch (error) {
        console.error("[workspace] page-exit updateDoc flush failed", error);
      }
    };

    const visibilityFlush = () => {
      if (document.visibilityState !== "hidden") return;
      void flushPendingDocSave().catch((error) => {
        console.error("[workspace] hidden updateDoc flush failed", error);
      });
    };

    window.addEventListener("pagehide", pageExitFlush);
    window.addEventListener("beforeunload", pageExitFlush);
    document.addEventListener("visibilitychange", visibilityFlush);
    return () => {
      window.removeEventListener("pagehide", pageExitFlush);
      window.removeEventListener("beforeunload", pageExitFlush);
      document.removeEventListener("visibilitychange", visibilityFlush);
    };
  }, [flushPendingDocSave]);

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
          status: result.status === "missing" ? "permission_required" : result.status,
          error: result.error,
        },
      }));
      showToast(result.error);
      return;
    }
    const selectFolderSource = window.electron?.isDesktop
      ? window.electron.selectFolderSource
      : undefined;

    let desktopSelection: Awaited<ReturnType<NonNullable<typeof selectFolderSource>>> | null = null;
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
    } else if (folderCapability.enabled && typeof window.showDirectoryPicker === "function") {
      try {
        browserSelection = await pickBrowserFolderSource(sessionIdRef.current ?? "pending");
      } catch (error) {
        // 用户在系统选择器里点了取消(AbortError)→ 不弹任何提示(原来会弹一条英文 toast)。
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[workspace] showDirectoryPicker failed", error);
        showToast(error instanceof Error ? error.message : "选择文件夹失败，请重试");
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
      console.error("[workspace] ensure session for attachFolder failed", error);
      showToast("会话创建失败，请重试");
      return;
    }

    const selection: FolderAttachSelection = desktopSelection
      ? { provider: "desktop-local", selectionToken: desktopSelection.selectionToken }
      : { provider: "browser-fs-access", picked: browserSelection! };
    try {
      await sendAttachFolderSelection(stream, sessionId, selection);
    } catch (error) {
      console.error("[workspace] attachFolder failed", error);
      showToast("连接文件夹失败，请重试");
    }
  }, [ensureSessionId, folderCapability.enabled, folderCapability.reason, folderSource, sendAttachFolderSelection, showToast]);

  const handleDetachFolder = useCallback(async (folderId: string) => {
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
  }, [showToast]);

  const handleSubmitChat = useCallback(() => {
    const blockReason = getChatInputBlockReason(
      dim,
      askUserInputDisabled,
      stateRef.current.viewingVersion !== null,
    );
    if (blockReason) {
      showToast(blockReason.toast, blockReason.durationMs);
      return;
    }

    const snap = chatInputRef.current?.snapshot();
    if (
      !snap ||
      (snap.text.length === 0 &&
        snap.chips.length === 0 &&
        snap.files.length === 0)
    ) {
      showToast("先写点描述吧");
      return;
    }

    const keepMessageCount = stateRef.current.messages.length;

    // Optimistic UI: add user message bubble to chat.
    // When chips are present, use richText (which includes {{chip:N}}
    // markers) as the body so ChatMessageList can render chips inline
    // with text. The server still receives the clean `snap.text`.
    const displayBody =
      snap.chips.length > 0 && snap.richText ? snap.richText : snap.text;
    // 乐观气泡与服务端直播 user 帧共用同一 id(经 clientMessageId 传给后端):
    // reducer 按 id 去重合一,且重进重放(after=0)时 FrameLog 里有用户帧,气泡不消失。
    const clientMessageId = `m-user-${Date.now()}`;
    dispatch({
      kind: "chatMessageAdded",
      data: {
        message: {
          id: clientMessageId,
          role: { kind: "user" },
          ts: new Date().toISOString(),
          parts: [{ kind: "text", data: { body: displayBody } }],
          chips: snap.chips.map(toContractChip),
        },
      },
    });
    chatInputRef.current?.clear();
    // 发送 = 关预览 + 收面板(clear() 已收面板/清选中,这里关右侧预览)。
    setPreviewSource(null);

    const filesToUpload = snap.files;

    const stream = streamRef.current;
    if (!stream) {
      rollbackOptimisticChatSend({
        dispatch,
        chatInput: chatInputRef.current,
        snapshot: snap,
        keepMessageCount,
        setSendPending,
        showToast,
        error: new Error("连接还没准备好"),
      });
      return;
    }

    // 点发送即点亮输入框辉光,补上"气泡已发出、流还没激活"的空窗。
    setSendPending(true);

    const send = async () => {
      // 模板填充在途时先等它落定(成败都等,失败自身已 toast):否则 sendMessage 可能先被服务端
      // 处理并置 streamId,骨架 updateDoc 随后被拒、模板内容永久丢失(review #6)。
      if (fillTemplatePromiseRef.current) {
        await fillTemplatePromiseRef.current.catch(() => {});
      }
      await runAfterPendingDocSave({
        flushPendingDocSave,
        run: async () => {
          // 先上传文件，再把 fileIds 随消息发给后端解析。
          const uploadedAssets = await uploadFiles(filesToUpload);
          const fileIds = uploadedAssets.map((asset) => asset.fileId);
          markMaterialParsing(uploadedAssets);

          const contractChips = snap.chips.map(toContractChip);

          const sessionId = await ensureSessionId(stream);
          const command: Extract<Command, { kind: "sendMessage" }> = {
            kind: "sendMessage",
            data: {
              sessionId,
              text: snap.text,
              mentions: [],
              skills: snap.skills,
              chips: contractChips,
              fileIds,
              clientMessageId,
              // richText({{chip:N}} 原位):服务端据此内联展开给模型 + 作气泡体(WYSIWYG)。
              ...(snap.chips.length > 0 && snap.richText ? { richText: snap.richText } : {}),
            },
          };
          lastRetriableSendRef.current = command;
          await reviewCloseInFlightRef.current;
          await stream.sendCommand(command);
        },
      });
    };

    send().catch((e) => {
      console.error("[workspace] sendMessage failed", e);
      rollbackOptimisticChatSend({
        dispatch,
        chatInput: chatInputRef.current,
        snapshot: snap,
        keepMessageCount,
        setSendPending,
        showToast,
        error: e,
      });
    });
  }, [askUserInputDisabled, dim, ensureSessionId, flushPendingDocSave, markMaterialParsing, showToast]);
  // 让 chatInputBus.send 的订阅者拿到最新 handleSubmitChat(每渲染同步)。
  handleSubmitChatRef.current = handleSubmitChat;

  const handleRetryDrafting = useCallback(() => {
    const stream = streamRef.current;
    const command = lastRetriableSendRef.current;
    if (!stream || !command) {
      showToast("没有可重试的上一条消息");
      return;
    }
    dispatch({ kind: "retryDrafting", streamId: "last" });
    setSendPending(true);
    stream.sendCommand(command).catch((e) => {
      console.error("[workspace] retry sendMessage failed", e);
      setSendPending(false);
      showToast("重试失败 · 请重试");
    });
  }, [showToast]);

  useEffect(() => {
    const streamError = state.streamError;
    if (!streamError) {
      toast.dismiss(STREAM_ERROR_TOAST_KEY, { runOnDismiss: false });
      return;
    }

    const actionLabel = streamErrorActionLabel(streamError);
    const action = (() => {
      if (!actionLabel) return undefined;
      if (streamError.kind === "docWriteConflict" || streamError.action === "reload") {
        return { label: actionLabel, onClick: () => window.location.reload() };
      }
      if (streamError.action === "check_balance" || streamError.action === "check_model_settings") {
        return { label: actionLabel, onClick: () => goConfigureModel(handleBackHome) };
      }
      if (streamError.kind === "draftingFailed" && canRetryStreamError(streamError)) {
        return { label: actionLabel, onClick: handleRetryDrafting };
      }
      if (streamError.kind === "failed" && canRetryStreamError(streamError) && restoreExistingSessionIdRef.current) {
        return {
          label: actionLabel,
          onClick: () => {
            const sessionId = restoreExistingSessionIdRef.current;
            if (!sessionId) return;
            restoreExistingSession(sessionId).catch((e) => {
              console.error("[workspace] session restore retry failed", e);
            });
          },
        };
      }
      return undefined;
    })();

    toast.show({
      message: streamErrorToastMessage(streamError),
      tone: streamErrorToastTone(streamError),
      sticky: shouldStickStreamErrorToast(streamError),
      role: streamErrorToastRole(streamError),
      action,
      dedupeKey: STREAM_ERROR_TOAST_KEY,
      onDismiss: () => dispatch({ kind: "streamErrorCleared" }),
    });

    return () => {
      toast.dismiss(STREAM_ERROR_TOAST_KEY, { runOnDismiss: false });
    };
  }, [handleBackHome, handleRetryDrafting, restoreExistingSession, state.streamError, toast]);

  const handleCancelActiveStream = useCallback(() => {
    const streamIds = stateRef.current.activeStreamIds.slice();
    if (streamIds.length === 0) {
      showToast("当前没有正在生成的任务");
      return;
    }
    const stream = streamRef.current;
    if (!stream) {
      showToast("连接还没准备好");
      return;
    }

    const commands = buildCancelStreamCommands(streamIds);
    for (const command of commands) {
      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] cancelStream validation failed", e);
        showToast("操作失败，请重试");
        return;
      }
    }

    dispatch({
      kind: "streamTerminated",
      reason: "stop",
      streamIds,
    });
    showToast("已中断");
    for (const command of commands) {
      stream.sendCommand(command).catch((e) => {
        console.error("[workspace] cancelStream failed", e);
        showToast("停止失败 · 请重试");
      });
    }
  }, [showToast]);

  const handleAiModify = useCallback(
    async (
      text: string,
      _location: string,
      from?: number,
      to?: number,
      blockId?: string,
      selectionRefs?: string[],
    ) => {
      const handle = chatInputRef.current;
      if (!handle) return;
      // 输入框被门控(问卷未答/有未提交候选/看历史版本)时,insertChip 会静默 no-op
      // (ChatInput.insertChip 首行 `if (!edit || disabled) return`)——用户点 ✨AI修改
      // 毫无反应。这里前置同一门控判据,给出与输入框一致的明确 toast 而非静默吞。
      if (chatInputBlockReason) {
        showToast(chatInputBlockReason.toast);
        return;
      }
      const hasSelectionRefs = Boolean(selectionRefs && selectionRefs.length > 0);
      if (
        from !== undefined &&
        to !== undefined &&
        tiptapEditor &&
        !hasSelectionRefs &&
        !isEditorRangeWithinSingleTextBlock(tiptapEditor, from, to) &&
        // 原子块(图表/图片/公式等)整块引用放行——用户要把这个块丢给 AI 改
        !isEditorRangeSingleAtomBlock(tiptapEditor, from, to)
      ) {
        showToast("暂不支持跨段落修改,请在同一段内选择");
        return;
      }
      try {
        await runAfterPendingDocSave({
          flushPendingDocSave,
          onFlushFailure: (error) => {
            showToast(docSaveFailureToastMessage(error));
          },
          run: async () => {
            const raw = text.replace(/^"|"$/g, "");
            handle.insertChip({
              kind: "sel",
              label: raw,
              suffix: "批注",
              from,
              to,
              blockId,
              selectionRefs,
            });
            // Focus + caret placement is handled inside insertChip via
            // requestAnimationFrame so it survives the React re-renders
            // triggered by showToast / DocToolbar state updates below.
            showToast("选段已加入输入框");
          },
        });
      } catch {
        return;
      }
    },
    [chatInputBlockReason, flushPendingDocSave, showToast, tiptapEditor],
  );

  const handleRejectAll = useCallback(() => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return;
    }
    // Read patches from the ref for the same freshness guarantee
    // as handleCommit — see the comment there for the rationale.
    const currentPatches = selectPatches(stateRef.current);
    const stream = streamRef.current;
    const currentSessionId = stateRef.current.sessionId;
    // "放弃全部"只作用于尚未采纳的候选:已采纳(accepted)的处保留提交,
    // 其余拒绝——否则半采纳后点放弃会把用户确认过的改动一起回滚丢失
    // (e2e-loop-0704 P1)。反馈卡口径(rejectUndecided)与提交口径同源。
    const { acceptReviewBatchIds, rejectReviewBatchIds } =
      buildReviewGroupRejectSelection(currentPatches);
    const reviewOutcome = buildReviewOutcome(currentPatches, { rejectUndecided: true });

    dispatch({ kind: "forceUnlockReview" });
    setActivePatchId(null);
    showToast(
      acceptReviewBatchIds.length > 0
        ? `已保留已采纳的 ${reviewOutcome.acceptedCount} 处 · 撤销其余修改`
        : "已撤销本轮全部修改",
    );

    if (
      !stream ||
      !currentSessionId ||
      currentPatches.length === 0 ||
      (rejectReviewBatchIds.length === 0 && acceptReviewBatchIds.length === 0)
    ) return;

    // Cancel any in-flight SSE connections (same rationale as handleCommit).
    stream.stop();

    const send = async () => {
      await stream.commitReviewGroups(currentSessionId, {
        acceptReviewBatchIds,
        rejectReviewBatchIds,
      }).then((frames) => {
        if (!reviewCommitFramesLeavePendingReview(frames)) {
          dispatch({ kind: "forceUnlockReview" });
          showToast("审阅状态未自动退出，已恢复编辑");
        }
        sendReviewOutcomeFollowup(stream, currentSessionId, reviewOutcome);
      });
    };

    const closePromise = send().catch((e) => {
      console.error("[workspace] rejectAll failed", e);
      dispatch({ kind: "forceUnlockReview" });
      showToast("操作失败 · 请重试");
    });
    const trackedClosePromise = closePromise.finally(() => {
      if (reviewCloseInFlightRef.current === trackedClosePromise) {
        reviewCloseInFlightRef.current = null;
      }
    });
    reviewCloseInFlightRef.current = trackedClosePromise;
  }, [showToast]);

  const handleAcceptAll = useCallback(() => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return;
    }
    const currentPatches = selectPatches(stateRef.current);
    const stream = streamRef.current;
    const currentSessionId = stateRef.current.sessionId;
    if (!stream || !currentSessionId || currentPatches.length === 0) {
      showToast("没有改动可提交");
      return;
    }

    stream.stop();
    const acceptReviewBatchIds = [
      ...new Set(currentPatches.map(reviewBatchIdFromPatch)),
    ];
    stream
      .commitReviewGroups(currentSessionId, { acceptReviewBatchIds })
      .then((frames) => {
        if (!reviewCommitFramesLeavePendingReview(frames)) {
          dispatch({ kind: "forceUnlockReview" });
          showToast("审阅状态未自动退出，已恢复编辑");
        }
      })
      .catch((e) => {
        console.error("[workspace] acceptAll commitReviewGroups failed", e);
        dispatch({ kind: "forceUnlockReview" });
        showToast("提交失败 · 请重试");
      });
  }, [showToast]);

  const handleJumpNext = useCallback(() => {
    const allPatchIds = visibleReviewPatchIds;
    if (allPatchIds.length === 0) return;
    const curIdx = activePatchId ? allPatchIds.indexOf(activePatchId) : -1;
    const nextIdx = curIdx < allPatchIds.length - 1 ? curIdx + 1 : 0;
    const nextId = allPatchIds[nextIdx];
    if (!nextId) return;
    setActivePatchId(nextId);
    const el = document.querySelector(`[data-patch-id="${nextId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visibleReviewPatchIds, activePatchId]);

  const handleJumpPrev = useCallback(() => {
    const allPatchIds = visibleReviewPatchIds;
    if (allPatchIds.length === 0) return;
    const curIdx = activePatchId ? allPatchIds.indexOf(activePatchId) : allPatchIds.length;
    const prevIdx = curIdx > 0 ? curIdx - 1 : allPatchIds.length - 1;
    const prevId = allPatchIds[prevIdx];
    if (!prevId) return;
    setActivePatchId(prevId);
    const el = document.querySelector(`[data-patch-id="${prevId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [visibleReviewPatchIds, activePatchId]);

  const handlePatchVerdict = useCallback(
    (patchId: string, verdict: "accepted" | "rejected") => {
      if (stateRef.current.viewingVersion !== null) {
        showToast("正在查看历史版本，先返回当前版本");
        return;
      }
      const command = buildPatchVerdictCommand(selectPatches(stateRef.current), patchId, verdict);
      try {
        validateCommand(command);
      } catch (e) {
        console.error(`[workspace] ${command.kind} validation failed`, e);
        return;
      }
      const stream = streamRef.current;
      if (!stream) return;
      stream
        .sendCommand(command)
        .catch((e) => {
          console.error(`[workspace] ${command.kind} failed`, e);
          showToast("操作失败 · 请重试");
        });
      showToast(verdict === "accepted" ? "已保留这处改动" : "已取消这处改动");
    },
    [showToast],
  );

  const handleCommit = useCallback(() => {
    if (stateRef.current.viewingVersion !== null) {
      showToast("正在查看历史版本，先返回当前版本");
      return;
    }
    // Read patches from the ref to guarantee freshness — the useCallback
    // closure can go stale when React batches state updates from the SSE
    // stream listener (dispatch is called inside an async reader loop,
    // and the re-render that would refresh allReviewPatches may not have
    // committed yet when the user clicks the button).
    const currentPatches = selectPatches(stateRef.current);
    const total = currentPatches.length;
    if (total === 0) {
      showToast("没有改动可提交");
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    const currentSessionId = stateRef.current.sessionId;
    if (!currentSessionId) {
      showToast("会话未就绪");
      return;
    }

    const { acceptReviewBatchIds, rejectReviewBatchIds } =
      buildReviewGroupCommitSelection(currentPatches);

    // 在提交前从当前审阅快照归并审核结果（commit 语义:每处 hunk 独立表态）。
    // 提交成功后,若非全量采纳则以用户名义回流给模型。
    const reviewOutcome = buildReviewOutcome(currentPatches);

    stream
      .commitReviewGroups(currentSessionId, {
        acceptReviewBatchIds,
        rejectReviewBatchIds,
      })
      .then((frames) => {
        // 与 handleAcceptAll / handleRejectAll 对称的兜底(review-loop-0702 lane-B):
        // commit 响应若缺状态转移帧(stale pendingReview),不兜底就永久锁输入。
        // 逐条处理完的 auto-commit 也汇入本路径,该洞影响面比手动提交更大。
        if (!reviewCommitFramesLeavePendingReview(frames)) {
          dispatch({ kind: "forceUnlockReview" });
          showToast("审阅状态未自动退出，已恢复编辑");
        }
        sendReviewOutcomeFollowup(stream, currentSessionId, reviewOutcome);
      })
      .catch((e) => {
        console.error("[workspace] commitReviewGroups failed", e);
        dispatch({ kind: "forceUnlockReview" });
        showToast("提交失败 · 请重试");
      });
  }, [showToast]);

  /**
   * 问卷作答统一提交(BigPlan 全页问卷 + 内联反问卡共用):先乐观把 askUser 卡置 done
   * (reducer 会同步清 askUser overlay),立即收起弹层、恢复输入/导出,不等服务端
   * resume 回帧;发送失败按快照回滚(restoreAskUser)。
   * e2e-loop-0704 R1/R12 回归:内联问卷(审核回流追问等)提交后弹层滞留、输入/导出
   * 持续被禁,需手动点"关闭"才恢复——根因是内联路径只发 resumeAskUser 命令、没有
   * BigPlan 路径同款的乐观收口(服务端 resume 后 askUser done 帧要等整轮结束才回)。
   */
  const handleSubmitAskUserAnswers = useCallback(
    (toolCallId: string, answers: AskUserAnswers, successToast: string): boolean => {
      const current = stateRef.current;
      const originalTc = current.toolCalls.get(toolCallId);
      if (!originalTc) {
        showToast("问卷已不在");
        return false;
      }
      if (!current.sessionId) {
        showToast("会话未就绪");
        return false;
      }
      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return false;
      }
      const ownerMsg = current.messages.find((m) =>
        m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
      );
      const ownerMsgId = ownerMsg?.id ?? toolCallId;
      const originalOverlay = current.activeOverlay;
      const originalDocState = current.docState;
      const originalAgentBusy = current.agentBusy;
      const optimisticTc: ToolCallSpec = {
        ...originalTc,
        status: { kind: "done" },
        result: { kind: "askUserAnswers", data: answers },
      };
      try {
        validateCommand({
          kind: "resumeAskUser",
          data: { sessionId: current.sessionId, toolCallId, answers },
        });
      } catch (e) {
        console.error("[workspace] resumeAskUser validation failed", e);
        showToast("操作失败，请重试");
        return false;
      }

      setSubmittingAskUserId(toolCallId);
      dispatch({
        kind: "toolCallUpdated",
        data: {
          messageId: ownerMsgId,
          toolCallId,
          spec: optimisticTc,
        },
      });
      stream
        .sendCommand({
          kind: "resumeAskUser",
          data: { sessionId: current.sessionId, toolCallId, answers },
        })
        .catch((e) => {
          console.error("[workspace] resumeAskUser failed", e);
          const latest = stateRef.current.toolCalls.get(toolCallId);
          const stillOptimistic =
            latest?.status.kind === "done" &&
            latest.result?.kind === "askUserAnswers" &&
            latest.result.data === answers;
          if (stillOptimistic) {
            dispatch({
              kind: "restoreAskUser",
              messageId: ownerMsgId,
              toolCall: originalTc,
              overlay: originalOverlay,
              docState: originalDocState,
              agentBusy: originalAgentBusy,
            });
          }
          showToast("提交失败,请重试");
        })
        .finally(() => {
          setSubmittingAskUserId((currentId) =>
            currentId === toolCallId ? null : currentId,
          );
        });

      showToast(successToast);
      return true;
    },
    [showToast],
  );

  const handleSubmitPlan = useCallback(
    (toolCallId: string, answers: AskUserAnswers) => {
      if (!handleSubmitAskUserAnswers(toolCallId, answers, "方向已确认，开始写作")) {
        return;
      }
      const genreVal = answers["q-genre"]?.chosen[0];
      if (genreVal) {
        setGoalLabel(GENRE_LABELS[genreVal] ?? genreVal);
      }
    },
    [handleSubmitAskUserAnswers],
  );

  const handleCancelAskUser = useCallback(
    (toolCall: ToolCallSpec) => {
      const current = stateRef.current;
      if (!current.sessionId) {
        showToast("会话未就绪");
        return;
      }

      const command: Command = {
        kind: "cancelAskUser",
        data: { sessionId: current.sessionId, toolCallId: toolCall.id },
      };
      try {
        validateCommand(command);
      } catch (e) {
        console.error("[workspace] cancelAskUser validation failed", e);
        showToast("操作失败，请重试");
        return;
      }

      const stream = streamRef.current;
      if (!stream) {
        showToast("连接还没准备好");
        return;
      }

      stream.sendCommand(command).catch((e) => {
        console.error("[workspace] cancelAskUser failed", e);
        showToast("放弃失败 · 请重试");
      });

      const ownerMsg = current.messages.find((m) =>
        m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCall.id),
      );
      dispatch({
        kind: "toolCallUpdated",
        data: {
          messageId: ownerMsg?.id ?? toolCall.id,
          toolCallId: toolCall.id,
          spec: {
            ...toolCall,
            status: {
              kind: "failed",
              data: { retriable: false, reason: "用户已放弃本轮问卷" },
            },
          },
        },
      });
      showToast("已放弃本轮");
    },
    [showToast],
  );

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
      resources.applyUpdate({ id: materialId, domain: { kind: "file" } }, summary);
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

  useEffect(() => {
    if (!previewSource) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewSource(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewSource]);

  const reviewedCount = allReviewPatches.filter(
    (p) => p.status.kind === "accepted" || p.status.kind === "rejected",
  ).length;
  const remainingPatches = pendingReviewPatches.length;
  const currentPatchId =
    activePatchId && visibleReviewPatchIds.includes(activePatchId)
      ? activePatchId
      : visibleReviewPatchIds[0] ?? null;
  const activePatchIndex = currentPatchId ? visibleReviewPatchIds.indexOf(currentPatchId) : -1;
  const autoCommitReviewKey = useMemo(
    () =>
      allReviewPatches
        .map((patch) => `${reviewBatchIdFromPatch(patch)}:${patch.id}:${patch.status.kind}`)
        .join("|"),
    [allReviewPatches],
  );
  useEffect(() => {
    if (remainingPatches !== 0 || allReviewPatches.length === 0) {
      autoCommitReviewKeyRef.current = null;
      return;
    }
    const key = `${state.sessionId ?? ""}:${autoCommitReviewKey}`;
    if (autoCommitReviewKeyRef.current === key) return;
    autoCommitReviewKeyRef.current = key;
    handleCommit();
  }, [
    allReviewPatches.length,
    autoCommitReviewKey,
    handleCommit,
    remainingPatches,
    state.sessionId,
  ]);
  return (
    <section
      ref={viewRef}
      data-view="workspace"
      data-wf="WorkspacePage"
      data-content={dataAttrs.content}
      data-tool={dataAttrs.tool}
      id="view-workspace"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* 推翻旧标题栏:改为左上角浮动箭头返回(动线回首页),无横贯顶栏 */}
      <button
        type="button"
        className="ws-back-home"
        title="返回首页"
        onClick={handleBackHome}
      >
        ←
      </button>

      {/* 文档纸顶部带:右上角图标按钮(无文字)—— 历史 / 导出 */}
      <div className="ws-doc-topbar" data-wf="WorkspaceDocTopbar">
        {(externalPatchCount > 0 || externalToolConnected) && (
          <div className="ws-external-badge" aria-live="polite">
            {externalPatchCount > 0
              ? `外部工具提交了 ${externalPatchCount} 处修改`
              : "外部工具已连接"}
          </div>
        )}
        {/* 历史版本功能暂未迭代,先隐藏入口(及"即将上线"toast);后端已就绪,功能做完把 false 翻开即可。 */}
        {HISTORY_ENTRY_ENABLED && (
          <button
            type="button"
            className="ws-doc-btn"
            title="查看历史记录"
            onClick={() => showToast("历史版本功能即将上线")}
          >
            <HistoryIcon />
          </button>
        )}
        <div className="ws-export-anchor" ref={exportAnchorRef}>
          <button
            type="button"
            className={`ws-doc-btn${exportDisabledReason ? " is-disabled" : ""}`}
            title={exportDisabledReason ?? "导出"}
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            aria-disabled={exportDisabledReason ? true : undefined}
            onClick={() => {
              if (exportDisabledReason) return;
              setExportMenuOpen((v) => !v);
            }}
          >
            <ExportIcon />
          </button>
          {exportMenuOpen && !exportDisabledReason && (
            <ExportMenu
              anchorRef={exportAnchorRef}
              onClose={() => setExportMenuOpen(false)}
              onAction={showToast}
              flushPendingDocSave={flushPendingDocSave}
              getLatestPmDoc={getLatestExportPmDoc}
            />
          )}
        </div>
      </div>

      <div className="ws-body">
        <div className="ws-left">
          <ChatMessageList
            messages={state.messages}
            streamActive={state.streamActive}
            // 首 token 前还没有任何助手 part,不可能有工具行;与 generateSvg 的"生成配图中"不冲突。
            // 助手 thinking/text/toolCall 任意 part 一到,最后一条消息变 agent,这里自动隐去。
            showLoading={shouldShowPreTokenLoading(state.messages, state.streamActive)}
            patchRevealing={effectivePatchRevealing}
            livePatchCount={reviewUiState.livePatchCount}
            liveHunkKey={liveHunkKey}
            sessionId={state.sessionId}
            wholeDocReview={wholeDocReview}
            wholeDocReviewKeys={wholeDocReviewKeysRef.current}
            scrollRef={chatScrollRef}
            debugMode={debugMode}
          />
          <div className="ws-input-wrap">
            <TaskPill todos={state.todos} inputHidden={inputHandedOff} />
            <ScrollToBottomButton scrollRef={chatScrollRef} inputHidden={inputHandedOff} />
            {/* 同体平移:右侧出现操作条(问卷确认/审批)时,这个输入框外壳会被「滑」到右侧落点变成那个条
                (FLIP 在 WorkspacePage 编排),输入框在场时隐藏被接管、条消失时滑回。
                只裹 ChatInput + 素材抽屉 + debug pill;AskUserOverlay 留在外面作为内联反问卡。 */}
            <div
              ref={inputMorphRef}
              className={`ws-input-morph${chatInputEditorDisabled ? " is-morph-out" : ""}${inputContentOut ? " is-content-out" : ""}${inputHandedOff ? " is-morph-hidden" : ""}`}
            >
              <ChatInput
                ref={chatInputRef}
                placeholder={chatInputPlaceholder}
                disabled={chatInputEditorDisabled}
                agentActive={agentActive}
                sendEnabledWhenDisabled={chatInputSendEnabledWhenDisabled}
                onSubmit={handleSubmitChat}
                // 乐观:点发送即翻「停止」,不等服务端 agentBusy 回来(agentActive=streamActive||agentBusy||sendPending)
                showStop={agentActive}
                onStop={handleCancelActiveStream}
                onOpenSkillMenu={() => undefined}
                onPreviewMaterial={setPreviewSource}
                onPreviewFolderFile={setPreviewSource}
                onRemoveMaterial={handleRemoveMaterial}
                onToast={showToast}
                onPanelClose={() => setPreviewSource(null)}
                folderSource={folderSource}
                folderCapability={folderCapability}
                onAttachFolder={handleAttachFolder}
                onDetachFolder={handleDetachFolder}
                materialParseRows={materialParseRows}
                onRetryMaterialParse={handleRetryMaterialParse}
                noModelKey={!hasModelKey}
                onConfigureModel={() => goConfigureModel(handleBackHome)}
              />
            </div>
            {inlineAsk && (
              <AskUserOverlay
                spec={extractAskUser(inlineAsk)!}
                onClose={() => handleCancelAskUser(inlineAsk)}
                // 走与 BigPlan 同源的乐观提交:立即置 done 收起弹层、恢复输入/导出,
                // 失败回滚。修复"提交后弹层滞留需手动关闭"(e2e-loop-0704 R1/R12)。
                onSubmit={(answers) =>
                  handleSubmitAskUserAnswers(inlineAsk.id, answers, "已提交答案")
                }
                onAbort={() => handleCancelAskUser(inlineAsk)}
              />
            )}
          </div>
        </div>

        <div className={`ws-right${previewExit.source ? " is-previewing" : ""}`} ref={docScrollRef}>
          <RightPane
            dimensions={dim}
            agentReasoning={agentActive}
            onFillTemplate={handleFillTemplate}
            onCreateBlank={handleCreateBlankDoc}
            doc={state.doc}
            streamError={state.streamError}
            generationDraftDoc={state.generationDraft?.doc ?? null}
            viewingSnapshotDoc={state.viewingSnapshotDoc}
            docWithPatches={docWithPatches}
            wholeDocReview={wholeDocReview}
            wholeDocVersion={wholeDocVersion}
            editedNewDoc={editedNewDoc}
            onWholeDocVersionChange={handleWholeDocVersionChange}
            patchesAccepted={patchesAccepted}
            patchesRejected={patchesRejected}
            reviewedCount={reviewedCount}
            remainingCount={remainingPatches}
            activePatchIndex={activePatchIndex}
            visiblePatchCount={visiblePatchCount}
            unrenderablePatchCount={unrenderablePatchCount}
            effectiveReview={inlinePatchReview}
            reviewMaterializing={awaitingWholeDocReviewMaterial}
            showForceUnlock={showForceUnlock}
            fullpageAsk={fullpageAsk}
            submittingAskUserId={submittingAskUserId}
            viewingVersion={state.viewingVersion}
            docViewRef={docViewRef}
            patchMeta={patchMeta}
            activePatchId={currentPatchId}
            revealedPatchIds={revealedPatchIds}
            revealCursors={revealCursors}
            typedByPatch={typedByPatch}
            patchRevealing={effectivePatchRevealing}
            sessionId={state.sessionId}
            stream={streamRef.current}
            presentationRun={effectivePresentationRun}
            presentationReducedMotion={reducedMotion}
            onToast={showToast}
            onSubmitPlan={handleSubmitPlan}
            onJumpPrev={handleJumpPrev}
            onJumpNext={handleJumpNext}
            onRejectAll={handleRejectAll}
            onAcceptAll={handleAcceptAll}
            onCommit={handleCommit}
            onPatchVerdict={handlePatchVerdict}
            onCancelAskUser={handleCancelAskUser}
            onCloseViewingVersion={closeViewingVersion}
            onEditorReady={setTiptapEditor}
            onEditorChange={handleEditorChange}
            onPresentationFinish={clearPresentationRun}
            onPresentationCancel={clearPresentationRun}
          />
          <DocToolbar
            active={canUseDocumentEditing(dim, state.viewingVersion, effectivePresentationRun)}
            editor={tiptapEditor}
            containerSelector="#view-workspace .ws-right"
            onAiModify={handleAiModify}
            onToast={showToast}
          />
          {previewExit.source && (
            <AssetPreview
              key={previewExit.source.id}
              source={previewExit.source}
              sessionId={state.sessionId}
              onClose={() => setPreviewSource(null)}
              onEditSummary={handleEditSummary}
              summaryEditDisabled={agentActive}
              closing={previewExit.closing}
            />
          )}
        </div>
      </div>
      {/* 编辑锁提示与 qa-toast 同挂到 body 顶层:fixed 贴右下,避免被 .ws-right
          滚动流、sticky 或 transform/backdrop-filter 祖先影响。遮罩仍 pointer-events:none,
          不吃滚轮/点击;实际编辑屏蔽继续交给忙态下 .wf-doc pointer-events:none。 */}
      {editLockHint && editLockPortalTarget
        ? createPortal(
            <div className="ws-edit-lock" aria-hidden="true" data-wf="WorkspaceEditLockHint">
              <div className="ws-edit-lock-hint">
                <span className="ws-edit-lock-hint-dot" aria-hidden="true" />
                {editLockHint}
              </div>
            </div>,
            editLockPortalTarget,
          )
        : null}
      {/* 调试调参面板(动效/入场)默认隐藏,Ctrl+Shift+H 唤起。HumanCursorOverlay 是
          真实光标渲染、非调试按钮,始终保留。 */}
      {devToolsOpen && (
        <>
          {/* 右下角的「入场/Churn 调参」浮层去掉(出光标动效时挡内容、且非本期所需) */}
          <RevealTuningPanel
            canReplay={reviewUiState.canReplayReviewReveal && inlinePatchReview}
            onReplay={handleRevealReplay}
          />
          <MorphDebugPanel
            kind={demoBarKind}
            shown={demoBarShown}
            onKind={handleMorphKind}
            onEnter={handleMorphEnter}
            onReturn={handleMorphReturn}
            onClose={() => setDevToolsOpen(false)}
          />
          {/* 上下文 token 提示:从输入框里移到调试浮层,默认不出现在界面里 */}
          <div className="ctx-debug-float">
            <ContextDebugPill sessionId={state.sessionId} />
          </div>
        </>
      )}
      {/* 形变演示条:渲染一个真的 .ws-float-bar / .patch-nav,由 FLIP 编排自动从输入框滑入,
          返回时滑回。仅调试(Ctrl+Shift+H 面板),按钮无逻辑。 */}
      {demoBarShown && demoBarKind === "bigplan" && (
        <div className="ws-float-bar" data-wf="MorphDemoBar" data-morph-demo="1">
          <span className="ws-float-bar-label">
            <span className="ws-float-bar-dot" aria-hidden="true" />
            写作方向
          </span>
          <span className="ws-float-bar-spacer" />
          <button type="button" className="wf-btn primary">
            确认方向
          </button>
          <button type="button" className="wf-btn ghost">
            问我更多
          </button>
          <button type="button" className="wf-btn ghost">
            放弃本轮
          </button>
        </div>
      )}
      {demoBarShown && demoBarKind === "patch" && (
        <div className="patch-nav" data-wf="MorphDemoPatch" data-morph-demo="1">
          <span className="pn-dot" aria-hidden="true" />
          <span className="pn-label">
            修改 · <b>5</b> 处
          </span>
          <button type="button" className="pn-jump">
            <span>↑</span>上一处
          </button>
          <button type="button" className="pn-jump">
            <span>↓</span>下一处
          </button>
          <span style={{ flex: "1 1 auto" }} />
          <button type="button" className="pn-ghost">
            撤销全部
          </button>
          <button type="button" className="pn-commit">
            提交 ↵
          </button>
        </div>
      )}
      {/* 0603 拟人鼠标 overlay:覆盖局部修改(review reveal)+ 全文生成/重播(presentationRun)两场景,
          每帧扫描文档内 data-hc-lane 光标 DOM 自发现,叠加在打字光标之上。
          native 逐字打字由 presentationRun 驱动(生成后在 draft 态播放、含重播),
          故用它而非 content 状态作触发,避免错过真正的打字窗口。 */}
      <HumanCursorOverlay
        active={(effectivePatchRevealing || effectivePresentationRun != null) && !previewSource}
        scrollRef={docScrollRef}
      />
      <WorkspaceTooltip />
      {devToolsOpen && (
        <HumanCursorTuningPanel
          canReplay={reviewUiState.canReplayReviewReveal && inlinePatchReview}
          onReplay={handleRevealReplay}
        />
      )}
    </section>
  );
}
