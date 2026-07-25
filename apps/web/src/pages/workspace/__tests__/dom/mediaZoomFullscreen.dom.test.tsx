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

      await act(async () => {
        viewport!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 50, clientY: 50 }));
      });
      expect(content!.style.transform).toContain("scale(1.12)");

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(document.body.querySelector(".media-zoom-fullscreen")).toBeNull();
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
});
