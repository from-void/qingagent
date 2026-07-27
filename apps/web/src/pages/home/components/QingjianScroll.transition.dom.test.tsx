// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QingjianScroll } from "./QingjianScroll";

const stageMock = vi.hoisted(() => ({
  playForward: vi.fn(),
  playReturn: vi.fn(() => Promise.resolve()),
  snapArrived: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../../new-session/transition/homeStage", () => ({
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
    stageMock.playReturn.mockClear();
    stageMock.snapArrived.mockClear();
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
    window.sessionStorage.clear();
  });

  async function renderHome(onNewSession: () => void) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <QingjianScroll
          sessions={[]}
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
});
