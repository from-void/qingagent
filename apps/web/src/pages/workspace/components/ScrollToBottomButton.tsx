import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { ArrowDownIcon } from "./icons";

type ScrollMetrics = Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">;

export function isChatAwayFromBottom(el: ScrollMetrics): boolean {
  return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

export interface ScrollToBottomButtonProps {
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * 输入框是否已被右侧问卷/审批条「同体平移」接管而隐藏(inputHandedOff)。
   * P1:输入框不可见时,回底箭头不得悬浮(与 pill 同源)。
   */
  inputHidden?: boolean;
}

export function ScrollToBottomButton({ scrollRef, inputHidden = false }: ScrollToBottomButtonProps) {
  const [visible, setVisible] = useState(false);

  const updateVisible = useCallback(() => {
    const el = scrollRef.current;
    setVisible(Boolean(el && isChatAwayFromBottom(el)));
  }, [scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    updateVisible();
    if (!el) return;

    el.addEventListener("scroll", updateVisible, { passive: true });
    window.addEventListener("resize", updateVisible);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateVisible);
      resizeObserver.observe(el);
    }

    let raf = 0;
    const scheduleUpdate = () => {
      if (typeof window.requestAnimationFrame === "function") {
        raf = window.requestAnimationFrame(updateVisible);
        return;
      }
      updateVisible();
    };

    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(scheduleUpdate);
      mutationObserver.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    scheduleUpdate();
    return () => {
      el.removeEventListener("scroll", updateVisible);
      window.removeEventListener("resize", updateVisible);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (raf && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [scrollRef, updateVisible]);

  const handleClick = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  if (inputHidden || !visible) return null;

  return (
    <button
      type="button"
      className="ws-scrollbtn"
      aria-label="回到底部"
      title="回到底部"
      onClick={handleClick}
    >
      <ArrowDownIcon size={17} />
    </button>
  );
}
