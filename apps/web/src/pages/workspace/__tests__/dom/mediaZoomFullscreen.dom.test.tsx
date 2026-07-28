// @vitest-environment jsdom

import { createElement, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaZoomFullscreen } from "../../components/MediaZoomFullscreen";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开</button>
      <MediaZoomFullscreen open={open} onClose={() => setOpen(false)}>
        <div style={{ width: 400, height: 200 }}>内容</div>
      </MediaZoomFullscreen>
    </>
  );
}

describe("MediaZoomFullscreen", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("支持打开、滚轮缩放和 Esc 关闭", async () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removeSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    Element.prototype.setPointerCapture = function () {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const dialog = document.body.querySelector<HTMLElement>(".media-zoom-fullscreen");
      expect(dialog).not.toBeNull();
      const viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport");
      const content = document.body.querySelector<HTMLElement>(".media-zoom-content");
      expect(viewport).not.toBeNull();
      expect(content).not.toBeNull();
      expect(addSpy.mock.calls.some(
        ([type, , options]) => type === "wheel" && typeof options === "object" && options?.passive === false,
      )).toBe(true);

      const zoomWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -100,
        clientX: 50,
        clientY: 50,
      });
      await act(async () => {
        viewport!.dispatchEvent(zoomWheel);
      });
      expect(zoomWheel.defaultPrevented).toBe(true);
      expect(content!.style.transform).toContain("scale(1.12)");

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(document.body.querySelector(".media-zoom-fullscreen")).toBeNull();
      expect(removeSpy.mock.calls.some(([type]) => type === "wheel")).toBe(true);
    } finally {
      rafSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("打开时小于视口的内容不放大并居中", async () => {
    let resetFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      resetFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      const content = document.body.querySelector<HTMLElement>(".media-zoom-content")!;
      Object.defineProperty(viewport, "offsetWidth", { configurable: true, value: 1000 });
      Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 800 });
      Object.defineProperty(content, "offsetWidth", { configurable: true, value: 400 });
      Object.defineProperty(content, "offsetHeight", { configurable: true, value: 200 });

      await act(async () => {
        resetFrame!(0);
      });
      expect(content.style.transform).toBe("translate(300px, 300px) scale(1)");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("打开时竖长内容缩小适配视口并留出边距", async () => {
    let resetFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      resetFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      const content = document.body.querySelector<HTMLElement>(".media-zoom-content")!;
      Object.defineProperty(viewport, "offsetWidth", { configurable: true, value: 800 });
      Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 600 });
      Object.defineProperty(content, "offsetWidth", { configurable: true, value: 400 });
      Object.defineProperty(content, "offsetHeight", { configurable: true, value: 1000 });

      await act(async () => {
        resetFrame!(0);
      });
      expect(content.style.transform).toBe("translate(286.4px, 16px) scale(0.568)");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("内容首次出现非零尺寸时自动居中，之后停止观察以保留用户变换", async () => {
    let resetFrame: FrameRequestCallback | undefined;
    let resizeCallback: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {
        disconnect();
      }
      unobserve() {}
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      resetFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      const content = document.body.querySelector<HTMLElement>(".media-zoom-content")!;
      let contentWidth = 0;
      let contentHeight = 0;
      Object.defineProperty(viewport, "offsetWidth", { configurable: true, value: 1000 });
      Object.defineProperty(viewport, "offsetHeight", { configurable: true, value: 800 });
      Object.defineProperty(content, "offsetWidth", { configurable: true, get: () => contentWidth });
      Object.defineProperty(content, "offsetHeight", { configurable: true, get: () => contentHeight });

      await act(async () => {
        resetFrame!(0);
      });
      expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
      expect(disconnect).not.toHaveBeenCalled();

      contentWidth = 400;
      contentHeight = 200;
      await act(async () => {
        resizeCallback!([], {} as ResizeObserver);
      });
      expect(content.style.transform).toBe("translate(300px, 300px) scale(1)");
      expect(disconnect).toHaveBeenCalledTimes(1);

      contentWidth = 800;
      contentHeight = 600;
      await act(async () => {
        resizeCallback!([], {} as ResizeObserver);
      });
      expect(content.style.transform).toBe("translate(300px, 300px) scale(1)");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("静止时不挂 will-change:transform(矢量 SVG 全屏保持清晰),仅拖拽平移期间挂(防全屏发糊回归)", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    Element.prototype.setPointerCapture = function () {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      const content = document.body.querySelector<HTMLElement>(".media-zoom-content")!;
      // 静止:不能常驻 will-change:transform(否则内容上合成层 → 矢量 SVG 被栅格化 → 全屏发糊)。
      expect(content.style.willChange === "transform").toBe(false);
      expect(viewport.classList.contains("is-panning")).toBe(false);
      // 仅按下还不进入拖拽态；实际移动超过阈值后才挂合成层与 grabbing 光标。
      await act(async () => {
        viewport.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(viewport.classList.contains("is-panning")).toBe(false);
      await act(async () => {
        viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }));
      });
      expect(content.style.willChange).toBe("transform");
      expect(viewport.classList.contains("is-panning")).toBe(true);
      // 松手:撤掉,回到矢量清晰。
      await act(async () => {
        viewport.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(content.style.willChange === "transform").toBe(false);
      expect(viewport.classList.contains("is-panning")).toBe(false);
    } finally {
      rafSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("拖拽中关闭会释放 pointer capture，重新打开不保留手势状态", async () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Element.prototype.setPointerCapture = setPointerCapture;
    Element.prototype.hasPointerCapture = () => true;
    Element.prototype.releasePointerCapture = releasePointerCapture;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const pointerEvent = (type: string, pointerId: number, init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      return event;
    };

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      let viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      await act(async () => {
        viewport.dispatchEvent(pointerEvent("pointerdown", 9, { button: 0 }));
        viewport.dispatchEvent(pointerEvent("pointermove", 9, { clientX: 8, clientY: 8 }));
      });
      expect(viewport.classList.contains("is-panning")).toBe(true);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(releasePointerCapture).toHaveBeenCalledWith(9);
      expect(document.body.querySelector(".media-zoom-fullscreen")).toBeNull();

      await act(async () => {
        container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      viewport = document.body.querySelector<HTMLElement>(".media-zoom-viewport")!;
      expect(viewport.classList.contains("is-panning")).toBe(false);
      expect(document.body.querySelector<HTMLElement>(".media-zoom-content")!.style.willChange).toBe("");
    } finally {
      rafSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
