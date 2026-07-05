// @vitest-environment jsdom

// 回归:审核态(showPatches=true)格式保真。根因是审核态曾走 ViewBlock 降级渲染器,
// 把 taskList 降成 [ ] 字面列表、callout 降成引用、blockMath 降成 latex 代码块、columnList
// 拍平成纵向堆叠;现在这几类携带原始 pm 节点,用 PmBlockView 渲染,与最终态一致。
// 同时校验:文字块整块新增不再套块状背景(无 .wf-blockpatch)。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import { pmDocToViewDocumentSnapshot } from "../../data/protocol";
import { DocumentSnapshotView } from "../../components/DocumentSnapshotView";

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.id = "view-workspace";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderReview(content: PmBlockNode[]) {
  const doc: PmDoc = { type: "doc", attrs: { schemaVersion: 1 }, content };
  const snapshot = pmDocToViewDocumentSnapshot(doc, 1, "t");
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={snapshot}
        editable={false}
        showPatches
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
      />,
    );
  });
}

describe("审核态格式保真(showPatches)", () => {
  it("taskList 渲染真实复选框,不再是 [ ]/[x] 字面文本", () => {
    renderReview([
      {
        type: "taskList",
        attrs: { blockId: "tl-1" },
        content: [
          { type: "taskItem", attrs: { blockId: "ti-1", checked: true }, content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "已完成项" }] }] },
          { type: "taskItem", attrs: { blockId: "ti-2", checked: false }, content: [{ type: "paragraph", attrs: { blockId: "p-2" }, content: [{ type: "text", text: "待办项" }] }] },
        ],
      } as PmBlockNode,
    ]);

    const checkboxes = host.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    expect(host.querySelector('[data-type="taskList"]')).not.toBeNull();
    // 不得出现转义前的字面 [ ] / [x]
    expect(host.textContent).not.toContain("[ ]");
    expect(host.textContent).not.toContain("[x]");
    expect(host.textContent).toContain("待办项");
  });

  it("callout 渲染提示框(emoji + tone),不再降级成引用块", () => {
    renderReview([
      {
        type: "callout",
        attrs: { blockId: "c-1", emoji: "💡", tone: "info" },
        content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "提示文案" }] }],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".pm-callout")).not.toBeNull();
    expect(host.querySelector(".pm-callout--info")).not.toBeNull();
    expect(host.querySelector("blockquote")).toBeNull();
    expect(host.textContent).toContain("提示文案");
  });

  it("columnList 保留并排分栏,不再拍平成纵向堆叠", () => {
    renderReview([
      {
        type: "columnList",
        attrs: { blockId: "cl-1" },
        content: [
          { type: "column", attrs: { blockId: "col-1", widthRatio: 0.5 }, content: [{ type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "左栏" }] }] },
          { type: "column", attrs: { blockId: "col-2", widthRatio: 0.5 }, content: [{ type: "paragraph", attrs: { blockId: "p-2" }, content: [{ type: "text", text: "右栏" }] }] },
        ],
      } as PmBlockNode,
    ]);

    expect(host.querySelector(".pm-column-list")).not.toBeNull();
    expect(host.querySelectorAll(".pm-column")).toHaveLength(2);
    expect(host.textContent).toContain("左栏");
    expect(host.textContent).toContain("右栏");
  });

  it("blockMath 渲染 KaTeX,不再降级成 latex 源码代码块", () => {
    renderReview([
      { type: "blockMath", attrs: { blockId: "m-1", latex: "E = mc^2" } } as PmBlockNode,
    ]);

    // KaTeX 渲染产物(MathView 用 tiptap-mathematics-render 容器),不是裸代码块
    expect(host.querySelector(".tiptap-mathematics-render, .katex")).not.toBeNull();
    expect(host.querySelector("pre.md-code-block")).toBeNull();
  });

  it("文字块(标题/段落)保真渲染,审核态不套块状背景", () => {
    renderReview([
      { type: "heading", attrs: { blockId: "h-1", level: 2, textAlign: "center" }, content: [{ type: "text", text: "居中标题" }] } as PmBlockNode,
    ]);

    const h2 = host.querySelector("h2");
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toContain("居中标题");
    // 文字对齐保真(此前审核态丢失)
    expect((h2 as HTMLElement).style.textAlign).toBe("center");
    // 旧的块状背景类彻底移除
    expect(host.querySelector(".wf-blockpatch")).toBeNull();
    expect(host.querySelector(".wf-block-patch-marker")).toBeNull();
  });
});
