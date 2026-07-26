import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const VIEWPORT_GUTTER = 8;
const ANCHOR_GAP = 4;

export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement>,
  panelRef: RefObject<HTMLElement>,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: VIEWPORT_GUTTER,
    top: VIEWPORT_GUTTER,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelWidth = Math.max(rect.width, panel?.offsetWidth ?? 0);
      const panelHeight = panel?.offsetHeight ?? 0;
      const left = Math.min(
        Math.max(VIEWPORT_GUTTER, rect.left),
        Math.max(VIEWPORT_GUTTER, window.innerWidth - panelWidth - VIEWPORT_GUTTER),
      );
      const fitsBelow = rect.bottom + ANCHOR_GAP + panelHeight <= window.innerHeight - VIEWPORT_GUTTER;
      const top = fitsBelow
        ? rect.bottom + ANCHOR_GAP
        : Math.max(VIEWPORT_GUTTER, rect.top - panelHeight - ANCHOR_GAP);

      setStyle({
        position: "fixed",
        left,
        top,
        minWidth: rect.width,
        visibility: "visible",
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, panelRef]);

  return style;
}
