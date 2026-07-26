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

export function useWorkspaceChrome(input: {
  viewRef: RefObject<HTMLElement | null>;
  docScrollRef: RefObject<HTMLDivElement | null>;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  hydrationReady: boolean;
  reducedMotion: boolean;
  flushPendingDocSave: () => Promise<void>;
}) {
  const homeReturnTransitionRef = useRef(false);
  const homeReturnTimerRef = useRef<number | null>(null);
  const workspaceArrivePendingRef = useRef<boolean | null>(null);
  if (workspaceArrivePendingRef.current === null) {
    // 首页交接与“直接打开既有会话”共用同一场揭示：前者有 arrive
    // 载荷，后者以 hydration waiting 本身作为待揭示信号；新建空白两者皆无。
    workspaceArrivePendingRef.current =
      Boolean(peekWorkspaceArrive()) || !input.hydrationReady;
  }

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

  useEffect(() => {
    const element = input.viewRef.current;
    const left = element?.querySelector<HTMLElement>(".ws-left");
    const wrap = element?.querySelector<HTMLElement>(".ws-input-wrap");
    if (!left || !wrap) return;
    const apply = () =>
      left.style.setProperty("--ws-input-h", `${wrap.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [input.viewRef]);

  useLayoutEffect(() => {
    if (!workspaceArrivePendingRef.current) return;
    const view = input.viewRef.current;
    if (!view) return;
    view.classList.add("ws-arriving");
    return () => {
      view.classList.remove("ws-arriving", "ws-arrive-revealing");
    };
  }, [input.viewRef]);

  useLayoutEffect(() => {
    if (!workspaceArrivePendingRef.current || !input.hydrationReady) return;
    const view = input.viewRef.current;
    if (!view) return;

    let revealFrame = 0;
    let revealTimer = 0;
    const reveal = () => {
      clearWorkspaceArrive();
      workspaceArrivePendingRef.current = false;
      view.classList.remove("ws-arriving");
      if (input.reducedMotion) return;
      view.classList.add("ws-arrive-revealing");
      revealTimer = window.setTimeout(
        () => view.classList.remove("ws-arrive-revealing"),
        760,
      );
    };

    // waiting 已经作为稳定首帧画过；ready 后只跨一个 rAF 开始唯一一次揭示。
    // 不再独立跑“2 rAF + 固定时刻”的自启动编舞。
    if (input.reducedMotion) reveal();
    else revealFrame = requestAnimationFrame(reveal);

    return () => {
      if (revealFrame) cancelAnimationFrame(revealFrame);
      if (revealTimer) window.clearTimeout(revealTimer);
      view.classList.remove("ws-arrive-revealing");
    };
  }, [input.hydrationReady, input.reducedMotion, input.viewRef]);

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
