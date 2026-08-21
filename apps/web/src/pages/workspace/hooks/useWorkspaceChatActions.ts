import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Editor } from "@tiptap/react";
import type { PmDoc } from "@qingagent/pm-schema";
import { useToast } from "../../../system";
import { validateCommand } from "../../../system/validators";
import { goConfigureModel } from "../../../system/modelKeyGate";
import type {
  ActiveDocumentTarget,
  Command,
} from "@qingagent/contract-ts";
import type { ChatInputHandle } from "../data/chatInputTypes";
import { attachmentFileKey } from "../components/ChatInput";
import {
  canRetryStreamError,
  shouldStickStreamErrorToast,
  streamErrorActionLabel,
  streamErrorToastMessage,
  streamErrorToastRole,
  streamErrorToastTone,
} from "../components/streamErrorPresenter";
import type { DocDimensions } from "../data/docDimensions";
import { getChatInputBlockReason } from "../data/chatInputBlockReason";
import { newClientMessageId } from "../data/clientMessageId";
import { buildCancelStreamCommands } from "../data/workspacePageView";
import { runAfterPendingDocSave } from "../data/pendingDocSave";
import { UploadAssetError } from "../data/uploadAsset";
import {
  rollbackOptimisticChatSend,
  toContractChip,
  uploadFiles,
} from "../data/sessionFrameGuards";
import { staleTableSelectionChipIndices } from "../data/tableSelectionFreshness";
import type { ServerStream } from "../data/serverStream";
import {
  MATERIAL_PARSE_INCOMPLETE_REASON,
  MATERIAL_PARSE_SEND_FAILED_REASON,
  type UploadedAsset,
} from "../data/useMaterialParseTracker";
import {
  selectPatches,
  type WorkspaceAction,
  type WorkspaceState,
} from "../data/workspaceState";
import type { AssetSource } from "../data/sources";

const STREAM_ERROR_TOAST_KEY = "workspace-stream-error";

/**
 * 一次输入提交从点亮 sendPending 到真正 POST sendMessage 之间会跨越保存、上传、建会话等
 * 多个异步步骤。generation 是这条编排链的 turn 级闸门：停止时递增一次即可让旧链在
 * 最终派发前失效，避免 cancel 已完成后旧链又启动一个新的 agent turn。
 */
export interface WorkspaceTurnDispatchGate {
  generation: number;
  sessionId: string | null;
}

export interface WorkspaceTurnDispatchToken {
  generation: number;
  sessionId: string | null;
}

export function beginWorkspaceTurnDispatch(
  gate: WorkspaceTurnDispatchGate,
  sessionId: string | null,
): WorkspaceTurnDispatchToken {
  gate.generation += 1;
  gate.sessionId = sessionId;
  return { generation: gate.generation, sessionId };
}

export function cancelWorkspaceTurnDispatch(
  gate: WorkspaceTurnDispatchGate,
  sessionId: string | null = gate.sessionId,
): void {
  gate.generation += 1;
  gate.sessionId = sessionId;
}

export function isWorkspaceTurnDispatchCurrent(
  gate: WorkspaceTurnDispatchGate,
  token: WorkspaceTurnDispatchToken,
): boolean {
  return (
    gate.generation === token.generation &&
    gate.sessionId === token.sessionId
  );
}

export async function prepareAndDispatchWorkspaceTurn<T>(input: {
  gate: WorkspaceTurnDispatchGate;
  token: WorkspaceTurnDispatchToken;
  prepare: () => Promise<T>;
  dispatch: (prepared: T) => Promise<unknown>;
}): Promise<"sent" | "cancelled"> {
  const prepared = await input.prepare();
  if (!isWorkspaceTurnDispatchCurrent(input.gate, input.token)) {
    return "cancelled";
  }
  await input.dispatch(prepared);
  return "sent";
}

export async function cancelWorkspaceGeneration(input: {
  stream: Pick<ServerStream, "cancel"> | null;
  sessionId: string | null;
  streamIds: readonly string[];
  setSendPending: Dispatch<SetStateAction<boolean>>;
  showToast: (message: string, durationMs?: number) => void;
}): Promise<void> {
  const { stream, sessionId, streamIds, setSendPending, showToast } = input;
  // 停止按钮可能由 sendPending 提前点亮；无论 start 帧是否已到，都先恢复输入态。
  setSendPending(false);
  if (!stream) {
    showToast("连接还没准备好");
    return;
  }

  const commands = buildCancelStreamCommands(sessionId, streamIds);
  if (commands.length === 0) {
    // 新会话的异步准备链可能尚未拿到 sessionId；上层 turn 闸门已经完成本地终止，
    // 此时没有服务端命令可发也是成功停止，不能误报“没有任务”。
    showToast("已中断");
    return;
  }
  for (const command of commands) {
    try {
      validateCommand(command);
    } catch (error) {
      console.error("[workspace] cancelStream validation failed", error);
      showToast("操作失败，请重试");
      return;
    }
  }

  try {
    // 统一由 ServerStream 完成本地终止投影和服务端命令下发，避免两个阶段分叉。
    await stream.cancel(commands);
    showToast("已中断");
  } catch (error) {
    console.error("[workspace] cancelStream failed", error);
    showToast("停止失败 · 请重试");
  }
}

export function useWorkspaceChatActions(input: {
  dim: DocDimensions;
  askUserInputDisabled: boolean;
  tiptapEditor: Editor | null;
  state: WorkspaceState;
  stateRef: MutableRefObject<WorkspaceState>;
  streamRef: MutableRefObject<ServerStream | null>;
  chatInputRef: MutableRefObject<ChatInputHandle | null>;
  handleSubmitChatRef: MutableRefObject<() => void>;
  fillTemplatePromiseRef: MutableRefObject<Promise<void> | null>;
  lastRetriableSendRef: MutableRefObject<Extract<
    Command,
    { kind: "sendMessage" }
  > | null>;
  reviewCloseInFlightRef: MutableRefObject<Promise<void> | null>;
  restoreExistingSessionIdRef: MutableRefObject<string | null>;
  turnDispatchGateRef: MutableRefObject<WorkspaceTurnDispatchGate>;
  dispatch: Dispatch<WorkspaceAction>;
  setPreviewSource: Dispatch<SetStateAction<AssetSource | null>>;
  setSendPending: Dispatch<SetStateAction<boolean>>;
  flushPendingDocSave: () => Promise<void>;
  markMaterialParsing: (assets: UploadedAsset[]) => number | null;
  markMaterialParsingTurnError: (turnKey: number, reason: string) => void;
  materialParsingTurnKeyRef: MutableRefObject<number | null>;
  ensureSessionId: (stream: ServerStream) => Promise<string>;
  showToast: (message: string, durationMs?: number) => void;
  toast: ReturnType<typeof useToast>;
  handleBackHome: () => void;
  restoreExistingSession: (sessionId: string) => Promise<unknown>;
  /** 用户点击发送时界面激活的文档；服务端据此生成仅本轮有效的路由上下文。 */
  activeDocument: ActiveDocumentTarget;
}) {
  const {
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
    activeDocument,
  } = input;

  const handleSubmitChat = useCallback(() => {
    const blockReason = getChatInputBlockReason(
      dim,
      askUserInputDisabled,
      stateRef.current.viewingVersion !== null,
      undefined,
      selectPatches(stateRef.current).length > 0,
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

    const hasTableSelectionChip = snap.chips.some(
      (chip) => chip.tableSelection !== undefined,
    );
    if (hasTableSelectionChip) {
      const currentDoc =
        (tiptapEditor?.getJSON() as unknown as PmDoc | undefined) ??
        stateRef.current.doc?.pmDoc;
      const staleIndices = currentDoc
        ? staleTableSelectionChipIndices(snap, currentDoc)
        : snap.chips.flatMap((chip, index) =>
            chip.tableSelection ? [index] : [],
          );
      if (staleIndices.length > 0) {
        [...staleIndices]
          .sort((a, b) => b - a)
          .forEach((index) => {
            chatInputRef.current?.removeChipAt(index);
          });
        showToast("表格已变化,请重新选择");
        return;
      }
    }

    const keepMessageCount = stateRef.current.messages.length;
    const dispatchToken = beginWorkspaceTurnDispatch(
      turnDispatchGateRef.current,
      stateRef.current.sessionId,
    );

    // Optimistic UI: add user message bubble to chat.
    // When chips are present, use richText (which includes {{chip:N}}
    // markers) as the body so ChatMessageList can render chips inline
    // with text. The server still receives the clean `snap.text`.
    const displayBody =
      snap.chips.length > 0 && snap.richText ? snap.richText : snap.text;
    // 乐观气泡与服务端直播 user 帧共用同一 id(经 clientMessageId 传给后端):
    // reducer 按 id 去重合一,且重进重放(after=0)时 FrameLog 里有用户帧,气泡不消失。
    const clientMessageId = newClientMessageId();
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
      await prepareAndDispatchWorkspaceTurn({
        gate: turnDispatchGateRef.current,
        token: dispatchToken,
        prepare: async () => {
          // 模板填充在途时先等它落定(成败都等,失败自身已 toast):否则 sendMessage 可能先被服务端
          // 处理并置 streamId,骨架 updateDoc 随后被拒、模板内容永久丢失(review #6)。
          if (fillTemplatePromiseRef.current) {
            await fillTemplatePromiseRef.current.catch(() => {});
          }
          if (
            !isWorkspaceTurnDispatchCurrent(
              turnDispatchGateRef.current,
              dispatchToken,
            )
          ) {
            throw new Error("workspace turn dispatch cancelled");
          }
          return runAfterPendingDocSave({
            flushPendingDocSave,
            run: async () => {
              if (
                !isWorkspaceTurnDispatchCurrent(
                  turnDispatchGateRef.current,
                  dispatchToken,
                )
              ) {
                throw new Error("workspace turn dispatch cancelled");
              }
              // 上传必须先绑定稳定会话归属；删除墓碑落下后服务端会拒绝继续接纳资源。
              const sessionId = await ensureSessionId(stream);
              const uploadedAssets = await uploadFiles(filesToUpload, sessionId);
              if (
                !isWorkspaceTurnDispatchCurrent(
                  turnDispatchGateRef.current,
                  dispatchToken,
                )
              ) {
                throw new Error("workspace turn dispatch cancelled");
              }
              const fileIds = uploadedAssets.map((asset) => asset.fileId);

              // 上传已落定:把真实 fileId 回填进 attach chip 的 resourceRef,
              // 出站命令与乐观气泡同源(乐观帧先到先赢,服务端回帧不再覆盖,
              // 留着 att- 占位 id 会让气泡图片缩略图永远 404)。
              const uploadedByKey = new Map(
                filesToUpload.map((file, index) => [
                  attachmentFileKey(file),
                  uploadedAssets[index]?.fileId,
                ]),
              );
              const resolvedSpecs = snap.chips.map((spec) => {
                if (spec.kind !== "attach" || spec.resourceId || !spec.attachmentId) return spec;
                const fileId = uploadedByKey.get(spec.attachmentId);
                return fileId ? { ...spec, resourceId: fileId } : spec;
              });
              const contractChips = resolvedSpecs.map(toContractChip);
              dispatch({
                kind: "chatChipsResolved",
                messageId: clientMessageId,
                chips: contractChips,
              });

              if (
                !isWorkspaceTurnDispatchCurrent(
                  turnDispatchGateRef.current,
                  dispatchToken,
                )
              ) {
                throw new Error("workspace turn dispatch cancelled");
              }
              const command: Extract<Command, { kind: "sendMessage" }> = {
                kind: "sendMessage",
                data: {
                  sessionId,
                  text: snap.text,
                  skills: snap.skills,
                  chips: contractChips,
                  fileIds,
                  clientMessageId,
                  activeDocument,
                  // richText({{chip:N}} 原位):服务端据此内联展开给模型 + 作气泡体(WYSIWYG)。
                  ...(snap.chips.length > 0 && snap.richText
                    ? { richText: snap.richText }
                    : {}),
                },
              };
              await reviewCloseInFlightRef.current;
              return { command, uploadedAssets };
            },
          });
        },
        dispatch: async ({ command, uploadedAssets }) => {
          // 只有仍属当前 turn 的链路才进入服务端；被停止的旧链不会在稍后重新点亮 start。
          const materialTurnKey = markMaterialParsing(uploadedAssets);
          materialParsingTurnKeyRef.current = materialTurnKey;
          lastRetriableSendRef.current = command;
          try {
            await stream.sendCommand(command);
          } catch (error) {
            if (materialTurnKey !== null) {
              markMaterialParsingTurnError(
                materialTurnKey,
                MATERIAL_PARSE_SEND_FAILED_REASON,
              );
            }
            if (materialParsingTurnKeyRef.current === materialTurnKey) {
              materialParsingTurnKeyRef.current = null;
            }
            throw error;
          }
        },
      });
    };

    send().catch((e) => {
      // 停止后的旧准备链即使晚到失败，也不应回滚已恢复的输入态或弹伪失败。
      if (
        !isWorkspaceTurnDispatchCurrent(
            turnDispatchGateRef.current,
            dispatchToken,
        )
      ) {
        return;
      }
      console.error("[workspace] sendMessage failed", e);
      const uploadError = e instanceof UploadAssetError ? e : null;
      rollbackOptimisticChatSend({
        dispatch,
        chatInput: chatInputRef.current,
        snapshot: snap,
        keepMessageCount,
        setSendPending,
        showToast: uploadError ? () => undefined : showToast,
        error: e,
      });
      if (uploadError) {
        toast.show({
          message: uploadError.message,
          tone: "warn",
          sticky: true,
          role: "alert",
          dedupeKey: "material-upload-failed",
          action: {
            label: uploadError.retryable ? "重试" : "重新选择",
            onClick: () => {
              if (uploadError.retryable) handleSubmitChatRef.current();
              else chatInputRef.current?.chooseFiles();
            },
          },
        });
      }
    });
  }, [
    askUserInputDisabled,
    dim,
    ensureSessionId,
    flushPendingDocSave,
    markMaterialParsing,
    markMaterialParsingTurnError,
    showToast,
    tiptapEditor,
    toast,
    activeDocument,
  ]);
  // 让 chatInputBus.send 的订阅者拿到最新 handleSubmitChat(每渲染同步)。
  handleSubmitChatRef.current = handleSubmitChat;

  const handleRetryDrafting = useCallback(() => {
    const stream = streamRef.current;
    const command = lastRetriableSendRef.current;
    if (!stream || !command) {
      showToast("没有可重试的上一条消息");
      return;
    }
    beginWorkspaceTurnDispatch(
      turnDispatchGateRef.current,
      stateRef.current.sessionId,
    );
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
      if (
        streamError.kind === "docWriteConflict" ||
        streamError.action === "reload"
      ) {
        return { label: actionLabel, onClick: () => window.location.reload() };
      }
      if (
        streamError.action === "check_balance" ||
        streamError.action === "check_model_settings"
      ) {
        return {
          label: actionLabel,
          onClick: () => goConfigureModel(handleBackHome),
        };
      }
      if (
        streamError.kind === "draftingFailed" &&
        canRetryStreamError(streamError)
      ) {
        return { label: actionLabel, onClick: handleRetryDrafting };
      }
      if (
        streamError.kind === "failed" &&
        canRetryStreamError(streamError) &&
        restoreExistingSessionIdRef.current
      ) {
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
  }, [
    handleBackHome,
    handleRetryDrafting,
    restoreExistingSession,
    state.streamError,
    toast,
  ]);

  const handleCancelActiveStream = useCallback(() => {
    // 先封住本地尚在保存/上传/建会话的旧 turn，再下发服务端 cancel；标记会持续到下一次
    // beginWorkspaceTurnDispatch，不能只 abort 当前一个 await 步骤。
    cancelWorkspaceTurnDispatch(
      turnDispatchGateRef.current,
      stateRef.current.sessionId,
    );
    const materialTurnKey = materialParsingTurnKeyRef.current;
    if (materialTurnKey !== null) {
      markMaterialParsingTurnError(
        materialTurnKey,
        MATERIAL_PARSE_INCOMPLETE_REASON,
      );
      materialParsingTurnKeyRef.current = null;
    }
    const current = stateRef.current;
    void cancelWorkspaceGeneration({
      stream: streamRef.current,
      sessionId: current.sessionId,
      streamIds: current.activeStreamIds.slice(),
      setSendPending,
      showToast,
    });
  }, [markMaterialParsingTurnError, showToast]);

  return {
    handleCancelActiveStream,
    handleSubmitChat,
  };
}
