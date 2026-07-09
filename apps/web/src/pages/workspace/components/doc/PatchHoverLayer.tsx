import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { PatchMeta } from "../DocumentSnapshotView";
import {
  PatchFormatPopup,
  PatchStatePopup,
  patchReviewState,
  placePatchPopupByAnchorRect,
  renderOriginalDiff,
} from "./patchHover";

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
  const popupRef = useRef<HTMLSpanElement>(null);
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

  useEffect(() => {
    const root = editor.view.dom;
    const onMouseOver = (event: MouseEvent) => {
      const anchor = closestPatchTarget(event.target, root);
      if (!anchor) return;
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
    const popup = popupRef.current;
    if (!popup || typeof window === "undefined") return;
    setStyle(placePatchPopupByAnchorRect(
      target.anchor.getBoundingClientRect(),
      popup.getBoundingClientRect(),
    ));
  }, [target]);

  if (!target || typeof document === "undefined") return null;

  const meta = patchMeta?.get(target.patchId);
  const isFormat = patchIsFormat(meta, target.anchor);
  const state = patchReviewState(
    meta,
    target.anchor.dataset.patchState === "delete" ? "delete" : "replace",
  );
  const popup = isFormat ? (
    <PatchFormatPopup
      meta={meta}
      patchId={target.patchId}
      onPatchVerdict={onPatchVerdict}
    />
  ) : (
    <PatchStatePopup
      state={state}
      index={meta?.index}
      original={renderOriginalDiff(meta?.before ?? "") ?? meta?.before ?? ""}
      patchId={target.patchId}
      onPatchVerdict={onPatchVerdict}
    />
  );

  const portalTarget = document.getElementById("view-workspace") ?? document.body;

  return createPortal(
    <span
      ref={popupRef}
      className="patch-hover-popup is-visible"
      style={style}
      onMouseEnter={clearHideTimer}
      onMouseOver={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      {popup}
    </span>,
    portalTarget,
  );
}
