// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidPreview } from "./MermaidPreview";
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
});
