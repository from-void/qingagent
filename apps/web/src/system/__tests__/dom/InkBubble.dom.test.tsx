import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/workspace.css"),
  "utf8",
);

const threeMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    parameters: Record<string, unknown>;
    domElement: HTMLCanvasElement;
    render: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }>,
  operations: [] as string[],
  constructorError: null as Error | null,
  renderError: null as Error | null,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();

  class MockWebGLRenderer {
    parameters: Record<string, unknown>;
    domElement: HTMLCanvasElement;
    private pixelRatio = 1;

    constructor(parameters: Record<string, unknown>) {
      if (threeMockState.constructorError) throw threeMockState.constructorError;
      this.parameters = parameters;
      this.domElement = document.createElement("canvas");
      this.domElement.dataset.renderer = "webgl";
      threeMockState.instances.push(this);
    }

    setPixelRatio = vi.fn((pixelRatio: number) => {
      this.pixelRatio = pixelRatio;
    });

    setSize = vi.fn((width: number, height: number) => {
      this.domElement.width = Math.floor(width * this.pixelRatio);
      this.domElement.height = Math.floor(height * this.pixelRatio);
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    });

    setClearColor = vi.fn();

    render = vi.fn(() => {
      if (threeMockState.renderError) throw threeMockState.renderError;
      threeMockState.operations.push("render");
    });

    dispose = vi.fn(() => {
      threeMockState.operations.push("dispose");
    });

    forceContextLoss = vi.fn(() => {
      threeMockState.operations.push("forceContextLoss");
    });
  }

  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer,
  };
});

import { InkBubble } from "../../InkBubble";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let drawImageMock: ReturnType<typeof vi.fn>;
let clearRectMock: ReturnType<typeof vi.fn>;
let nowMs = 0;
let rafId = 1;
let rafCallbacks: Map<number, FrameRequestCallback>;

describe("InkBubble WebGL snapshot settling", () => {
  beforeEach(() => {
    threeMockState.instances.length = 0;
    threeMockState.operations.length = 0;
    threeMockState.constructorError = null;
    threeMockState.renderError = null;
    nowMs = 0;
    rafId = 1;
    rafCallbacks = new Map();
    drawImageMock = vi.fn(() => {
      threeMockState.operations.push("drawImage");
    });
    clearRectMock = vi.fn();

    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      return this.classList.contains("ink-bubble") ? 120 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function offsetHeight(this: HTMLElement) {
      return this.classList.contains("ink-bubble") ? 40 : 0;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId: string) => {
      if (contextId !== "2d") return null;
      return {
        clearRect: clearRectMock,
        drawImage: drawImageMock,
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = rafId++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        rafCallbacks.delete(id);
      }),
    );
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("非动画气泡渲染终帧后立即替换为同尺寸 2D 快照并释放 WebGL context", async () => {
    await render(<InkBubble animate={false}>静止气泡</InkBubble>);

    const renderer = getRenderer();
    const snapshotCanvas = getSnapshotCanvas();

    expect(renderer.parameters).toMatchObject({ preserveDrawingBuffer: true });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(drawImageMock).toHaveBeenCalledWith(
      renderer.domElement,
      0,
      0,
      renderer.domElement.width,
      renderer.domElement.height,
    );
    expect(snapshotCanvas).not.toBe(renderer.domElement);
    expect(snapshotCanvas.width).toBe(renderer.domElement.width);
    expect(snapshotCanvas.height).toBe(renderer.domElement.height);
    expect(snapshotCanvas.style.width).toBe(renderer.domElement.style.width);
    expect(snapshotCanvas.style.height).toBe(renderer.domElement.style.height);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(renderer.domElement.isConnected).toBe(false);
    expect(threeMockState.operations).toEqual(["render", "drawImage", "dispose", "forceContextLoss"]);
  });

  it("动画气泡在文字浮现时机不变的终帧后快照，并释放 WebGL context", async () => {
    await render(<InkBubble animate>动画气泡</InkBubble>);

    const renderer = getRenderer();
    expect(getCanvas()).toBe(renderer.domElement);
    expect(getContent().classList.contains("ink-bubble__content--visible")).toBe(false);
    expect(drawImageMock).not.toHaveBeenCalled();
    expect(renderer.dispose).not.toHaveBeenCalled();

    runNextAnimationFrame(500);

    const snapshotCanvas = getSnapshotCanvas();
    expect(getContent().classList.contains("ink-bubble__content--visible")).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(drawImageMock).toHaveBeenCalledWith(
      renderer.domElement,
      0,
      0,
      renderer.domElement.width,
      renderer.domElement.height,
    );
    expect(snapshotCanvas).not.toBe(renderer.domElement);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(renderer.domElement.isConnected).toBe(false);
    expect(rafCallbacks.size).toBe(0);
    expect(threeMockState.operations).toEqual(["render", "render", "drawImage", "dispose", "forceContextLoss"]);
  });

  it("WebGL 初始化失败时退化为正文可见的静态气泡", async () => {
    threeMockState.constructorError = new Error("webgl unavailable");

    await render(<InkBubble animate className="wf-msg user">初始化失败气泡</InkBubble>);

    expect(getContent().classList.contains("ink-bubble__content--visible")).toBe(true);
    expect(getWrap().classList.contains("ink-bubble--animate")).toBe(false);
    expect(getWrap().classList.contains("ink-bubble--static-fallback")).toBe(true);
    const compactCss = workspaceCss.replace(/\s+/g, "");
    expect(compactCss).toContain(
      "#view-workspace.ink-bubble.wf-msg.user.ink-bubble--static-fallback{background:var(--ink-1);color:var(--ink-on-dark);}",
    );
    expect(compactCss).toContain(
      "#view-workspace.ink-bubble.wf-msg.user.ink-bubble--static-fallback.ink-bubble__content{padding:10px14px;}",
    );
    expect(getCanvasContainer().querySelector("canvas")).toBeNull();
    expect(rafCallbacks.size).toBe(0);
  });

  it("动画帧渲染失败时显示正文并释放已创建的 WebGL context", async () => {
    await render(<InkBubble animate>渲染失败气泡</InkBubble>);
    const renderer = getRenderer();
    threeMockState.renderError = new Error("webgl render failed");

    runNextAnimationFrame(100);

    expect(getContent().classList.contains("ink-bubble__content--visible")).toBe(true);
    expect(getWrap().classList.contains("ink-bubble--animate")).toBe(false);
    expect(getWrap().classList.contains("ink-bubble--static-fallback")).toBe(true);
    expect(getCanvasContainer().querySelector("canvas")).toBeNull();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.size).toBe(0);
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  host.id = "view-workspace";
  host.style.setProperty("--ink-1", "#1f2a31");
  host.style.setProperty("--ink-on-dark", "#fffaf0");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function getRenderer() {
  const renderer = threeMockState.instances[0];
  if (!renderer) throw new Error("renderer not created");
  return renderer;
}

function getCanvasContainer(): HTMLDivElement {
  const container = host?.querySelector<HTMLDivElement>(".ink-bubble__canvas");
  if (!container) throw new Error("canvas container not found");
  return container;
}

function getWrap(): HTMLDivElement {
  const wrap = host?.querySelector<HTMLDivElement>(".ink-bubble");
  if (!wrap) throw new Error("ink bubble not found");
  return wrap;
}

function getCanvas(): HTMLCanvasElement {
  const canvas = getCanvasContainer().querySelector<HTMLCanvasElement>("canvas");
  if (!canvas) throw new Error("canvas not found");
  return canvas;
}

function getSnapshotCanvas(): HTMLCanvasElement {
  const canvas = getCanvas();
  if (canvas.dataset.renderer === "webgl") throw new Error("webgl canvas was not replaced");
  return canvas;
}

function getContent(): HTMLDivElement {
  const content = host?.querySelector<HTMLDivElement>(".ink-bubble__content");
  if (!content) throw new Error("content not found");
  return content;
}

function runNextAnimationFrame(timeMs: number): void {
  const [entry] = rafCallbacks;
  if (!entry) throw new Error("requestAnimationFrame callback not found");
  const [id, callback] = entry;
  rafCallbacks.delete(id);
  nowMs = timeMs;
  act(() => {
    callback(timeMs);
  });
}
