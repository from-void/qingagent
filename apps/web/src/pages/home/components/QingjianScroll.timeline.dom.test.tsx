// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSession } from "../data/sessions";
import { QingjianScroll } from "./QingjianScroll";

vi.mock("../../new-session/transition/homeStage", () => ({
  createHomeTransitionStage: () => ({
    playForward: vi.fn(() => Promise.resolve({ left: 0, top: 0, width: 800, height: 600 })),
    playReturn: vi.fn(() => Promise.resolve()),
    snapArrived: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../../../system/chinese-masonry", () => ({
  CARD_WIDTH: 320,
  CardRenderer: ({ article }: { article: { title: string } }) => (
    <article className="cm-card">{article.title}</article>
  ),
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

const sessions: HomeSession[] = [
  makeSession("old", "旧文", "最早", 100, 300),
  makeSession("new", "新文", "最晚", 300, 200),
  makeSession("matched", "命中文章", "中间", 200, 100),
];

let host: HTMLDivElement;
let root: Root;

describe("QingjianScroll 时间轴身份与日期", () => {
  beforeEach(async () => {
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

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QingjianScroll
          sessions={sessions}
          onOpenSession={() => undefined}
          onNewSession={() => undefined}
        />,
      );
    });
    mockTimelineGeometry();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("搜索重排后按稳定文章 id 显示预览，并保留真实最早与最晚日期", async () => {
    const searchButton = host.querySelector<HTMLButtonElement>(".qj-dock-search-btn")!;
    await act(async () => searchButton.click());

    const input = host.querySelector<HTMLInputElement>(".qj-dock-search-input")!;
    await act(async () => {
      setInputValue(input, "命中");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const scale = Array.from(host.querySelectorAll<HTMLElement>(".qj-dp-scale span"));
    expect(scale.map((node) => node.textContent)).toEqual(["最早", "最晚"]);

    window.dispatchEvent(new Event("resize"));
    const progress = host.querySelector<HTMLElement>(".qj-dock-prog")!;
    await act(async () => {
      progress.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 25, clientY: 0 }),
      );
    });
    expect(host.querySelector(".qj-dock-preview-title")?.textContent).toBe("命中文章");
  });

  it("真实文章卡和新建卡具备按钮语义，并支持 Enter 与 Space 激活", async () => {
    const onOpenSession = vi.fn();
    const onNewSession = vi.fn();
    await act(async () => {
      root.render(
        <QingjianScroll
          sessions={sessions}
          onOpenSession={onOpenSession}
          onNewSession={onNewSession}
        />,
      );
    });

    const realSlot = host.querySelector<HTMLElement>('.qj-card-slot[data-id="matched"]')!;
    const newSlot = host.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]')!;
    expect(realSlot.getAttribute("role")).toBe("button");
    expect(realSlot.tabIndex).toBe(0);
    expect(realSlot.getAttribute("aria-label")).toContain("命中文章");
    expect(newSlot.getAttribute("role")).toBe("button");
    expect(newSlot.tabIndex).toBe(0);

    await act(async () => {
      realSlot.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOpenSession).toHaveBeenCalledWith("matched");

    await act(async () => {
      newSlot.dispatchEvent(new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("会话数据更新重建布局后保留并钳制当前长卷位置", async () => {
    const scroller = host.querySelector<HTMLElement>(".qj-scroll")!;
    const inner = host.querySelector<HTMLElement>(".qj-inner")!;
    window.dispatchEvent(new Event("resize"));
    await act(async () => {
      scroller.dispatchEvent(new KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true,
      }));
      vi.advanceTimersByTime(500);
    });
    const beforeUpdate = translatedViewX(inner);
    expect(beforeUpdate).toBeGreaterThan(100);

    await act(async () => {
      root.render(
        <QingjianScroll
          sessions={[
            ...sessions,
            makeSession("added", "新增文章", "新增", 400, 400),
          ]}
          onOpenSession={() => undefined}
          onNewSession={() => undefined}
        />,
      );
    });
    mockTimelineGeometry();
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(20);
    });

    expect(translatedViewX(inner)).toBeGreaterThan(100);

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".qj-dock-search-btn")!.click();
    });
    const input = host.querySelector<HTMLInputElement>(".qj-dock-search-input")!;
    await act(async () => {
      setInputValue(input, "命中");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    mockTimelineGeometry();
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(20);
    });
    expect(translatedViewX(inner)).toBe(0);
  });
});

function makeSession(
  id: string,
  title: string,
  date: string,
  createdAt: number,
  recentEditedAt: number,
): HomeSession {
  return {
    id,
    title,
    brief: `${title}摘要`,
    ghostLines: [],
    sources: [],
    date,
    category: "long",
    recentEditedAt,
    createdAt,
    pushedAt: recentEditedAt,
  };
}

function mockTimelineGeometry(): void {
  const scroller = host.querySelector<HTMLElement>(".qj-scroll")!;
  const inner = host.querySelector<HTMLElement>(".qj-inner")!;
  const dock = host.querySelector<HTMLElement>(".qj-dock")!;
  const progress = host.querySelector<HTMLElement>(".qj-dock-prog")!;
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 400 });
  Object.defineProperty(inner, "scrollWidth", { configurable: true, value: 2_000 });
  inner.getBoundingClientRect = () => domRect(0, 0, 2_000, 600);
  host.querySelector<HTMLElement>(".qj-stage")!.getBoundingClientRect =
    () => domRect(0, 0, 2_000, 600);
  dock.getBoundingClientRect = () => domRect(0, 0, 100, 40);
  progress.getBoundingClientRect = () => domRect(0, 0, 100, 20);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
}

function translatedViewX(inner: HTMLElement): number {
  const match = inner.style.transform.match(/translate3d\((-?[\d.]+)px/);
  return match ? Math.abs(Number(match[1])) : 0;
}

function domRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
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
  };
}
