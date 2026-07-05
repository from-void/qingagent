import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PatchMeta, PatchMetaChange } from "../DocumentSnapshotView";
import { wordDiffSegments } from "../../data/protocol";

/** hover 卡片里的「原文」:对 old vs new 算 diff,只把真正改掉/删掉的片段标红删除线,
 *  未改的片段淡显作上下文。不再展示整段原文、也不展示「改为」(新内容已在正文里)。 */
export function renderOriginalDiff(oldText: string, newText: string): React.ReactNode {
  const segs = wordDiffSegments(oldText, newText);
  // 没有任何删除片段(纯新增)时,原文为空,直接不渲染
  if (!segs.some((seg) => seg.type === "del")) return null;
  return (
    <span className="patch-popup-orig">
      {segs.map((seg, i) => {
        if (seg.type === "ins") return null;
        if (seg.type === "same") return <span key={i} className="patch-popup-ctx">{seg.text}</span>;
        return <span key={i} className="patch-popup-del-seg">{seg.text}</span>;
      })}
    </span>
  );
}

const PATCH_POPUP_HIDE_DELAY_MS = 200;

interface PatchHoverFrameProps {
  className: string;
  patchId: string;
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
    const a = anchor.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 10;
    const margin = 8;
    // 垂直:优先上方;上方放不下则下方;再 clamp
    let top = a.top - p.height - gap;
    if (top < margin) top = Math.min(a.bottom + gap, vh - p.height - margin);
    top = Math.max(margin, top);
    // 水平:左对齐锚点;右溢出则回拉;再 clamp
    let left = a.left;
    if (left + p.width > vw - margin) left = vw - margin - p.width;
    left = Math.max(margin, left);
    setStyle({ position: "fixed", top, left, right: "auto", bottom: "auto", margin: 0 });
  }, [visible]);
  return { popupRef, style };
}

export function PatchHoverFrame({
  className,
  patchId,
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
  highlight: "高亮",
};

export function mixedPatchChanges(meta: PatchMeta | undefined): PatchMetaChange[] | null {
  const changes = meta?.changes ?? [];
  const hasContent = changes.some((change) => change.kind === "content");
  const hasMark = changes.some((change) => change.kind === "mark");
  return hasContent && hasMark ? changes : null;
}

function markChangeNames(change: Extract<PatchMetaChange, { kind: "mark" }>): string {
  const names = (change.marks ?? [])
    .map((mark) => PATCH_MARK_LABELS[mark.type] ?? mark.type)
    .filter(Boolean);
  if (names.length > 0) return names.join("/");
  return (change.label ?? "样式").replace(/^将/, "").replace(/^取消/, "") || "样式";
}

export function PatchPopupChanges({ changes }: { changes: readonly PatchMetaChange[] }) {
  return (
    <span className="patch-popup-change-list">
      {changes.map((change, index) => (
        <span className="patch-popup-change" key={`${change.kind}-${index}`}>
          <span className="patch-popup-bullet" aria-hidden="true">•</span>
          <span className="patch-popup-change-body">
            <span className="patch-popup-change-label">
              {change.kind === "content" ? "内容" : "格式"}:
            </span>{" "}
            <PatchPopupChangeSummary change={change} />
          </span>
        </span>
      ))}
    </span>
  );
}

function PatchPopupChangeSummary({ change }: { change: PatchMetaChange }) {
  if (change.kind === "mark") {
    return (
      <>
        {markChangeNames(change)}
        <span className="patch-popup-mark-op">
          ({change.op === "markAdd" ? "增加" : "移除"})
        </span>
      </>
    );
  }

  if (change.before && change.after) {
    return (
      <>
        <span className="patch-popup-old-text">{change.before}</span>
        <span className="patch-popup-arrow"> → </span>
        <span className="patch-popup-new-text">{change.after}</span>
      </>
    );
  }
  if (change.after) {
    return (
      <>
        新增 <span className="patch-popup-new-text">{change.after}</span>
      </>
    );
  }
  if (change.before) {
    return (
      <>
        删除 <span className="patch-popup-old-text">{change.before}</span>
      </>
    );
  }
  return <>内容有调整</>;
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
