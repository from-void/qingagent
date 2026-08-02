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
  hasAskUserCard = false,
  pendingReviewResolutionAvailable = true,
): ChatInputBlockReason | null {
  if (viewingHistory) return HISTORY_CHAT_INPUT_BLOCK_REASON;

  if (askUserInputDisabled || (dim.overlay === "askUser" && hasAskUserCard)) {
    return {
      toast: "请先完成问卷",
      placeholder: "请先完成问卷",
    };
  }

  if (dim.content.kind === "pendingReview") {
    // pendingReview 已落库但候选明细没进前端时，提交/放弃都无从执行；
    // 此时不能再锁输入框，否则用户没有任何可自行脱出的入口。
    if (!pendingReviewResolutionAvailable) return null;
    return {
      toast: "请先提交或撤销上方修改，再继续对话",
      placeholder: "先提交或撤销上方修改，再继续对话",
      durationMs: 3500,
    };
  }

  return null;
}
