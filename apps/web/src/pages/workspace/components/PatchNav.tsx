import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "./icons";

export interface PatchNavProps {
  remainingCount: number;
  totalCount: number;
  activePatchIndex: number;
  isSubmitting?: boolean;
  retryOnly?: boolean;
  /** 候选存在但正文锚点无法定位：只保留整轮提交/放弃，不显示虚假的处数与跳转。 */
  unrenderableOnly?: boolean;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onRejectAll: () => void;
  /** 按当前逐处裁决提交；已撤销的修改保持撤销(没动过的默认全部应用)。 */
  onCommit: () => void | Promise<void>;
}

/**
 * 审核区底部固定操作条:
 * [dot] [修改 · N 处] [↑上一处][↓下一处](仅 N>1 显示)
 * [flex spacer] [提交↵] [放弃全部]
 * (曾有「全部应用」逃生按钮;用户拍板移除——提交本身默认应用未裁决的全部修改,按钮冗余)
 */
export function PatchNav({
  remainingCount,
  totalCount,
  activePatchIndex,
  isSubmitting = false,
  retryOnly = false,
  unrenderableOnly = false,
  onJumpPrev,
  onJumpNext,
  onRejectAll,
  onCommit,
}: PatchNavProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const rejectAllButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRejectFocusRef = useRef(false);

  useEffect(() => {
    if (confirmOpen) {
      cancelButtonRef.current?.focus();
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        restoreRejectFocusRef.current = true;
        setConfirmOpen(false);
      };
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
    if (restoreRejectFocusRef.current) {
      rejectAllButtonRef.current?.focus();
      restoreRejectFocusRef.current = false;
    }
    return undefined;
  }, [confirmOpen]);

  const cancelRejectAll = () => {
    restoreRejectFocusRef.current = true;
    setConfirmOpen(false);
  };

  return (
    <div
      className={`patch-nav${confirmOpen ? " is-confirming" : ""}`}
      data-wf="PatchNav"
      data-review-fallback={unrenderableOnly || undefined}
      aria-busy={isSubmitting}
    >
      {confirmOpen ? (
        <div className="pn-confirm-inline" role="group" aria-label="确认放弃全部修改">
          <span className="pn-confirm-message">放弃后，本轮剩余修改都不会保留</span>
          <span className="pn-spacer" aria-hidden="true" />
          <button
            type="button"
            className="pn-confirm-action"
            onClick={() => {
              onRejectAll();
              setConfirmOpen(false);
            }}
          >
            确认放弃全部
          </button>
          <button
            ref={cancelButtonRef}
            type="button"
            className="pn-confirm-cancel"
            onClick={cancelRejectAll}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <span className="pn-dot" aria-hidden="true" />
          {retryOnly ? (
            <span className="pn-label">提交失败，候选待重试</span>
          ) : unrenderableOnly ? (
            <span className="pn-label">修改候选待确认</span>
          ) : (
            <span
              className="pn-label"
              title={remainingCount === totalCount ? undefined : `剩余 ${remainingCount} 处`}
            >
              剩余 · <b>{remainingCount}</b> 处
            </span>
          )}
          {/* 上/下一处:仅当修改位置多于 1 处时才有意义,单处时不渲染 */}
          {!retryOnly && !unrenderableOnly && totalCount > 1 && (
            <>
              <button
                type="button"
                className="pn-jump"
                onClick={onJumpPrev}
                disabled={activePatchIndex <= 0}
              >
                <span><ArrowUpIcon size={12} /></span>上一处
              </button>
              <button
                type="button"
                className="pn-jump"
                onClick={onJumpNext}
                title="快捷键：J"
                disabled={activePatchIndex >= totalCount - 1}
              >
                <span><ArrowDownIcon size={12} /></span>下一处
              </button>
            </>
          )}
          <span className="pn-spacer" aria-hidden="true" />
          {/* 顺序:提交在前(左)、撤销全部在后(右) */}
          <button
            type="button"
            className="pn-commit"
            onClick={onCommit}
            disabled={isSubmitting}
            title="提交剩余改动"
          >
            提交 ↵
          </button>
          {!retryOnly && (
            <button
              ref={rejectAllButtonRef}
              type="button"
              className="pn-ghost"
              onClick={() => setConfirmOpen(true)}
              disabled={isSubmitting}
            >
              放弃全部
            </button>
          )}
        </>
      )}
    </div>
  );
}
