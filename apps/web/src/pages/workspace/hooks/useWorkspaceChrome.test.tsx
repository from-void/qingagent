// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peekHomeArrive,
  peekWorkspaceArrive,
  setWorkspaceArrive,
} from "../../../system/transition/origin";
import { useWorkspaceChrome } from "./useWorkspaceChrome";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let handleBackHome: (() => Promise<void>) | null = null;
let generationActive = false;
let confirmGenerationInterrupt = vi.fn(async () => true);
let flushPendingDocSave = vi.fn(async () => undefined);

describe("useWorkspaceChrome 返回首页", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "#/workspace");
    generationActive = false;
    confirmGenerationInterrupt = vi.fn(async () => true);
    flushPendingDocSave = vi.fn(async () => undefined);
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

  it("生成中返回首页先说明会中断，取消后留在原文档且不触发保存", async () => {
    generationActive = true;
    confirmGenerationInterrupt = vi.fn(async () => false);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Harness));
    });

    await act(async () => {
      await handleBackHome?.();
    });

    expect(confirmGenerationInterrupt).toHaveBeenCalledTimes(1);
    expect(flushPendingDocSave).not.toHaveBeenCalled();
    expect(host.querySelector("#view-workspace")?.classList.contains("ws-returning"))
      .toBe(false);
    expect(window.location.hash).toBe("#/workspace");
  });

  it("生成中确认中断后才执行原有保存与返回首页流程", async () => {
    generationActive = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(Harness));
    });

    await act(async () => {
      await handleBackHome?.();
    });

    expect(confirmGenerationInterrupt).toHaveBeenCalledTimes(1);
    expect(flushPendingDocSave).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#view-workspace")?.classList.contains("ws-returning"))
      .toBe(true);
    expect(window.location.hash).toBe("#/workspace");

    act(() => vi.advanceTimersByTime(260));
    expect(window.location.hash).toBe("#/");
  });

  it("到场态与 hydration 解耦，纸壳首帧在场并按原两帧时序揭示 chrome", async () => {
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
      root?.render(createElement(Harness));
    });
    const view = host.querySelector("#view-workspace");
    expect(host.querySelector('[data-wf="WorkspacePaperShell"]')).not.toBeNull();
    expect(view?.classList.contains("ws-arriving")).toBe(true);
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(false);

    act(() => vi.advanceTimersByTime(16));
    expect(view?.classList.contains("ws-arriving")).toBe(true);
    expect(peekWorkspaceArrive()).not.toBeNull();

    act(() => vi.advanceTimersByTime(16));
    expect(view?.classList.contains("ws-arriving")).toBe(false);
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(true);
    expect(peekWorkspaceArrive()).toBeNull();

    act(() => vi.advanceTimersByTime(760));
    expect(view?.classList.contains("ws-arrive-revealing")).toBe(false);
  });

  it("没有首页交接载荷时不自造到场编舞，新建与直接打开均立即呈现 chrome", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(createElement(Harness));
    });
    const view = host.querySelector("#view-workspace");
    expect(view?.className).toBe("");
    act(() => vi.advanceTimersByTime(1_000));
    expect(view?.className).toBe("");
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
    generationActive,
    confirmGenerationInterrupt,
    flushPendingDocSave,
  });
  handleBackHome = chrome.handleBackHome;
  return createElement(
    "section",
    { id: "view-workspace", ref: viewRef },
    createElement(
      "div",
      { ref: docScrollRef },
      createElement("div", { "data-wf": "WorkspacePaperShell" }),
    ),
    createElement("div", { ref: chatScrollRef }),
  );
}
