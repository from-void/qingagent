// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_USER_PREVIEW_MAX_CODE_POINTS,
  AskUserPreview,
  truncateAskUserPreview,
} from "./AskUserPreview";

vi.mock("./mermaidRender", () => ({
  renderMermaid: vi.fn().mockRejectedValue(new Error("测试降级")),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("AskUserPreview", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it("只渲染标题、正文、引用和列表白名单", async () => {
    await render([
      "## 样张标题",
      "正文 **重点**",
      "> 引用内容",
      "- 第一项",
      "- 第二项",
      "![被过滤图片](/api/v1/files/550e8400-e29b-41d4-a716-446655440000/x.png)",
      "| 表头 |",
      "| --- |",
      "| 内容 |",
      "$$x^2$$",
    ].join("\n"));

    expect(host?.querySelector("h2")?.textContent).toBe("样张标题");
    expect(host?.querySelector("strong")?.textContent).toBe("重点");
    expect(host?.querySelector("blockquote")?.textContent).toContain("引用内容");
    expect(host?.querySelectorAll("li")).toHaveLength(2);
    expect(host?.querySelector("img")).toBeNull();
    expect(host?.querySelector("table")).toBeNull();
    expect(host?.querySelector(".tiptap-mathematics-render")).toBeNull();
  });

  it("把裸 HTML 当普通文字渲染，不创建元素", async () => {
    await render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');

    expect(host?.querySelector("img")).toBeNull();
    expect(host?.querySelector("script")).toBeNull();
    expect(host?.textContent).toContain("<img src=x");
    expect(host?.textContent).toContain("<script>alert(2)</script>");
  });

  it("parser 拒绝非法资源时安全降级为转义源码", async () => {
    await render("![外链图片](https://example.com/unsafe.png)");

    expect(host?.querySelector("img")).toBeNull();
    expect(host?.querySelector(".auq-preview-fallback")?.textContent).toContain("https://example.com/unsafe.png");
  });

  it("Mermaid 失败时降级显示源码", async () => {
    const source = "flowchart TD\nA-->";
    await render(`\`\`\`mermaid\n${source}\n\`\`\``);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host?.querySelector(".pm-diagram-error")?.textContent).toContain("图表渲染失败");
    expect(host?.querySelector(".pm-diagram-error")?.textContent).toContain(source);
  });

  it("点击 Mermaid 打开放大层，Esc 与点外关闭", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    document.body.appendChild(workspace);
    const source = "flowchart TD\nA-->B";
    await render(`\`\`\`mermaid\n${source}\n\`\`\``);

    const trigger = host!.querySelector<HTMLElement>(".auq-preview-diagram")!;
    trigger.focus();
    await click(trigger);
    expect(workspace.querySelector('[data-wf="AskUserPreviewLightbox"]')).not.toBeNull();
    expect(document.activeElement).toBe(workspace.querySelector(".auq-lightbox-close"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(workspace.querySelector('[data-wf="AskUserPreviewLightbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(host!.querySelector<HTMLElement>(".auq-preview-diagram")!);
    await click(workspace.querySelector<HTMLElement>(".auq-lightbox")!);
    expect(workspace.querySelector('[data-wf="AskUserPreviewLightbox"]')).toBeNull();
    workspace.remove();
  });

  it("按 Unicode code point 截断到 800 后追加省略号", () => {
    const source = "你".repeat(ASK_USER_PREVIEW_MAX_CODE_POINTS + 1);
    const truncated = truncateAskUserPreview(source);

    expect(Array.from(truncated)).toHaveLength(ASK_USER_PREVIEW_MAX_CODE_POINTS + 1);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

async function render(markdown: string): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<AskUserPreview markdown={markdown} />);
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
