import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureWorkspaceInputClearance,
  useWorkspaceChrome,
} from "./useWorkspaceChrome";

const CHAT_BOTTOM = 800;
const DESIGN_GAP = 24;
let root: Root | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("workspace 对话流底部留白", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each([
    ["普通输入框", "wf-input", 668, 682, 100],
    ["多行长文", "wf-input", 568, 582, 200],
    ["askUser 面板", "askuser-overlay", 668, 350, 438],
    ["确认条", "cf-overlay", 668, 420, 362],
  ])(
    "%s 下末条消息不与输入区重叠，且留白减实际占用不小于显式 gap",
    (_shape, occupantClass, wrapTop, occupantTop, occupantHeight) => {
      const { chat, wrap, occupant } = createLayout({
        occupantClass,
        wrapTop,
        occupantTop,
        occupantHeight,
      });

      const clearance = measureWorkspaceInputClearance(chat, wrap);
      if (clearance === null) throw new Error("已成画布局不应返回空测量");
      const actualOccupied = CHAT_BOTTOM - occupantTop;
      const lastMessageBottomAtScrollEnd = CHAT_BOTTOM - clearance;

      expect(clearance - actualOccupied).toBeGreaterThanOrEqual(DESIGN_GAP);
      expect(clearance - actualOccupied).toBe(DESIGN_GAP);
      expect(lastMessageBottomAtScrollEnd).toBeLessThan(occupantTop);
      expect(occupant.getBoundingClientRect().top).toBe(occupantTop);
    },
  );

  it("技能菜单开合前后 --ws-input-clearance 不变（浮层不占位）", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(RaceHarness, {
        getChatHeight: () => CHAT_BOTTOM,
        menuOpen: false,
      }));
      await waitForLayout();
    });
    const left = host.querySelector<HTMLElement>(".ws-left")!;
    const before = left.style.getPropertyValue("--ws-input-clearance");
    expect(before).toBe("179px");

    await act(async () => {
      root?.render(createElement(RaceHarness, {
        getChatHeight: () => CHAT_BOTTOM,
        menuOpen: true,
      }));
      await waitForLayout();
    });
    expect(host.querySelector(".qa-skill-menu")).not.toBeNull();
    expect(left.style.getPropertyValue("--ws-input-clearance")).toBe(before);

    await act(async () => {
      root?.render(createElement(RaceHarness, {
        getChatHeight: () => CHAT_BOTTOM,
        menuOpen: false,
      }));
      await waitForLayout();
    });
    expect(host.querySelector(".qa-skill-menu")).toBeNull();
    expect(left.style.getPropertyValue("--ws-input-clearance")).toBe(before);
  });

  it("任务明细浮层不占位，任务胶囊本体仍占位", () => {
    const { chat, wrap } = createLayout({
      occupantClass: "ws-taskpill-host",
      wrapTop: 668,
      occupantTop: 630,
      occupantHeight: 30,
    });
    const before = measureWorkspaceInputClearance(chat, wrap);
    const flyout = document.createElement("div");
    flyout.className = "ws-taskpill-flyout";
    setRect(flyout, { top: 300, bottom: 618, width: 300, height: 318 });
    wrap.appendChild(flyout);

    expect(before).toBe(CHAT_BOTTOM - 630 + DESIGN_GAP);
    expect(measureWorkspaceInputClearance(chat, wrap)).toBe(before);
  });

  it("wrap paddingTop 大于显式 gap 时取较大值且不双份相加", () => {
    const { chat, wrap } = createLayout({
      occupantClass: "wf-input",
      wrapTop: 650,
      occupantTop: 682,
      occupantHeight: 100,
      paddingTop: 32,
    });

    const clearance = measureWorkspaceInputClearance(chat, wrap);
    if (clearance === null) throw new Error("已成画布局不应返回空测量");
    const actualOccupied = CHAT_BOTTOM - 682;
    expect(clearance - actualOccupied).toBe(32);
  });

  it("内容成画前不写 0，成画后由 chat ResizeObserver 强制写入正确留白", async () => {
    const resizeObservers: ResizeObserverMock[] = [];
    const animationFrames: FrameRequestCallback[] = [];
    let chatHeight = 0;

    class ResizeObserverMock {
      readonly targets = new Set<Element>();

      constructor(
        private readonly callback: ResizeObserverCallback,
      ) {
        resizeObservers.push(this);
      }

      observe(target: Element) {
        this.targets.add(target);
      }

      disconnect() {
        this.targets.clear();
      }

      flush() {
        this.callback([], this as unknown as ResizeObserver);
      }
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(RaceHarness, {
        getChatHeight: () => chatHeight,
      }));
    });

    const left = host.querySelector<HTMLElement>(".ws-left")!;
    const chat = host.querySelector<HTMLElement>(".ws-chat")!;
    expect(left.style.getPropertyValue("--ws-input-clearance")).toBe("");
    expect(resizeObservers.some((observer) => observer.targets.has(chat))).toBe(
      true,
    );

    chatHeight = CHAT_BOTTOM;
    await act(async () => {
      for (const observer of resizeObservers) observer.flush();
      while (animationFrames.length > 0) {
        animationFrames.shift()?.(performance.now());
      }
    });

    expect(left.style.getPropertyValue("--ws-input-clearance")).toBe("179px");
    expect(left.style.getPropertyValue("--ws-input-clearance")).not.toBe("0px");
  });
});

function RaceHarness({
  getChatHeight,
  menuOpen = false,
}: {
  getChatHeight: () => number;
  menuOpen?: boolean;
}) {
  const viewRef = useRef<HTMLElement | null>(null);
  const docScrollRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  useWorkspaceChrome({
    viewRef,
    docScrollRef,
    chatScrollRef,
    sessionId: null,
    reducedMotion: false,
    flushPendingDocSave: async () => undefined,
  });

  return createElement(
    "section",
    { id: "view-workspace", ref: viewRef },
    createElement("div", { ref: docScrollRef }),
    createElement(
      "div",
      { className: "ws-left" },
      createElement("div", {
        className: "ws-chat",
        ref: (element: HTMLDivElement | null): void => {
          chatScrollRef.current = element;
          if (!element) return;
          setDynamicRect(element, () => ({
            top: 0,
            bottom: getChatHeight(),
            width: 440,
            height: getChatHeight(),
          }));
          Object.defineProperties(element, {
            clientHeight: { configurable: true, get: getChatHeight },
            scrollHeight: { configurable: true, get: () => 1_000 },
            scrollTo: { configurable: true, value: vi.fn() },
          });
        },
      }),
      createElement(
        "div",
        {
          className: "ws-input-wrap",
          ref: (element: HTMLDivElement | null): void => {
            if (element) {
              element.style.setProperty(
                "--ws-input-clearance-gap",
                `${DESIGN_GAP}px`,
              );
              setRect(element, {
                top: 645,
                bottom: 800,
                width: 440,
                height: 155,
              });
            }
          },
        },
        createElement("div", {
          className: "wf-input",
          ref: (element: HTMLDivElement | null): void => {
            if (element) {
              setRect(element, {
                top: 645,
                bottom: 776,
                width: 422,
                height: 131,
              });
            }
          },
        }),
        menuOpen
          ? createElement("div", {
              className: "qa-skill-menu",
              ref: (element: HTMLDivElement | null): void => {
                if (element) {
                  setRect(element, {
                    top: 300,
                    bottom: 560,
                    width: 300,
                    height: 260,
                  });
                }
              },
            })
          : null,
      ),
    ),
  );
}

async function waitForLayout(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 32));
}

function setDynamicRect(
  element: HTMLElement,
  getRect: () => Pick<DOMRect, "top" | "bottom" | "width" | "height">,
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const rect = getRect();
      return {
        ...rect,
        x: 0,
        y: rect.top,
        left: 0,
        right: rect.width,
        toJSON: () => ({}),
      };
    },
  });
}

function createLayout(input: {
  occupantClass: string;
  wrapTop: number;
  occupantTop: number;
  occupantHeight: number;
  paddingTop?: number;
}) {
  const chat = document.createElement("div");
  const wrap = document.createElement("div");
  const occupant = document.createElement("div");
  wrap.style.paddingTop = `${input.paddingTop ?? 0}px`;
  wrap.style.setProperty("--ws-input-clearance-gap", `${DESIGN_GAP}px`);
  occupant.className = input.occupantClass;
  wrap.appendChild(occupant);
  document.body.append(chat, wrap);

  setRect(chat, {
    top: 0,
    bottom: CHAT_BOTTOM,
    width: 440,
    height: CHAT_BOTTOM,
  });
  setRect(wrap, {
    top: input.wrapTop,
    bottom: CHAT_BOTTOM,
    width: 440,
    height: CHAT_BOTTOM - input.wrapTop,
  });
  setRect(occupant, {
    top: input.occupantTop,
    bottom: input.occupantTop + input.occupantHeight,
    width: 422,
    height: input.occupantHeight,
  });

  return { chat, wrap, occupant };
}

function setRect(
  element: HTMLElement,
  rect: Pick<DOMRect, "top" | "bottom" | "width" | "height">,
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      x: 0,
      y: rect.top,
      left: 0,
      right: rect.width,
      toJSON: () => ({}),
    }),
  });
}
