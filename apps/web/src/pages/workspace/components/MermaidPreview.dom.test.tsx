// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramSvgView, MermaidPreview } from "./MermaidPreview";
import { renderDrawio } from "./drawioRender";

vi.mock("./drawioRender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./drawioRender")>();
  return {
    ...actual,
    renderDrawio: vi.fn(),
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.mocked(renderDrawio).mockReset();
  vi.restoreAllMocks();
});

describe("MermaidPreview", () => {
  it("合法空 drawio 显示占位而非渲染错误", async () => {
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<MermaidPreview source={source} lang="drawio" />);
      await Promise.resolve();
    });

    expect(renderDrawio).not.toHaveBeenCalled();
    expect(host.querySelector(".pm-diagram-empty")?.textContent).toBe("空图表");
    expect(host.querySelector(".pm-diagram-error")).toBeNull();
  });

  it("图表仅用可清理的非 passive 原生 wheel 监听拦截 ctrl 缩放", async () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removeSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<DiagramSvgView svg="<svg></svg>" />);
    });
    const viewport = host.querySelector<HTMLElement>(".pm-diagram-svg")!;
    expect(addSpy.mock.calls.some(
      ([type, , options]) => type === "wheel" && typeof options === "object" && options?.passive === false,
    )).toBe(true);

    const plainWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -10 });
    await act(async () => {
      viewport.dispatchEvent(plainWheel);
    });
    expect(plainWheel.defaultPrevented).toBe(false);
    expect(host.querySelector<HTMLElement>(".pm-diagram-svg-inner")?.style.transform).toBe("");

    const pinchWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -10,
      clientX: 40,
      clientY: 30,
    });
    await act(async () => {
      viewport.dispatchEvent(pinchWheel);
    });
    expect(pinchWheel.defaultPrevented).toBe(true);
    expect(host.querySelector<HTMLElement>(".pm-diagram-svg-inner")?.style.transform).toContain("scale(1.08)");

    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(removeSpy.mock.calls.some(([type]) => type === "wheel")).toBe(true);
  });
});
