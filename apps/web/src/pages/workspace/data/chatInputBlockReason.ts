import type { DocDimensions } from "./docDimensions";

export interface ChatInputBlockReason {
  toast: string;
  placeholder: string;
  durationMs?: number;
}

export const DEFAULT_CHAT_INPUT_PLACEHOLDER = "描述你想写的内容…";
export const HISTORY_CHAT_INPUT_BLOCK_REASON: ChatInputBlockReason = {
  toast: "正在看历史版本，回到当前版本后可继续对话",
  placeholder: "回到当前版本后可继续对话",
  durationMs: 3500,
};

export function getChatInputBlockReason(
  dim: DocDimensions,
  askUserInputDisabled: boolean,
  viewingHistory = false,
  hasAskUserCard = dim.overlay === "askUser",
): ChatInputBlockReason | null {
  if (viewingHistory) return HISTORY_CHAT_INPUT_BLOCK_REASON;

  if (askUserInputDisabled || (dim.overlay === "askUser" && hasAskUserCard)) {
    return {
      toast: "请先完成问卷",
      placeholder: "请先完成问卷",
    };
  }

  if (dim.content.kind === "pendingReview") {
    return {
      toast: "请先提交或撤销上方修改，再继续对话",
      placeholder: "先提交或撤销上方修改，再继续对话",
      durationMs: 3500,
    };
  }

  return null;
}
