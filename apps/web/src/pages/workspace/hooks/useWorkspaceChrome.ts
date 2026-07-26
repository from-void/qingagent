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
  reducedMotion: boolean;
  flushPendingDocSave: () => Promise<void>;
}) {
  const homeReturnTransitionRef = useRef(false);
  const homeReturnTimerRef = useRef<number | null>(null);
  const workspaceArrivePendingRef = useRef<boolean | null>(null);
  if (workspaceArrivePendingRef.current === null) {
    workspaceArrivePendingRef.current = Boolean(peekWorkspaceArrive());
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
    if (!workspaceArrivePendingRef.current) return;
    const view = input.viewRef.current;
    if (!view) return;

    let settleFrame = 0;
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

    // 到场编舞只负责把首页交接帧落到真实工作区，和数据水合门解耦。
    // 纸壳已在首帧就位；两帧后按原时序揭示 chrome，内容仍由自己的门单独放行。
    if (input.reducedMotion) reveal();
    else {
      settleFrame = requestAnimationFrame(() => {
        revealFrame = requestAnimationFrame(reveal);
      });
    }

    return () => {
      if (settleFrame) cancelAnimationFrame(settleFrame);
      if (revealFrame) cancelAnimationFrame(revealFrame);
      if (revealTimer) window.clearTimeout(revealTimer);
      view.classList.remove("ws-arrive-revealing");
    };
  }, [input.reducedMotion, input.viewRef]);

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
