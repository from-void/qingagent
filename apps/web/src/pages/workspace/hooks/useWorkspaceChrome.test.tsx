// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peekHomeArrive,
  peekWorkspaceArrive,
  setWorkspaceArrive,
} from "../../new-session/transition/origin";
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

  it("到场态持续等 hydration ready，随后只启动一次揭示", async () => {
    setWorkspaceArrive({
      rect: { left: 20, top: 52, width: 800, height: 600 },
      x: 420,
      y: 120,
      sessionId: "session-existing",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(createElement(Harness, { hydrationReady: false }));
    });
    const view = host.querySelector("#view-workspace");
    expect(view?.classList.contains("ws-arriving")).toBe(true);
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    expect(view?.classList.contains("ws-arriving")).toBe(true);
    expect(peekWorkspaceArrive()).not.toBeNull();

    await act(async () => {
      root?.render(createElement(Harness, { hydrationReady: true }));
    });
    expect(view?.classList.contains("ws-arriving")).toBe(true);

    act(() => vi.advanceTimersByTime(16));
    expect(view?.classList.contains("ws-arriving")).toBe(false);
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(true);
    expect(peekWorkspaceArrive()).toBeNull();

    act(() => vi.advanceTimersByTime(760));
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(false);
  });

  it("直接打开既有会话也等 ready 后复用同一揭示，新建 ready 不受拖慢", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(createElement(Harness, { hydrationReady: false }));
    });
    const view = host.querySelector("#view-workspace");
    expect(view?.classList.contains("ws-arriving")).toBe(true);

    await act(async () => {
      root?.render(createElement(Harness, { hydrationReady: true }));
    });
    act(() => vi.advanceTimersByTime(16));
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(true);

    act(() => root?.unmount());
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Harness, { hydrationReady: true }));
    });
    expect(host.querySelector("#view-workspace")?.className).toBe("");
  });
});

function Harness({ hydrationReady = true }: { hydrationReady?: boolean }) {
  const viewRef = useRef<HTMLElement>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chrome = useWorkspaceChrome({
    viewRef,
    docScrollRef,
    chatScrollRef,
    sessionId: null,
    hydrationReady,
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
