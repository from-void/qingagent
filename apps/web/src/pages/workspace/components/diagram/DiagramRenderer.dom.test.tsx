import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramRenderer } from "./DiagramRenderer";

vi.mock("./GraphDiagramView", () => ({
  GraphDiagramView: () => <div data-renderer="graph" />,
}));

vi.mock("../MermaidPreview", () => ({
  MermaidPreview: () => <div data-renderer="preview" />,
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("DiagramRenderer", () => {
  it("解析失败的已知 Mermaid 类型降级到源码预览", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<DiagramRenderer source={"flowchart TD\n  A[节点]\n  end\n"} lang="mermaid" readOnly={false} />);
      await Promise.resolve();
    });

    expect(host.querySelector('[data-renderer="preview"]')).not.toBeNull();
    expect(host.querySelector('[data-renderer="graph"]')).toBeNull();
  });

  it("非 base 主题降级时保留预览并明确说明可视化编辑不可用原因", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <DiagramRenderer
          source={'%%{init: {"theme":"dark"}}%%\nflowchart TD\n  A --> B\n'}
          lang="mermaid"
          readOnly={false}
        />,
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-renderer="preview"]')).not.toBeNull();
    expect(host.querySelector('[data-renderer="graph"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("主题 dark 暂不支持");
  });
});
