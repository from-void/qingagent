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
import type { Command } from "@qingagent/contract-ts";
import type { ChatInputHandle } from "../components/ChatInput";
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
import { buildCancelStreamCommands } from "../data/workspacePageView";
import { runAfterPendingDocSave } from "../data/pendingDocSave";
import {
  rollbackOptimisticChatSend,
  toContractChip,
  uploadFiles,
} from "../data/sessionFrameGuards";
import { staleTableSelectionChipIndices } from "../data/tableSelectionFreshness";
import type { ServerStream } from "../data/serverStream";
import type { UploadedAsset } from "../data/useMaterialParseTracker";
import type { WorkspaceAction, WorkspaceState } from "../data/workspaceState";
import type { AssetSource } from "../data/sources";

const STREAM_ERROR_TOAST_KEY = "workspace-stream-error";

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
  dispatch: Dispatch<WorkspaceAction>;
  setPreviewSource: Dispatch<SetStateAction<AssetSource | null>>;
  setSendPending: Dispatch<SetStateAction<boolean>>;
  flushPendingDocSave: () => Promise<void>;
  markMaterialParsing: (assets: UploadedAsset[]) => void;
  ensureSessionId: (stream: ServerStream) => Promise<string>;
  showToast: (message: string, durationMs?: number) => void;
  toast: ReturnType<typeof useToast>;
  handleBackHome: () => void;
  restoreExistingSession: (sessionId: string) => Promise<unknown>;
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
  } = input;

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
              ...(snap.chips.length > 0 && snap.richText
                ? { richText: snap.richText }
                : {}),
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
  }, [
    askUserInputDisabled,
    dim,
    ensureSessionId,
    flushPendingDocSave,
    markMaterialParsing,
    showToast,
    tiptapEditor,
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
  return { handleCancelActiveStream, handleSubmitChat };
}
