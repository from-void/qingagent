import type { TableSelection } from "@qingagent/contract-ts";
import type { ChatChipSpec } from "../components/ChatInput";
import { runAfterPendingDocSave } from "./pendingDocSave";

export interface AiModifyTarget {
  label: string;
  suffix: string;
  blockId: string;
  from?: number;
  to?: number;
  selectionRefs?: string[];
  tableSelection?: TableSelection;
}

interface AiModifyBlockReason {
  toast: string;
}

export async function runAiModifyTarget(input: {
  target: AiModifyTarget;
  getBlockReason: () => AiModifyBlockReason | null;
  isTextRangeAllowed: (from: number, to: number) => boolean;
  flushPendingDocSave: () => Promise<void>;
  insertChip: (spec: ChatChipSpec) => boolean;
  onToast: (message: string) => void;
  onSaveFailure: (error: unknown) => void;
}): Promise<boolean> {
  const blocked = input.getBlockReason();
  if (blocked) {
    input.onToast(blocked.toast);
    return false;
  }

  const { target } = input;
  const hasSelectionRefs = Boolean(target.selectionRefs && target.selectionRefs.length > 0);
  if (
    target.tableSelection === undefined &&
    target.from !== undefined &&
    target.to !== undefined &&
    !hasSelectionRefs &&
    !input.isTextRangeAllowed(target.from, target.to)
  ) {
    input.onToast("暂不支持跨段落修改,请在同一段内选择");
    return false;
  }

  try {
    return await runAfterPendingDocSave({
      flushPendingDocSave: input.flushPendingDocSave,
      onFlushFailure: input.onSaveFailure,
      run: async () => {
        // 保存期间可能进入问卷、审阅或历史态，必须以最新状态再次门控。
        const blockedAfterSave = input.getBlockReason();
        if (blockedAfterSave) {
          input.onToast(blockedAfterSave.toast);
          return false;
        }
        const inserted = input.insertChip({
          kind: "sel",
          label: target.label.replace(/^"|"$/g, ""),
          suffix: target.suffix,
          from: target.from,
          to: target.to,
          blockId: target.blockId,
          selectionRefs: target.selectionRefs,
          tableSelection: target.tableSelection,
        });
        if (!inserted) return false;
        input.onToast("选段已加入输入框");
        return true;
      },
    });
  } catch {
    return false;
  }
}
