// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goConfigureModel } from "../../../system/modelKeyGate";
import { QingjianScroll } from "./QingjianScroll";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("chinese-masonry", () => ({
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
  HomeSettingsSheet: ({ initialTab }: { initialTab?: string }) => (
    <div data-wf="HomeSettingsSheet" data-tab={initialTab ?? "model"}>
      设置
    </div>
  ),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("QingjianScroll 去首页配置", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
      value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => window.clearTimeout(id),
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

  it("带 qj-open-settings flag 挂载后稳定打开模型设置弹框，打开成功后才清除 flag", async () => {
    goConfigureModel(() => undefined);
    expect(window.sessionStorage.getItem("qj-open-settings")).toBe("model");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <QingjianScroll
          sessions={[]}
          onOpenSession={() => undefined}
          onNewSession={() => undefined}
        />,
      );
    });

    expect(host.querySelector('[data-wf="HomeSettingsSheet"]')).toBeNull();
    expect(window.sessionStorage.getItem("qj-open-settings")).toBe("model");

    await act(async () => {
      vi.advanceTimersByTime(650);
    });

    const sheet = host.querySelector<HTMLElement>('[data-wf="HomeSettingsSheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.dataset.tab).toBe("model");
    expect(window.sessionStorage.getItem("qj-open-settings")).toBeNull();
  });
});
