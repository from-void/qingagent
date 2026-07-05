import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export interface UseAutoScrollOptions {
  enabled?: boolean;
}

/**
 * Auto-scroll a container to the bottom when new content is added,
 * as long as the user hasn't manually scrolled up.
 *
 * - Monitors scroll position to track `isAtBottom` (threshold ~50px)
 * - When content mutates and user is at bottom, auto-scrolls down
 * - When user scrolls up, stops following
 * - When user scrolls back to bottom, resumes following
 *
 * Uses `behavior: 'instant'` for programmatic scrolls to avoid the
 * race condition where CSS `scroll-behavior: smooth` causes animated
 * intermediate scroll events that flip `isAtBottom` to false.
 */
export function useAutoScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  options: UseAutoScrollOptions = {},
) {
  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  const isAtBottomRef = useRef(true);
  /** Flag to distinguish programmatic scrolls from user scrolls. */
  const programmaticScrollRef = useRef(false);

  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const threshold = 50;

    const updateIsAtBottom = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < threshold;
    };

    if (!enabled) {
      updateIsAtBottom();
      return;
    }

    updateIsAtBottom();

    const handleScroll = () => {
      // Skip isAtBottom recalculation for programmatic scrolls to avoid
      // the race where smooth-animated intermediate positions falsely
      // set isAtBottom to false.
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      updateIsAtBottom();
    };

    el.addEventListener("scroll", handleScroll, { passive: true });

    // Observe content changes with MutationObserver
    const observer = new MutationObserver(() => {
      if (enabledRef.current && isAtBottomRef.current) {
        // Use requestAnimationFrame to let DOM settle before scrolling
        requestAnimationFrame(() => {
          if (!enabledRef.current) return;
          programmaticScrollRef.current = true;
          el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
        });
      }
    });

    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      el.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [containerRef, enabled]);

  return { scrollToBottom };
}
