import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PatchMeta } from "../../data/patchMeta";

const PATCH_POPUP_HIDE_DELAY_MS = 200;

export type PatchReviewState = "replace" | "insert" | "delete";

/** 原文呈现:锚点粒度已在 core(proposalDiff)拆干净成纯增/纯删/覆盖三态,卡片一律
 *  不再做二次逐字 diff(那正是"绿色晚风"自相矛盾的病根)。覆盖/删除卡把整段原文划
 *  删除线;纯新增无原文(调用方 state==="insert" 时不渲染此节点)。 */
export function renderOriginalDiff(oldText: string): React.ReactNode {
  if (oldText === "") return null;
  return <span className="patch-popup-removed-text">{oldText}</span>;
}

interface PatchHoverFrameProps {
  className: string;
  patchId: string;
  patchState?: PatchReviewState;
  title?: string;
  children: React.ReactNode;
  popup: React.ReactNode;
}

function containsEventTarget(node: Node, target: EventTarget | null): boolean {
  return typeof Node !== "undefined" && target instanceof Node && node.contains(target);
}

/** hover 卡片定位:用 position:fixed + JS 实算坐标,**escape 任何祖先 overflow 裁剪**
 *  (审核区面板会横向裁掉绝对定位的卡片)。优先放锚点上方、左对齐;放不下翻到下方;
 *  超出右/下边界则回拉并 clamp 到视口内。在 useLayoutEffect 里测(paint 前,无闪烁)。 */
export function placePatchPopupByAnchorRect(
  anchorRect: DOMRect,
  popupRect: DOMRect,
): React.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 10;
  const margin = 8;
  let top = anchorRect.top - popupRect.height - gap;
  if (top < margin) top = Math.min(anchorRect.bottom + gap, vh - popupRect.height - margin);
  top = Math.max(margin, top);
  let left = anchorRect.left;
  if (left + popupRect.width > vw - margin) left = vw - margin - popupRect.width;
  left = Math.max(margin, left);
  return { position: "fixed", top, left, right: "auto", bottom: "auto", margin: 0 };
}

function usePopupPlacement<T extends HTMLElement>(visible: boolean) {
  const popupRef = useRef<T>(null);
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!visible) {
      setStyle(undefined);
      return;
    }
    const el = popupRef.current;
    if (!el || typeof window === "undefined") return;
    const anchor = el.parentElement;
    if (!anchor) return;
    setStyle(placePatchPopupByAnchorRect(anchor.getBoundingClientRect(), el.getBoundingClientRect()));
  }, [visible]);
  return { popupRef, style };
}

export function PatchHoverFrame({
  className,
  patchId,
  patchState,
  title,
  children,
  popup,
}: PatchHoverFrameProps) {
  const [popupVisible, setPopupVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { popupRef, style } = usePopupPlacement<HTMLSpanElement>(popupVisible);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showPopup = useCallback(() => {
    clearHideTimer();
    setPopupVisible(true);
  }, [clearHideTimer]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setPopupVisible(false);
    }, PATCH_POPUP_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => {
    return () => clearHideTimer();
  }, [clearHideTimer]);

  return (
    <span
      className={className}
      data-patch-id={patchId}
      data-patch-state={patchState}
      title={title}
      onMouseEnter={showPopup}
      onMouseLeave={(event) => {
        if (containsEventTarget(event.currentTarget, event.relatedTarget)) return;
        scheduleHide();
      }}
      onFocus={showPopup}
      onBlur={(event) => {
        if (containsEventTarget(event.currentTarget, event.relatedTarget)) return;
        scheduleHide();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        clearHideTimer();
        setPopupVisible(false);
      }}
    >
      {children}
      <span
        ref={popupRef}
        className={`patch-hover-popup${popupVisible ? " is-visible" : ""}`}
        style={style}
        onMouseEnter={showPopup}
        onMouseOver={showPopup}
        onMouseLeave={scheduleHide}
      >
        {popup}
      </span>
    </span>
  );
}

export function PatchHoverBlockFrame({
  className,
  patchId,
  patchState,
  title,
  children,
  popup,
}: PatchHoverFrameProps) {
  const [popupVisible, setPopupVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { popupRef, style } = usePopupPlacement<HTMLDivElement>(popupVisible);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showPopup = useCallback(() => {
    clearHideTimer();
    setPopupVisible(true);
  }, [clearHideTimer]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setPopupVisible(false);
    }, PATCH_POPUP_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => {
    return () => clearHideTimer();
  }, [clearHideTimer]);

  return (
    <div
      className={className}
      data-patch-id={patchId}
      data-patch-state={patchState}
      title={title}
      style={{ display: "block" }}
      onMouseEnter={showPopup}
      onMouseLeave={(event) => {
        if (containsEventTarget(event.currentTarget, event.relatedTarget)) return;
        scheduleHide();
      }}
      onFocus={showPopup}
      onBlur={(event) => {
        if (containsEventTarget(event.currentTarget, event.relatedTarget)) return;
        scheduleHide();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        clearHideTimer();
        setPopupVisible(false);
      }}
    >
      {children}
      <div
        ref={popupRef}
        className={`patch-hover-popup${popupVisible ? " is-visible" : ""}`}
        style={style}
        onMouseEnter={showPopup}
        onMouseOver={showPopup}
        onMouseLeave={scheduleHide}
      >
        {popup}
      </div>
    </div>
  );
}

const PATCH_MARK_LABELS: Record<string, string> = {
  bold: "加粗",
  italic: "斜体",
  underline: "下划线",
  strike: "删除线",
  code: "等宽",
  link: "链接",
  textColor: "文字颜色",
  highlight: "高亮",
};

export function patchReviewState(meta: PatchMeta | undefined, fallback: PatchReviewState): PatchReviewState {
  if (!meta) return fallback;
  if (meta.kind === "insert" || (meta.before === "" && meta.after !== "")) return "insert";
  if (meta.kind === "delete" || (meta.before !== "" && meta.after === "")) return "delete";
  return "replace";
}

function markNames(meta: PatchMeta | undefined): string {
  const names = (meta?.marks ?? [])
    .map((mark) => PATCH_MARK_LABELS[mark.type] ?? mark.type)
    .filter(Boolean);
  if (names.length > 0) return names.join("/");
  return (meta?.label ?? "样式").replace(/^将/, "").replace(/^取消/, "") || "样式";
}

export function PatchStatePopup({
  state,
  index,
  original,
  originalIsBlock,
  patchId,
  onPatchVerdict,
}: {
  state: PatchReviewState;
  index?: number;
  original?: React.ReactNode;
  /** original 是块级内容(如 ReviewBlocksStatic 渲的 <div>/表格),走块布局避免 <span> 套块的非法嵌套。 */
  originalIsBlock?: boolean;
  patchId: string;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
}) {
  const label = state === "replace" ? "替换" : state === "insert" ? "新增" : "删减";
  const blockOriginal =
    originalIsBlock === true ||
    (React.isValidElement(original) &&
      typeof original.type === "string" &&
      (original.type === "div" || original.type === "table" || original.type === "figure"));
  const originalNode = blockOriginal ? (
    <div className="patch-popup-original">
      <span className="patch-popup-label">原文</span>
      <div className="patch-popup-original-text">{original}</div>
    </div>
  ) : (
    <span className="patch-popup-original">
      <span className="patch-popup-label">原文</span>
      <span className="patch-popup-original-text">{original}</span>
    </span>
  );
  return (
    <>
      <span className="patch-popup-title">#{index ?? "?"} · {label}</span>
      {/* 纯新增:标题「#N · 新增」已足够,不再叠冗余「新增」徽章;非新增才展示被改/删原文 */}
      {state !== "insert" && originalNode}
      <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
    </>
  );
}

export function PatchFormatPopup({
  meta,
  patchId,
  onPatchVerdict,
}: {
  meta: PatchMeta | undefined;
  patchId: string;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
}) {
  const op = meta?.kind === "markRemove" ? "移除格式" : "新增格式";
  return (
    <>
      <span className="patch-popup-title">#{meta?.index ?? "?"} · {op}</span>
      <span className="patch-popup-note">{markNames(meta)}</span>
      <PatchPopupActions patchId={patchId} onPatchVerdict={onPatchVerdict} />
    </>
  );
}

export function PatchPopupActions({
  patchId,
  onPatchVerdict,
}: {
  patchId: string;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
}) {
  return (
    <span className="patch-popup-actions">
      <button
        type="button"
        className="patch-popup-btn"
        title="撤销这处改动"
        onClick={() => onPatchVerdict?.(patchId, "rejected")}
      >
        撤销
      </button>
    </span>
  );
}
