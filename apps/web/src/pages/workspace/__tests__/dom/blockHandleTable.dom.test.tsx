// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it } from "vitest";
import { BlockHandle } from "../../components/doc/BlockHandle";
import {
  readTableBlockMenuState,
  setEvenTableColumnWidths,
  toggleTableHeader,
} from "../../components/doc/blockHandleTable";
import { glyphForBlock } from "../../components/doc/blockHandleGeometry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("BlockHandle 表格专属菜单", () => {
  it("空表仍显示完整表格菜单，且隐藏转换格式", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, basicTable());
    editor.commands.setTextSelection(4);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));

    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    const menu = workspace.querySelector<HTMLElement>(".block-handle-menu");
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("剪切复制删除标题行标题列均分列宽在下方添加");
    expect(menu?.textContent).not.toContain("转换为");
  });

  it("块菜单尺寸浮层在当前表格下方插入指定大小的无标题行表格", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, basicTable());
    editor.commands.setTextSelection(4);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const addBelow = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("在下方添加"));
    await act(async () => addBelow?.focus());
    const insertTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"));
    expect(insertTable).not.toBeUndefined();
    await act(async () => insertTable?.click());
    await act(async () => {
      workspace.querySelector<HTMLButtonElement>('[data-row="2"][data-col="3"]')?.click();
    });

    const doc = editor.getJSON() as { content?: Array<{ type?: string; content?: Array<{ content?: Array<{ type?: string }> }> }> };
    const inserted = doc.content?.[1];
    expect(inserted?.type).toBe("table");
    expect(inserted?.content).toHaveLength(2);
    expect(inserted?.content?.every((row) => row.content?.length === 3)).toBe(true);
    expect(inserted?.content?.flatMap((row) => row.content ?? []).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it("空段落入口通过尺寸浮层插入指定大小的无标题行表格", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, paragraph("empty"));
    editor.commands.setTextSelection(1);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const insertTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"));
    expect(insertTable).not.toBeUndefined();
    await act(async () => insertTable?.click());
    await act(async () => {
      workspace.querySelector<HTMLButtonElement>('[data-row="4"][data-col="2"]')?.click();
    });

    const doc = editor.getJSON() as { content?: Array<{ type?: string; content?: Array<{ content?: Array<{ type?: string }> }> }> };
    const inserted = doc.content?.[1];
    expect(inserted?.type).toBe("table");
    expect(inserted?.content).toHaveLength(4);
    expect(inserted?.content?.every((row) => row.content?.length === 2)).toBe(true);
    expect(inserted?.content?.flatMap((row) => row.content ?? []).every((tableCell) => tableCell.type === "tableCell")).toBe(true);
  });

  it("尺寸浮层可跨菜单间隙抵达，hover 同级其他项时立即收起", async () => {
    const workspace = document.createElement("div");
    workspace.id = "view-workspace";
    const editorElement = document.createElement("div");
    const reactHost = document.createElement("div");
    workspace.append(editorElement, reactHost);
    document.body.appendChild(workspace);
    editor = createEditor(editorElement, paragraph("empty"));
    editor.commands.setTextSelection(1);
    root = createRoot(reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));
    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });

    const menu = workspace.querySelector<HTMLElement>(".block-handle-menu")!;
    const insertTable = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"))!;
    const inlineMath = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("行内公式"))!;

    await act(async () => {
      insertTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const picker = workspace.querySelector<HTMLElement>(".table-size-picker")!;
    expect(picker).not.toBeNull();

    await act(async () => {
      menu.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: picker }));
      picker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: menu }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(workspace.querySelector(".table-size-picker")).not.toBeNull();

    await act(async () => {
      inlineMath.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: insertTable }));
    });
    expect(workspace.querySelector(".table-size-picker")).toBeNull();

    await act(async () => {
      insertTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(workspace.querySelector(".block-handle-menu")).toBeNull();
    expect(workspace.querySelector(".table-size-picker")).toBeNull();

    await act(async () => {
      editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
        key: "/", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    const reopenedTable = Array.from(workspace.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes("插入表格"))!;
    await act(async () => {
      reopenedTable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(workspace.querySelector(".block-handle-menu")).toBeNull();
    expect(workspace.querySelector(".table-size-picker")).toBeNull();
  });

  it("标题行列状态按真实 cell 类型读取，并由 Tiptap 命令写回", () => {
    editor = createEditor(undefined, basicTable());
    const table = () => editor!.state.doc.nodeAt(0)!;
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: false, hasHeaderColumn: false });

    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: true, hasHeaderColumn: false });
    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(readTableBlockMenuState(table())).toEqual({ hasHeaderRow: true, hasHeaderColumn: true });
  });

  it("开关标题行列保留数据格类型与自定义底色", () => {
    editor = createEditor(undefined, coloredTable());
    const table = () => editor!.state.doc.nodeAt(0)!;
    const dataCell = () => table().child(1).child(1);

    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
    expect(table().child(1).child(0).attrs.backgroundColor).toBe("amber");

    expect(toggleTableHeader(editor, 0, "column")).toBe(true);
    expect(toggleTableHeader(editor, 0, "row")).toBe(true);
    expect(dataCell().type.name).toBe("tableCell");
    expect(dataCell().attrs.backgroundColor).toBe("green");
  });

  it("均分列宽为 span cell 写入与 colspan 等长的 colwidth，并通过 PM 校验", () => {
    editor = createEditor(undefined, spanTable());
    expect(setEvenTableColumnWidths(editor, 0, 603)).toBe(true);

    const table = editor.state.doc.nodeAt(0)!;
    const firstRow = table.child(0);
    expect(firstRow.child(0).attrs.colwidth).toEqual([201, 201]);
    expect(firstRow.child(1).attrs.colwidth).toEqual([201]);
    for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
      const row = table.child(rowIndex);
      for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
        const cell = row.child(cellIndex);
        expect(cell.attrs.colwidth).toHaveLength(cell.attrs.colspan);
      }
    }
    expect(() => editor!.state.doc.check()).not.toThrow();
  });

  it("无 DOM 可用宽度时沿用现有逻辑列总宽，表格 glyph 使用专属图标标识", () => {
    editor = createEditor(undefined, spanTable());
    expect(setEvenTableColumnWidths(editor, 0)).toBe(true);
    const table = editor.state.doc.nodeAt(0)!;
    expect(table.child(1).child(0).attrs.colwidth).toEqual([200]);
    expect(glyphForBlock(table)).toBe("table");
  });
});

function createEditor(element: HTMLElement | undefined, table: Record<string, unknown>): Editor {
  const editorElement = element ?? document.body.appendChild(document.createElement("div"));
  return new Editor({
    element: editorElement,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [table],
    } as PmDoc,
  });
}

function paragraph(blockId: string) {
  return { type: "paragraph", attrs: { blockId } };
}

function cell(blockId: string, attrs?: Record<string, unknown>) {
  return { type: "tableCell", attrs, content: [paragraph(blockId)] };
}

function basicTable() {
  return {
    type: "table",
    attrs: { blockId: "table-basic" },
    content: [
      { type: "tableRow", content: [cell("a"), cell("b")] },
      { type: "tableRow", content: [cell("c"), cell("d")] },
    ],
  };
}

function coloredTable() {
  return {
    type: "table",
    attrs: { blockId: "table-colored" },
    content: [
      { type: "tableRow", content: [cell("a"), cell("b"), cell("c")] },
      { type: "tableRow", content: [cell("d", { backgroundColor: "amber" }), cell("e", { backgroundColor: "green" }), cell("f")] },
      { type: "tableRow", content: [cell("g"), cell("h"), cell("i")] },
    ],
  };
}

function spanTable() {
  return {
    type: "table",
    attrs: { blockId: "table-span" },
    content: [
      {
        type: "tableRow",
        content: [
          cell("a", { colspan: 2, rowspan: 1, colwidth: [120, 180] }),
          cell("b", { colspan: 1, rowspan: 1, colwidth: [300] }),
        ],
      },
      {
        type: "tableRow",
        content: [
          cell("c", { colspan: 1, rowspan: 1, colwidth: [120] }),
          cell("d", { colspan: 1, rowspan: 1, colwidth: [180] }),
          cell("e", { colspan: 1, rowspan: 1, colwidth: [300] }),
        ],
      },
    ],
  };
}
