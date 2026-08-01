// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHomeArrive } from "../../../system/transition/origin";
import type { HomeSession } from "../data/sessions";
import { QingjianScroll } from "./QingjianScroll";

const stageMock = vi.hoisted(() => ({
  playForward: vi.fn(),
  playReturn: vi.fn(() => Promise.resolve()),
  snapArrived: vi.fn(),
  settleReturn: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../../../system/transition/homeStage", () => ({
  createHomeTransitionStage: () => stageMock,
}));

vi.mock("../../../system/chinese-masonry", () => ({
  CARD_WIDTH: 320,
  CardRenderer: () => <div data-wf="MockCardRenderer" />,
  createDefaultRegistry: () => ({
    getAll: () => [{ id: "mock", height: 220 }],
  }),
  createTemplateSelector: () => ({
    select: () => ({ id: "mock", height: 220 }),
  }),
}));

vi.mock("./HomeSettingsSheet", () => ({
  HomeSettingsSheet: () => null,
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("QingjianScroll 首页去程生命周期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stageMock.playForward.mockReset();
    stageMock.playReturn.mockReset().mockResolvedValue(undefined);
    stageMock.snapArrived.mockClear();
    stageMock.settleReturn.mockClear();
    stageMock.dispose.mockClear();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => window.clearTimeout(id),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(),
    });
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,");
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "getAnimations");
    window.sessionStorage.clear();
  });

  async function renderHome(
    onNewSession: () => void,
    sessions: HomeSession[] = [],
  ) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <QingjianScroll
          sessions={sessions}
          onOpenSession={() => undefined}
          onNewSession={onNewSession}
        />,
      );
    });
    const slot = host.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]')!;
    vi.mocked(document.elementFromPoint).mockReturnValue(slot);
    return host.querySelector<HTMLElement>(".qj-scroll")!;
  }

  it("forward 拒绝时在 finally 解锁并降级导航", async () => {
    stageMock.playForward.mockRejectedValueOnce(new Error("animation failed"));
    const onNewSession = vi.fn();
    const scroller = await renderHome(onNewSession);

    await act(async () => {
      scroller.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stageMock.playForward).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(host?.querySelector(".qj-root")?.classList.contains("qj-transitioning")).toBe(false);
  });

  it("多个生成中会话各自展示状态、流光与辅助文案", async () => {
    await renderHome(
      () => undefined,
      [
        { ...makeSession("generating-session-a", 1), generating: true },
        { ...makeSession("generating-session-b", 2), generating: true },
      ],
    );

    const slots = host?.querySelectorAll<HTMLElement>(
      ".qj-card-slot.qj-generating",
    );
    expect(slots).toHaveLength(2);
    for (const slot of slots ?? []) {
      expect(slot.getAttribute("aria-label")).toContain("生成中");
      expect(slot.querySelector(".qj-generation-shimmer")).not.toBeNull();
      expect(slot.querySelector(".qj-generation-status")?.textContent?.trim())
        .toBe("生成中");
      expect(slot.querySelector(".qj-generation-hover-hint")?.textContent)
        .toBe("青简正在写作");
    }
  });

  it("卸载会使旧 forward 代次失效，晚到结算不得提交导航", async () => {
    let resolveForward: ((rect: { left: number; top: number; width: number; height: number }) => void) | undefined;
    stageMock.playForward.mockImplementationOnce(() => new Promise((resolve) => {
      resolveForward = resolve;
    }));
    const onNewSession = vi.fn();
    const scroller = await renderHome(onNewSession);

    await act(async () => {
      scroller.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }));
      await Promise.resolve();
    });
    expect(stageMock.playForward).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      resolveForward?.({ left: 0, top: 0, width: 800, height: 600 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stageMock.dispose).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("远端候选稿返回后仍从新建卡原点淡入，不保留临时负位移", async () => {
    const finishAnimation = vi.fn();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ finish: finishAnimation }] as unknown as Animation[],
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("qj-scroll") ? 400 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("qj-inner") ? 10_000 : 0;
    });
    setHomeArrive({
      rect: { left: 520, top: 40, width: 800, height: 860 },
      x: 920,
      y: 470,
      source: "workspace",
      sessionId: "far-candidate",
    });

    await renderHome(
      () => undefined,
      [
        ...Array.from({ length: 8 }, (_, index) =>
          makeSession(`recent-${index}`, 100 - index),
        ),
        makeSession("far-candidate", 1),
      ],
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });

    const inner = host?.querySelector<HTMLElement>(".qj-inner");
    const home = host?.querySelector<HTMLElement>(".qj-root");
    expect(stageMock.playReturn).toHaveBeenCalledTimes(1);
    expect(translatedViewX(inner)).toBe(0);
    expect(finishAnimation).toHaveBeenCalled();
    expect(home?.classList.contains("qj-arriving")).toBe(false);
  });

  it("playReturn 永久静默时也会按页面兜底时限清除 qj-arriving", async () => {
    stageMock.playReturn.mockImplementationOnce(() => new Promise<void>(() => {}));
    setHomeArrive({
      rect: { left: 520, top: 40, width: 800, height: 860 },
      x: 920,
      y: 470,
      source: "workspace",
    });

    await renderHome(() => undefined);
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(host?.querySelector(".qj-root")?.classList.contains("qj-arriving")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_900);
    });
    expect(stageMock.settleReturn).toHaveBeenCalled();
    expect(host?.querySelector(".qj-root")?.classList.contains("qj-arriving")).toBe(false);
  });

  it("返程中启动的新 forward 不会被旧返程兜底取消", async () => {
    stageMock.playReturn.mockImplementationOnce(() => new Promise<void>(() => {}));
    stageMock.playForward.mockImplementationOnce(() => new Promise(() => {}));
    setHomeArrive({
      rect: { left: 520, top: 40, width: 800, height: 860 },
      x: 920,
      y: 470,
      source: "workspace",
      sessionId: "interrupt-target",
    });

    await renderHome(
      () => undefined,
      [makeSession("interrupt-target", 1)],
    );
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    const article = host?.querySelector<HTMLElement>(
      '.qj-card-slot[data-id="interrupt-target"]',
    );
    await act(async () => {
      article?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stageMock.playForward).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_900);
    });
    expect(stageMock.settleReturn).not.toHaveBeenCalled();
    expect(host?.querySelector(".qj-root")?.classList.contains("qj-arriving")).toBe(false);
    expect(host?.querySelector(".qj-root")?.classList.contains("qj-transitioning")).toBe(true);
  });
});

function makeSession(id: string, recentEditedAt: number): HomeSession {
  return {
    id,
    title: id,
    brief: `${id} 摘要`,
    ghostLines: [],
    sources: [],
    date: "今天",
    category: "long",
    recentEditedAt,
    createdAt: recentEditedAt,
    pushedAt: recentEditedAt,
  };
}

function translatedViewX(inner: HTMLElement | null | undefined): number {
  const match = inner?.style.transform.match(/translate3d\((-?[\d.]+)px/);
  return match ? Math.abs(Number(match[1])) : Number.NaN;
}
