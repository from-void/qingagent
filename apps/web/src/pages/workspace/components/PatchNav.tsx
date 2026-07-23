import { useState } from "react";

export interface PatchNavProps {
  remainingCount: number;
  totalCount: number;
  activePatchIndex: number;
  isSubmitting?: boolean;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onRejectAll: () => void;
  /** 按当前逐处裁决提交；已撤销的修改保持撤销。 */
  onCommit: () => void | Promise<void>;
  /** 忽略逐处裁决并采纳本轮全部修改；整篇改写误入逐处审阅时的逃生入口。 */
  onApplyAll?: () => void | Promise<void>;
}

/**
 * 审核区顶部固定操作条:
 * [dot] [修改 · N 处] [↑上一处][↓下一处](仅 N>1 显示)
 * [flex spacer] [提交↵] [全部应用] [撤销全部]
 */
export function PatchNav({
  remainingCount,
  totalCount,
  activePatchIndex,
  isSubmitting = false,
  onJumpPrev,
  onJumpNext,
  onRejectAll,
  onCommit,
  onApplyAll,
}: PatchNavProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="patch-nav" data-wf="PatchNav" aria-busy={isSubmitting}>
      <span className="pn-dot" aria-hidden="true" />
      <span
        className="pn-label"
        title={remainingCount === totalCount ? undefined : `剩余 ${remainingCount} 处`}
      >
        剩余 · <b>{totalCount}</b> 处
      </span>
      {/* 上/下一处:仅当修改位置多于 1 处时才有意义,单处时不渲染 */}
      {totalCount > 1 && (
        <>
          <button
            type="button"
            className="pn-jump"
            onClick={onJumpPrev}
            title="跳到上一处改动"
            disabled={activePatchIndex <= 0}
          >
            <span>↑</span>上一处
          </button>
          <button
            type="button"
            className="pn-jump"
            onClick={onJumpNext}
            title="跳到下一处改动 · J"
            disabled={activePatchIndex >= totalCount - 1}
          >
            <span>↓</span>下一处
          </button>
        </>
      )}
      <span style={{ flex: 1 }} />
      {/* 顺序:提交在前(左)、撤销全部在后(右) */}
      <button
        type="button"
        className="pn-commit"
        onClick={onCommit}
        disabled={isSubmitting}
        title="提交剩余全部改动"
      >
        提交 ↵
      </button>
      {onApplyAll && (
        <button
          type="button"
          className="pn-commit pn-apply-all"
          onClick={onApplyAll}
          disabled={isSubmitting}
          title="忽略逐处选择，应用本轮全部修改"
        >
          全部应用
        </button>
      )}
      <span style={{ position: "relative" }}>
        <button
          type="button"
          className="pn-ghost"
          onClick={() => setConfirmOpen(true)}
          disabled={isSubmitting}
          title="放弃全部剩余改动"
        >
          放弃全部
        </button>
        {confirmOpen && (
          <div className="pn-confirm">
            <span>放弃后，本轮剩余修改都不会保留</span>
            <button type="button" onClick={() => { onRejectAll(); setConfirmOpen(false); }}>确认放弃全部</button>
            <button type="button" onClick={() => setConfirmOpen(false)}>取消</button>
          </div>
        )}
      </span>
    </div>
  );
}
