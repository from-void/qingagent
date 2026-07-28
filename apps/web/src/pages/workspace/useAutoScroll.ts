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
  /** Expected final position of an unsettled programmatic scroll. */
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const settleProgrammaticScrollRafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    const before = el.scrollTop;
    programmaticScrollTargetRef.current = target;
    if (settleProgrammaticScrollRafRef.current !== null) {
      cancelAnimationFrame(settleProgrammaticScrollRafRef.current);
      settleProgrammaticScrollRafRef.current = null;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    const after = el.scrollTop;
    if (Math.abs(after - before) < 1 || Math.abs(after - target) < 1) {
      programmaticScrollTargetRef.current = null;
      return;
    }
    settleProgrammaticScrollRafRef.current = requestAnimationFrame(() => {
      settleProgrammaticScrollRafRef.current = null;
      if (programmaticScrollTargetRef.current === target) {
        programmaticScrollTargetRef.current = null;
      }
    });
  }, [containerRef]);

  useEffect(() => () => {
    if (settleProgrammaticScrollRafRef.current !== null) {
      cancelAnimationFrame(settleProgrammaticScrollRafRef.current);
    }
  }, []);

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
      const expectedTarget = programmaticScrollTargetRef.current;
      if (
        expectedTarget !== null &&
        Math.abs(el.scrollTop - expectedTarget) < 1
      ) {
        programmaticScrollTargetRef.current = null;
      } else if (expectedTarget !== null) {
        // The position moved somewhere other than the expected programmatic
        // target, so this is a real user scroll and must update follow state.
        programmaticScrollTargetRef.current = null;
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
          scrollToBottom();
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
  }, [containerRef, enabled, scrollToBottom]);

  return { scrollToBottom };
}
