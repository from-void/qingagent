import { useEffect, useRef, useState, type CSSProperties } from "react";

type TooltipPlacement = "top" | "bottom";

interface TooltipState {
  text: string;
  left: number;
  top: number;
  arrowLeft: number;
  placement: TooltipPlacement;
  ready: boolean;
}

type TooltipStyle = CSSProperties & {
  "--workspace-tooltip-arrow-left"?: string;
};

const HOVER_DELAY_MS = 160;
const VIEWPORT_GAP = 14;
const TARGET_GAP = 10;

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function findTooltipTarget(target: EventTarget | null, root: HTMLElement) {
  if (!(target instanceof Element)) return null;
  const titled = target.closest("[title]");
  if (!titled || !root.contains(titled)) return null;
  const text = titled.getAttribute("title")?.trim();
  return text ? titled : null;
}

export function WorkspaceTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.getElementById("view-workspace");
    if (!root) return undefined;

    const titleCache = new WeakMap<Element, string>();
    const activeRef: { current: Element | null } = { current: null };
    let showTimer: number | null = null;
    let rafId: number | null = null;

    const clearShowTimer = () => {
      if (showTimer !== null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    };

    const clearRaf = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const restoreTitle = (target: Element | null) => {
      if (!target) return;
      const cachedTitle = titleCache.get(target);
      if (cachedTitle && !target.hasAttribute("title")) {
        target.setAttribute("title", cachedTitle);
      }
    };

    const hide = () => {
      clearShowTimer();
      clearRaf();
      restoreTitle(activeRef.current);
      activeRef.current = null;
      setTooltip(null);
    };

    const refinePosition = (target: Element, text: string) => {
      const tooltipEl = tooltipRef.current;
      if (!tooltipEl || activeRef.current !== target) return;

      const targetRect = target.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      const canPlaceTop = targetRect.top >= tooltipRect.height + VIEWPORT_GAP + TARGET_GAP;
      const canPlaceBottom =
        window.innerHeight - targetRect.bottom >= tooltipRect.height + VIEWPORT_GAP + TARGET_GAP;
      const placement: TooltipPlacement = canPlaceTop || !canPlaceBottom ? "top" : "bottom";
      const targetCenter = targetRect.left + targetRect.width / 2;
      const left = clamp(
        targetCenter - tooltipRect.width / 2,
        VIEWPORT_GAP,
        window.innerWidth - tooltipRect.width - VIEWPORT_GAP,
      );
      const rawTop =
        placement === "top"
          ? targetRect.top - tooltipRect.height - TARGET_GAP
          : targetRect.bottom + TARGET_GAP;
      const top = clamp(
        rawTop,
        VIEWPORT_GAP,
        window.innerHeight - tooltipRect.height - VIEWPORT_GAP,
      );
      const arrowLeft = clamp(targetCenter - left, 12, tooltipRect.width - 12);

      setTooltip({
        text,
        left,
        top,
        arrowLeft,
        placement,
        ready: true,
      });
    };

    const showForTarget = (target: Element, immediate: boolean) => {
      const title = target.getAttribute("title") ?? titleCache.get(target) ?? "";
      const text = title.trim();
      if (!text) return;

      if (activeRef.current && activeRef.current !== target) {
        restoreTitle(activeRef.current);
      }
      activeRef.current = target;

      if (target.hasAttribute("title")) {
        titleCache.set(target, title);
        target.removeAttribute("title");
      }

      clearShowTimer();
      clearRaf();

      const show = () => {
        if (activeRef.current !== target) return;
        const targetRect = target.getBoundingClientRect();
        const initialPlacement: TooltipPlacement =
          targetRect.top > window.innerHeight - targetRect.bottom ? "top" : "bottom";
        setTooltip({
          text,
          left: targetRect.left + targetRect.width / 2,
          top: initialPlacement === "top" ? targetRect.top - TARGET_GAP : targetRect.bottom + TARGET_GAP,
          arrowLeft: 16,
          placement: initialPlacement,
          ready: false,
        });
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          refinePosition(target, text);
        });
      };

      if (immediate) {
        show();
      } else {
        showTimer = window.setTimeout(show, HOVER_DELAY_MS);
      }
    };

    const handlePointerOver = (event: PointerEvent) => {
      const target = findTooltipTarget(event.target, root);
      if (!target || activeRef.current === target) return;
      showForTarget(target, false);
    };

    const handlePointerOut = (event: PointerEvent) => {
      const active = activeRef.current;
      if (!active) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && active.contains(relatedTarget)) return;
      hide();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = findTooltipTarget(event.target, root);
      if (!target) return;
      showForTarget(target, true);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const active = activeRef.current;
      if (!active) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && active.contains(relatedTarget)) return;
      hide();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    root.addEventListener("pointerover", handlePointerOver, true);
    root.addEventListener("pointerout", handlePointerOut, true);
    root.addEventListener("focusin", handleFocusIn, true);
    root.addEventListener("focusout", handleFocusOut, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      root.removeEventListener("pointerover", handlePointerOver, true);
      root.removeEventListener("pointerout", handlePointerOut, true);
      root.removeEventListener("focusin", handleFocusIn, true);
      root.removeEventListener("focusout", handleFocusOut, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", handleKeyDown);
      clearShowTimer();
      clearRaf();
      restoreTitle(activeRef.current);
    };
  }, []);

  if (!tooltip) return null;

  const style: TooltipStyle = {
    left: tooltip.left,
    top: tooltip.top,
    "--workspace-tooltip-arrow-left": `${tooltip.arrowLeft}px`,
  };

  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      aria-hidden={!tooltip.ready}
      className={`workspace-tooltip${tooltip.ready ? " is-visible" : ""}`}
      data-placement={tooltip.placement}
      style={style}
    >
      {tooltip.text}
    </div>
  );
}
