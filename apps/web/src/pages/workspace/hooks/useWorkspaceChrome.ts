import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import { routeToHash } from "../../../shell";
import {
  clearWorkspaceArrive,
  computeWorkspaceDocRect,
  peekWorkspaceArrive,
  setHomeArrive,
} from "../../new-session/transition/origin";
import { workspaceSessionIdFromHash } from "../data/workspacePageView";

const INPUT_OCCUPANT_SELECTOR = [
  ".wf-input",
  ".askuser-overlay",
  ".cf-overlay",
  ".cf-record",
  ".qa-skill-menu",
  ".ws-taskpill-host",
  ".ws-taskpill-flyout",
].join(",");

const CHAT_BOTTOM_THRESHOLD = 50;

function isVisibleInputOccupant(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);
  const opacity = parseFloat(style.opacity);
  return style.display !== "none"
    && style.visibility !== "hidden"
    && (!Number.isFinite(opacity) || opacity > 0);
}

/**
 * 输入区所需留白 = 最上方可见输入控件到滚动区底边的距离 + wrap 的设计上留白。
 * 对普通输入框而言，这与「wrap 顶边到滚动区底边」等价；绝对定位的问卷、确认卡、
 * 技能/素材菜单和任务浮层则按自身真实顶边扩展占位。
 */
export function measureWorkspaceInputClearance(
  chat: HTMLElement,
  wrap: HTMLElement,
): number {
  const chatRect = chat.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const paddingTop = parseFloat(getComputedStyle(wrap).paddingTop) || 0;
  let occupantTop = wrapRect.top + paddingTop;

  for (const occupant of wrap.querySelectorAll<HTMLElement>(
    INPUT_OCCUPANT_SELECTOR,
  )) {
    if (!isVisibleInputOccupant(occupant)) continue;
    occupantTop = Math.min(occupantTop, occupant.getBoundingClientRect().top);
  }

  return Math.max(0, Math.ceil(chatRect.bottom - occupantTop + paddingTop));
}

export function useWorkspaceChrome(input: {
  viewRef: RefObject<HTMLElement | null>;
  docScrollRef: RefObject<HTMLDivElement | null>;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  reducedMotion: boolean;
  flushPendingDocSave: () => Promise<void>;
}) {
  const homeReturnTransitionRef = useRef(false);
  const homeReturnTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = input.viewRef.current;
    if (!element) return;
    const apply = () => {
      const scrollElement = input.docScrollRef.current;
      const measured = scrollElement?.getBoundingClientRect();
      const padTop = scrollElement
        ? parseFloat(getComputedStyle(scrollElement).paddingTop) || 0
        : 0;
      const rect =
        measured && measured.width > 0
          ? {
              left: measured.left,
              right: measured.right,
              top: measured.top + padTop,
            }
          : (() => {
              const fallback = computeWorkspaceDocRect();
              return {
                left: fallback.left,
                right: fallback.left + fallback.width,
                top: fallback.top,
              };
            })();
      element.style.setProperty("--doc-left", `${rect.left}px`);
      element.style.setProperty("--doc-right", `${rect.right}px`);
      element.style.setProperty("--doc-top", `${rect.top}px`);
      document.documentElement.style.setProperty(
        "--doc-left",
        `${rect.left}px`,
      );
      document.documentElement.style.setProperty(
        "--doc-right",
        `${rect.right}px`,
      );
      document.documentElement.style.setProperty("--doc-top", `${rect.top}px`);
    };
    const body = element.querySelector<HTMLElement>(".ws-body");
    apply();
    window.addEventListener("resize", apply);
    body?.addEventListener("scroll", apply, { passive: true });
    return () => {
      window.removeEventListener("resize", apply);
      body?.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--doc-left");
      document.documentElement.style.removeProperty("--doc-right");
      document.documentElement.style.removeProperty("--doc-top");
    };
  }, [input.docScrollRef, input.viewRef]);

  useLayoutEffect(() => {
    const element = input.viewRef.current;
    const left = element?.querySelector<HTMLElement>(".ws-left");
    const wrap = element?.querySelector<HTMLElement>(".ws-input-wrap");
    const chat = input.chatScrollRef.current;
    if (!left || !wrap || !chat) return;

    let stickToBottom =
      chat.scrollHeight - chat.scrollTop - chat.clientHeight
        < CHAT_BOTTOM_THRESHOLD;
    let lastClearance = -1;
    let frame = 0;
    let activeMotionCount = 0;

    const scrollToBottom = () => {
      if (typeof chat.scrollTo === "function") {
        chat.scrollTo({ top: chat.scrollHeight, behavior: "instant" });
      } else {
        chat.scrollTop = chat.scrollHeight;
      }
    };
    const apply = () => {
      const clearance = measureWorkspaceInputClearance(chat, wrap);
      if (clearance === lastClearance) return;
      const shouldStick = stickToBottom;
      lastClearance = clearance;
      left.style.setProperty("--ws-input-clearance", `${clearance}px`);
      if (shouldStick) scrollToBottom();
    };
    const scheduleApply = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply();
        if (activeMotionCount > 0) scheduleApply();
      });
    };
    const handleScroll = () => {
      stickToBottom =
        chat.scrollHeight - chat.scrollTop - chat.clientHeight
          < CHAT_BOTTOM_THRESHOLD;
    };
    const isMeasuredMotion = (event: Event) =>
      event.target instanceof HTMLElement
      && (event.target === wrap
        || event.target.matches(INPUT_OCCUPANT_SELECTOR));
    const handleMotionStart = (event: Event) => {
      if (!isMeasuredMotion(event)) return;
      activeMotionCount += 1;
      scheduleApply();
    };
    const handleMotionEnd = (event: Event) => {
      if (!isMeasuredMotion(event)) return;
      activeMotionCount = Math.max(0, activeMotionCount - 1);
      scheduleApply();
    };

    apply();
    chat.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", scheduleApply);
    wrap.addEventListener("transitionrun", handleMotionStart, true);
    wrap.addEventListener("transitionend", handleMotionEnd, true);
    wrap.addEventListener("transitioncancel", handleMotionEnd, true);
    wrap.addEventListener("animationstart", handleMotionStart, true);
    wrap.addEventListener("animationend", handleMotionEnd, true);
    wrap.addEventListener("animationcancel", handleMotionEnd, true);

    const observed = new Set<HTMLElement>();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleApply);
    const observeOccupants = () => {
      if (!resizeObserver) return;
      for (const target of [
        wrap,
        ...wrap.querySelectorAll<HTMLElement>(INPUT_OCCUPANT_SELECTOR),
      ]) {
        if (observed.has(target)) continue;
        observed.add(target);
        resizeObserver.observe(target);
      }
    };
    observeOccupants();

    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          observeOccupants();
          scheduleApply();
        });
    mutationObserver?.observe(wrap, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-portal"],
    });

    return () => {
      chat.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", scheduleApply);
      wrap.removeEventListener("transitionrun", handleMotionStart, true);
      wrap.removeEventListener("transitionend", handleMotionEnd, true);
      wrap.removeEventListener("transitioncancel", handleMotionEnd, true);
      wrap.removeEventListener("animationstart", handleMotionStart, true);
      wrap.removeEventListener("animationend", handleMotionEnd, true);
      wrap.removeEventListener("animationcancel", handleMotionEnd, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      left.style.removeProperty("--ws-input-clearance");
    };
  }, [input.chatScrollRef, input.viewRef]);

  useLayoutEffect(() => {
    if (!peekWorkspaceArrive()) return;
    const view = input.viewRef.current;
    if (!view) return;
    view.classList.add("ws-arriving");
    let firstFrame = 0;
    let secondFrame = 0;
    let timer = 0;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        clearWorkspaceArrive();
        view.classList.remove("ws-arriving");
        view.classList.add("ws-arrive-revealing");
        timer = window.setTimeout(
          () => view.classList.remove("ws-arrive-revealing"),
          760,
        );
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (timer) window.clearTimeout(timer);
      view.classList.remove("ws-arriving", "ws-arrive-revealing");
    };
  }, [input.viewRef]);

  useEffect(() => {
    const doc = input.docScrollRef.current;
    const chat = input.chatScrollRef.current;
    const view = input.viewRef.current;
    const timers = new WeakMap<HTMLElement, number>();
    const bind = (element: HTMLElement | null, onDoc = false) => {
      if (!element) return () => {};
      const onScroll = () => {
        element.classList.add("show-sb");
        const previous = timers.get(element);
        if (previous) window.clearTimeout(previous);
        timers.set(
          element,
          window.setTimeout(() => element.classList.remove("show-sb"), 800),
        );
        if (onDoc && view)
          view.classList.toggle("ws-doc-scrolled", element.scrollTop > 40);
      };
      element.addEventListener("scroll", onScroll, { passive: true });
      return () => element.removeEventListener("scroll", onScroll);
    };
    const unbindDoc = bind(doc, true);
    const unbindChat = bind(chat);
    return () => {
      unbindDoc();
      unbindChat();
    };
  }, [input.chatScrollRef, input.docScrollRef, input.viewRef]);

  const handleBackHome = useCallback(async () => {
    if (homeReturnTransitionRef.current) return;
    homeReturnTransitionRef.current = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error("home navigation doc save timed out")),
          300,
        );
        input.flushPendingDocSave().then(
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          },
        );
      });
    } catch (error) {
      console.error(
        "[workspace] failed to flush updateDoc before returning home",
        error,
      );
    }
    const sessionId =
      input.sessionId ?? workspaceSessionIdFromHash(window.location.hash);
    const goHome = () => {
      window.location.hash = routeToHash("home");
    };
    const rect = computeWorkspaceDocRect();
    input.viewRef.current?.classList.add("ws-returning");
    const handoff = () => {
      setHomeArrive({
        rect,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        source: "workspace",
        ...(sessionId ? { sessionId } : {}),
      });
      goHome();
    };
    if (input.reducedMotion) {
      handoff();
      return;
    }
    homeReturnTimerRef.current = window.setTimeout(handoff, 260);
  }, [
    input.flushPendingDocSave,
    input.reducedMotion,
    input.sessionId,
    input.viewRef,
  ]);

  useEffect(
    () => () => {
      if (homeReturnTimerRef.current !== null) {
        window.clearTimeout(homeReturnTimerRef.current);
      }
    },
    [],
  );

  return { handleBackHome };
}
