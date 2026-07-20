// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekHomeArrive } from "../../new-session/transition/origin";
import { useWorkspaceChrome } from "./useWorkspaceChrome";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let handleBackHome: (() => Promise<void>) | null = null;

describe("useWorkspaceChrome 返回首页", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "#/workspace");
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    handleBackHome = null;
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("无 sessionId 仍先淡出 workspace，再交接首页原位渐出", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Harness));
    });

    await act(async () => {
      await handleBackHome?.();
    });

    const view = host.querySelector("#view-workspace");
    expect(view?.classList.contains("ws-returning")).toBe(true);
    expect(window.location.hash).toBe("#/workspace");

    act(() => vi.advanceTimersByTime(260));

    expect(window.location.hash).toBe("#/");
    expect(peekHomeArrive()).toMatchObject({
      source: "workspace",
      rect: { width: 800 },
    });
    expect(peekHomeArrive()?.sessionId).toBeUndefined();
  });
});

function Harness() {
  const viewRef = useRef<HTMLElement>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chrome = useWorkspaceChrome({
    viewRef,
    docScrollRef,
    chatScrollRef,
    sessionId: null,
    reducedMotion: false,
    flushPendingDocSave: async () => undefined,
  });
  handleBackHome = chrome.handleBackHome;
  return createElement(
    "section",
    { id: "view-workspace", ref: viewRef },
    createElement("div", { ref: docScrollRef }),
    createElement("div", { ref: chatScrollRef }),
  );
}
