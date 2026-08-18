import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CoachMarkId } from "@qingagent/contract-ts";
import { Button } from "@qingagent/ui-kit";
import { useOnboardingSettings } from "./OnboardingSettingsContext";
import { PaperTip } from "./PaperTip";
import "./coachMark.css";

export type CoachMarkPlacement = "bottom-end" | "right" | "top-start" | "top-end";
type AnchorSource = HTMLElement | null | (() => HTMLElement | null);

interface CoachPosition {
  left: number;
  top: number;
  accent: string;
}

const VIEWPORT_GUTTER = 12;
const ANCHOR_GAP = 12;

function resolveAnchor(source: AnchorSource): HTMLElement | null {
  return typeof source === "function" ? source() : source;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function computePosition(
  anchor: DOMRect,
  bubble: DOMRect,
  placement: CoachMarkPlacement,
): Pick<CoachPosition, "left" | "top"> {
  let left = anchor.left;
  let top = anchor.top;
  if (placement === "bottom-end") {
    left = anchor.right - bubble.width;
    top = anchor.bottom + ANCHOR_GAP;
  } else if (placement === "right") {
    left = anchor.right + ANCHOR_GAP;
    top = anchor.top + Math.min(anchor.height * .58, anchor.height - 24) - bubble.height / 2;
  } else if (placement === "top-end") {
    left = anchor.right - bubble.width;
    top = anchor.top - bubble.height - ANCHOR_GAP;
  } else {
    left = anchor.left;
    top = anchor.top - bubble.height - ANCHOR_GAP;
  }
  return {
    left: clamp(left, VIEWPORT_GUTTER, window.innerWidth - bubble.width - VIEWPORT_GUTTER),
    top: clamp(top, VIEWPORT_GUTTER, window.innerHeight - bubble.height - VIEWPORT_GUTTER),
  };
}

export function CoachMark({
  id,
  anchor,
  visible,
  placement,
  title,
  children,
  onSeen,
}: {
  id: CoachMarkId;
  anchor: AnchorSource;
  visible: boolean;
  placement: CoachMarkPlacement;
  title: string;
  children: ReactNode;
  onSeen?: () => void | Promise<void>;
}) {
  const onboarding = useOnboardingSettings();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CoachPosition | null>(null);
  const active = visible && onboarding.state !== null && !onboarding.coachSeen.has(id);

  useLayoutEffect(() => {
    if (!active) {
      setPosition(null);
      return;
    }
    let raf = 0;
    let lastGeometry = "";
    const update = () => {
      const anchorElement = resolveAnchor(anchor);
      const bubble = bubbleRef.current;
      if (anchorElement && bubble) {
        const anchorRect = anchorElement.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const geometry = [
          anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height,
          bubbleRect.width, bubbleRect.height, window.innerWidth, window.innerHeight,
        ].join(":");
        if (geometry !== lastGeometry) {
          lastGeometry = geometry;
          const next = computePosition(anchorRect, bubbleRect, placement);
          const accent = getComputedStyle(anchorElement).getPropertyValue("--qj-cinnabar").trim();
          setPosition({ ...next, accent });
        }
      }
      raf = window.requestAnimationFrame(update);
    };
    raf = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(raf);
  }, [active, anchor, placement]);

  useEffect(() => {
    if (!active) return;
    const anchorElement = resolveAnchor(anchor);
    if (!anchorElement) return;
    const handleAnchorClick = () => {
      void onboarding.markCoachSeen(id).then((saved) => {
        if (saved) void onSeen?.();
      });
    };
    anchorElement.addEventListener("click", handleAnchorClick, true);
    return () => anchorElement.removeEventListener("click", handleAnchorClick, true);
  }, [active, anchor, id, onboarding, onSeen]);

  if (!active) return null;

  const dismiss = async () => {
    const saved = await onboarding.markCoachSeen(id);
    if (!saved) return;
    await onSeen?.();
    resolveAnchor(anchor)?.focus({ preventScroll: true });
  };
  const style: CSSProperties = {
    left: position?.left ?? VIEWPORT_GUTTER,
    top: position?.top ?? VIEWPORT_GUTTER,
    visibility: position ? "visible" : "hidden",
  };

  return createPortal(
    <PaperTip
      ref={bubbleRef}
      className="coach-mark"
      data-coach-mark={id}
      data-placement={placement}
      style={style}
      role="note"
      title={title}
      accent={position?.accent || undefined}
      actions={(
        <Button type="button" variant="ghost" size="small" onClick={() => void dismiss()}>
          知道了
        </Button>
      )}
    >
      {children}
    </PaperTip>,
    document.body,
  );
}
