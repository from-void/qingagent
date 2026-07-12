// @vitest-environment jsdom

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Editor } from "@tiptap/core";
import type { PmDoc, PmTableNode } from "@qingagent/pm-schema";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmBlockView, PmTypewriterTableView } from "../../components/doc/PmStaticView";
import { TableStickyColumnExtension } from "../../data/tableStickyColumn";

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("合并表标题列 sticky 标记", () => {
  it("编辑态按逻辑第 0 列标记 rowspan 本体，关闭标题列后清理属性", () => {
    const host = document.body.appendChild(document.createElement("div"));
    editor = new Editor({
      element: host,
      extensions: [...createQingagentExtensions(), TableStickyColumnExtension],
      content: documentWithRowspanHeaderColumn(),
    });

    expect([...host.querySelectorAll("[data-sticky-col]")].map((cell) => cell.textContent)).toEqual(["部门", "销售"]);
    expect([...host.querySelectorAll("[data-table-logical-col]")].map((cell) => cell.getAttribute("data-table-logical-col")))
      .toEqual(["0", "1", "1", "0", "1"]);
    editor.commands.setTextSelection(4);
    expect(editor.chain().focus().toggleHeaderColumn().run()).toBe(true);
    expect(host.querySelectorAll("[data-sticky-col]")).toHaveLength(0);
  });

  it("静态视图同样只标记逻辑首列 origin cell", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const table = documentWithRowspanHeaderColumn().content[0] as PmTableNode;
    act(() => root?.render(<PmBlockView node={table} />));

    expect([...host.querySelectorAll("[data-sticky-col]")].map((cell) => cell.textContent)).toEqual(["部门", "销售"]);
    expect([...host.querySelectorAll("[data-table-logical-col]")].map((cell) => cell.getAttribute("data-table-logical-col")))
      .toEqual(["0", "1", "1", "0", "1"]);
  });

  it("静态横滚容器按 rAF 切换状态属性", () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const table = documentWithRowspanHeaderColumn().content[0] as PmTableNode;
    act(() => root?.render(<PmBlockView node={table} />));
    const wrapper = host.querySelector<HTMLElement>(".pm-table-scroll")!;
    Object.defineProperty(wrapper, "scrollLeft", { configurable: true, writable: true, value: 20 });

    wrapper.dispatchEvent(new Event("scroll"));
    expect(wrapper.hasAttribute("data-scrolled-x")).toBe(false);
    act(() => pendingFrame?.(0));
    expect(wrapper.hasAttribute("data-scrolled-x")).toBe(true);
  });

  it("流式静态表沿用标题列 sticky 语义", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const table = documentWithRowspanHeaderColumn().content[0] as PmTableNode;
    act(() => root?.render(<PmTypewriterTableView node={table} blockIndex={0} typedCounts={new Map()} />));

    expect([...host.querySelectorAll("[data-sticky-col]")].map((cell) => cell.textContent)).toEqual(["部门", "销售"]);
  });
});

function documentWithRowspanHeaderColumn(): PmDoc {
  const paragraph = (blockId: string, text: string) => ({
    type: "paragraph" as const,
    attrs: { blockId },
    content: [{ type: "text" as const, text }],
  });
  const cell = (type: "tableCell" | "tableHeader", blockId: string, text: string, rowspan = 1) => ({
    type,
    attrs: { colspan: 1, rowspan, colwidth: null, backgroundColor: null },
    content: [paragraph(blockId, text)],
  });
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "table",
      attrs: { blockId: "budget" },
      content: [
        { type: "tableRow", content: [cell("tableHeader", "dept", "部门", 2), cell("tableCell", "q1", "一季度")] },
        { type: "tableRow", content: [cell("tableCell", "q2", "二季度")] },
        { type: "tableRow", content: [cell("tableHeader", "sales", "销售"), cell("tableCell", "q3", "三季度")] },
      ],
    }],
  };
}
