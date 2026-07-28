import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { PatchMeta } from "../../data/patchMeta";
import {
  PatchFormatPopup,
  PatchStatePopup,
  patchReviewState,
  placePatchPopupByAnchorRect,
  renderOriginalDiff,
} from "./patchHover";
import { ReviewBlocksStatic } from "./reviewBlockDiff";

const PATCH_POPUP_HIDE_DELAY_MS = 200;

interface PatchHoverLayerProps {
  editor: Editor;
  patchMeta?: Map<string, PatchMeta>;
  onPatchVerdict?: (patchId: string, verdict: "accepted" | "rejected") => void;
}

type HoverTarget = {
  patchId: string;
  anchor: HTMLElement;
};

function containsEventTarget(node: Node, target: EventTarget | null): boolean {
  return typeof Node !== "undefined" && target instanceof Node && node.contains(target);
}

function closestPatchTarget(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-patch-id]");
  if (!el || !root.contains(el)) return null;
  return el;
}

function patchIsFormat(meta: PatchMeta | undefined, anchor: HTMLElement): boolean {
  const state = anchor.dataset.patchState;
  return state === "format" || meta?.kind === "markAdd" || meta?.kind === "markRemove";
}

export function PatchHoverLayer({
  editor,
  patchMeta,
  onPatchVerdict,
}: PatchHoverLayerProps) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);
  // 用 div(块级容器):原文可能是表格/图表等块内容,<span> 套块是非法内容模型。
  const popupRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showTarget = useCallback((anchor: HTMLElement) => {
    const patchId = anchor.dataset.patchId;
    if (!patchId) return;
    clearHideTimer();
    setTarget({ patchId, anchor });
  }, [clearHideTimer]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setTarget(null);
    }, PATCH_POPUP_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const handlePatchVerdict = useCallback(
    (patchId: string, verdict: "accepted" | "rejected") => {
      clearHideTimer();
      setTarget(null);
      onPatchVerdict?.(patchId, verdict);
    },
    [clearHideTimer, onPatchVerdict],
  );

  useEffect(() => {
    const root = editor.view.dom;
    const onMouseOver = (event: MouseEvent) => {
      const anchor = closestPatchTarget(event.target, root);
      if (!anchor) return;
      // 常规 granular 块由改动行/格/块自管局部原文；若另有 tone/背景/栏宽等外壳属性变化，
      // has-block-original-hover 统一由整块原文卡接管，块树内局部 popup 已在挂载时关闭。
      if (anchor.classList.contains("is-granular") && !anchor.classList.contains("has-block-original-hover")) return;
      if (target?.anchor === anchor && containsEventTarget(anchor, event.relatedTarget)) return;
      showTarget(anchor);
    };
    const onMouseOut = (event: MouseEvent) => {
      const anchor = closestPatchTarget(event.target, root);
      if (!anchor) return;
      const related = event.relatedTarget;
      if (containsEventTarget(anchor, related)) return;
      if (popupRef.current && containsEventTarget(popupRef.current, related)) return;
      scheduleHide();
    };
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseout", onMouseOut);
    return () => {
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mouseout", onMouseOut);
      clearHideTimer();
    };
  }, [clearHideTimer, editor, scheduleHide, showTarget, target?.anchor]);

  useLayoutEffect(() => {
    if (!target) {
      setStyle(undefined);
      return;
    }
    if (typeof window === "undefined") return;
    const root = editor.view.dom;
    const recompute = () => {
      if (!target.anchor.isConnected || !root.contains(target.anchor)) {
        setStyle(undefined);
        setTarget((current) => current?.anchor === target.anchor ? null : current);
        return;
      }
      const popup = popupRef.current;
      if (!popup) return;
      setStyle(placePatchPopupByAnchorRect(
        target.anchor.getBoundingClientRect(),
        popup.getBoundingClientRect(),
      ));
    };
    recompute();
    editor.on("transaction", recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(recompute);
    resizeObserver?.observe(target.anchor);
    if (popupRef.current) resizeObserver?.observe(popupRef.current);
    return () => {
      editor.off("transaction", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
      resizeObserver?.disconnect();
    };
  }, [editor, target]);

  if (!target || typeof document === "undefined") return null;

  const meta = patchMeta?.get(target.patchId);
  const hasBlockOriginal = Boolean(meta?.beforePmNodes && meta.beforePmNodes.length > 0);
  const isFormat = patchIsFormat(meta, target.anchor);
  const state = patchReviewState(
    meta,
    target.anchor.dataset.patchState === "delete" ? "delete" : "replace",
  );
  const popup = isFormat ? (
    <PatchFormatPopup
      meta={meta}
      patchId={target.patchId}
      onPatchVerdict={handlePatchVerdict}
    />
  ) : (
    <PatchStatePopup
      state={state}
      index={meta?.index}
      // 块级补丁携带原始 before PM node → 用 PmBlockView 渲成真内容(表格/图表/公式/嵌套列表所见即所得),
      // 而非把 markdown 源码散排;纯文本补丁仍走行内文本呈现。originalIsBlock 让 popup 走块级布局
      // (否则 <span> 里套 <div>/<table> 是非法 HTML 嵌套)。
      original={
        hasBlockOriginal
          ? <ReviewBlocksStatic nodes={meta!.beforePmNodes!} />
          : renderOriginalDiff(meta?.before ?? "") ?? meta?.before ?? ""
      }
      originalIsBlock={hasBlockOriginal}
      patchId={target.patchId}
      onPatchVerdict={handlePatchVerdict}
    />
  );

  const portalTarget = document.getElementById("view-workspace") ?? document.body;

  return createPortal(
    <div
      ref={popupRef}
      className="patch-hover-popup is-visible"
      style={style}
      onMouseEnter={clearHideTimer}
      onMouseOver={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      {popup}
    </div>,
    portalTarget,
  );
}
