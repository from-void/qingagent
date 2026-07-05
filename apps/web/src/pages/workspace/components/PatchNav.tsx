import { useState } from "react";

export interface PatchNavProps {
  remainingCount: number;
  totalCount: number;
  activePatchIndex: number;
  canActOnCurrent: boolean;
  currentVerdict?: "accepted" | "rejected" | null;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onAcceptCurrent: () => void;
  onRejectCurrent: () => void;
  onRejectAll: () => void;
  onCommit: () => void;
}

/**
 * 审核区顶部固定操作条:
 * [dot] [修改 · N 处] [↑上一处][↓下一处](仅 N>1 显示) [flex spacer] [提交↵] [撤销全部]
 */
export function PatchNav({
  remainingCount,
  totalCount,
  activePatchIndex,
  canActOnCurrent,
  currentVerdict = null,
  onJumpPrev,
  onJumpNext,
  onAcceptCurrent,
  onRejectCurrent,
  onRejectAll,
  onCommit,
}: PatchNavProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="patch-nav" data-wf="PatchNav">
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
      <button
        type="button"
        className="pn-ghost"
        onClick={onAcceptCurrent}
        title="采纳当前改动"
        disabled={!canActOnCurrent || currentVerdict === "accepted"}
      >
        采纳此处
      </button>
      <button
        type="button"
        className="pn-ghost"
        onClick={onRejectCurrent}
        title="拒绝当前改动"
        disabled={!canActOnCurrent || currentVerdict === "rejected"}
      >
        拒绝此处
      </button>
      <span style={{ flex: 1 }} />
      {/* 顺序:提交在前(左)、撤销全部在后(右) */}
      <button
        type="button"
        className="pn-commit"
        onClick={onCommit}
        title="提交剩余全部改动"
      >
        提交 ↵
      </button>
      <span style={{ position: "relative" }}>
        <button
          type="button"
          className="pn-ghost"
          onClick={() => setConfirmOpen(true)}
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
