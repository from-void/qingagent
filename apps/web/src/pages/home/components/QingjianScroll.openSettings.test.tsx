// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goConfigureModel } from "../../../system/modelKeyGate";
import { OnboardingSettingsProvider } from "../../../system/onboarding/OnboardingSettingsContext";
import { setHomeArrive } from "../../../system/transition/origin";
import { QingjianScroll } from "./QingjianScroll";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
  HomeSettingsSheet: ({
    initialTab,
    initialModelProvider,
  }: {
    initialTab?: string;
    initialModelProvider?: string;
  }) => (
    <div
      data-wf="HomeSettingsSheet"
      data-tab={initialTab ?? "model"}
      data-model-provider={initialModelProvider}
    >
      设置
    </div>
  ),
}));

vi.mock("../../../system/onboarding/CoachMark", () => ({
  CoachMark: ({
    id,
    placement,
    visible,
  }: {
    id: string;
    placement: string;
    visible: boolean;
  }) => visible ? <div data-coach-mark={id} data-placement={placement} /> : null,
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

    const settingsButton = host.querySelector<HTMLButtonElement>(".qj-settings-btn");
    expect(settingsButton?.querySelector("svg")).not.toBeNull();
    expect(settingsButton?.textContent).not.toContain("⚙");
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

  it("门禁携带 Kimi 目标时直接把设置页定向到 Kimi 二级配置", async () => {
    goConfigureModel(() => undefined, "kimi");
    expect(window.sessionStorage.getItem("qj-open-settings")).toBe("model:kimi");

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
    await act(async () => {
      vi.advanceTimersByTime(650);
    });

    const sheet = host.querySelector<HTMLElement>('[data-wf="HomeSettingsSheet"]');
    expect(sheet?.dataset.tab).toBe("model");
    expect(sheet?.dataset.modelProvider).toBe("kimi");
    expect(window.sessionStorage.getItem("qj-open-settings")).toBeNull();
  });

  it("首次进入首页时设置与新建气泡同时出现，并用不同锚点方向错位", async () => {
    window.localStorage.setItem("qj-reduce", "1");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
      if (String(request).endsWith("/settings/onboarding")) {
        return Response.json({
          state: { status: "done", completedAt: "2026-08-17T00:00:00.000Z" },
          coachSeen: [],
        });
      }
      throw new Error(`unexpected request: ${String(request)}`);
    }));

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <OnboardingSettingsProvider>
          <QingjianScroll
            sessions={[]}
            onOpenSession={() => undefined}
            onNewSession={() => undefined}
          />
        </OnboardingSettingsProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const scroller = host.querySelector<HTMLElement>(".qj-scroll")!;
    const newCard = host.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]')!;
    scroller.getBoundingClientRect = () => domRect(0, 0, 800, 600);
    newCard.getBoundingClientRect = () => domRect(64, 100, 320, 380);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    const settingsCoach = host.querySelector('[data-coach-mark="home-settings"]');
    const newCoach = host.querySelector('[data-coach-mark="home-new"]');
    expect(settingsCoach).not.toBeNull();
    expect(newCoach).not.toBeNull();
    expect(settingsCoach?.getAttribute("data-placement")).toBe("bottom-end");
    expect(newCoach?.getAttribute("data-placement")).toBe("right");
  });

  it("系统减动效时直接消费 workspace 返回到达态，不播放深底渐出", async () => {
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    setHomeArrive({
      rect: { left: 488, top: 52, width: 800, height: 848 },
      x: 888,
      y: 476,
      source: "workspace",
    });

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

    expect(window.sessionStorage.getItem("qingagent:home-arrive")).toBeNull();
    expect(host.querySelector(".qj-root")?.classList.contains("qj-arriving")).toBe(false);
  });
});

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
