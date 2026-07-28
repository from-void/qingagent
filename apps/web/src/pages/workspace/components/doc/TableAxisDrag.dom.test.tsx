import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTableAxisSelection, TableAxisSelectionExtension } from "../../data/tableToolbar";
import { TableControls } from "./TableControls";

/**
 * 真机 P1：列头长按拖拽松手后「列没动 + 光标跳文档最末尾」。两个病根各自钉死一组断言：
 *  1) 落位选区——整表 replaceWith 把旧 CellSelection 的两个 cell 位置一起映射到"表后一格"，
 *     CellSelection.map 随即降级成 TextSelection.between，光标落到表后的末块；
 *     落位事务必须显式把选区钉回移动后的那一列/行。
 *  2) 手势门——按下即拖(180ms 静止门之前位移就过阈值)必须进排序，
 *     不能永久沦为沿轴范围拖选，否则真机上"按住就拖"永远排不了序。
 */

let root: Root | null = null;
let editors: Editor[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  for (const editor of editors) editor.destroy();
  editors = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: left, y: top, width, height });
}

function setRect(element: Element, value: DOMRect): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
}

function cell(text: string, id: string) {
  return {
    type: "tableCell" as const,
    content: [{
      type: "paragraph" as const,
      attrs: { blockId: id },
      content: [{ type: "text" as const, text }],
    }],
  };
}

/** 表格是文档末块——真机复现光标"跳文末"的最短路径。 */
function setupTable() {
  const portal = document.createElement("div");
  portal.id = "view-workspace";
  const ws = document.createElement("div");
  ws.className = "ws-right";
  const editorHost = document.createElement("div");
  const controlsHost = document.createElement("div");
  ws.appendChild(editorHost);
  portal.append(ws, controlsHost);
  document.body.appendChild(portal);

  const editor = new Editor({
    element: editorHost,
    extensions: [...createQingagentExtensions(), TableAxisSelectionExtension],
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "table",
          attrs: { blockId: "table-1" },
          content: [
            { type: "tableRow", content: [cell("A1", "p-1"), cell("A2", "p-2"), cell("A3", "p-3")] },
            { type: "tableRow", content: [cell("B1", "p-4"), cell("B2", "p-5"), cell("B3", "p-6")] },
          ],
        },
      ],
    } satisfies PmDoc,
  });
  editors.push(editor);

  const tableElement = editor.view.dom.querySelector("table")!;
  const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
  setRect(wrapper, rect(90, 90, 320, 100));
  setRect(tableElement, rect(100, 100, 300, 80));
  [...tableElement.rows].forEach((row, rowIndex) => {
    setRect(row, rect(100, 100 + rowIndex * 40, 300, 40));
    [...row.cells].forEach((tableCell, colIndex) => {
      setRect(tableCell, rect(100 + colIndex * 100, 100 + rowIndex * 40, 100, 40));
    });
  });
  setRect(ws, rect(0, 0, 800, 600));

  root = createRoot(controlsHost);
  return { editor, portal };
}

async function renderControls(editor: Editor, onToast = vi.fn()) {
  await act(async () => {
    root!.render(<TableControls editor={editor} onAiModify={async () => true} onToast={onToast} />);
  });
  return onToast;
}

function rowTexts(editor: Editor): string[] {
  const table = editor.state.doc.firstChild!;
  return Array.from({ length: table.childCount }, (_, index) => table.child(index).textContent);
}

/** 只比表格子树：文末尾随空段由 schema 归一插入，与拖拽无关。 */
function tableJson(editor: Editor): unknown {
  return editor.state.doc.firstChild!.toJSON();
}

async function dispatchMouse(
  target: EventTarget,
  type: string,
  init: MouseEventInit,
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  });
}

describe("表格行列拖拽落位选区", () => {
  it("列拖到末尾后选区仍钉在这一列，不跳文档末尾", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 150, clientY: 95 });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await dispatchMouse(document, "mousemove", { clientX: 395, clientY: 95 });
    await dispatchMouse(document, "mouseup", { clientX: 395, clientY: 95 });

    expect(rowTexts(editor)).toEqual(["A2A3A1", "B2B3B1"]);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(editor.state.selection.from).toBeLessThan(editor.state.doc.content.size - 1);
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "column",
      startIndex: 2,
      endIndex: 2,
    });
  });

  it("向前拖列同样按落点钉选区", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[2]!;

    await dispatchMouse(header, "mousedown", { clientX: 350, clientY: 95 });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await dispatchMouse(document, "mousemove", { clientX: 105, clientY: 95 });
    await dispatchMouse(document, "mouseup", { clientX: 105, clientY: 95 });

    expect(rowTexts(editor)).toEqual(["A3A1A2", "B3B1B2"]);
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "column",
      startIndex: 0,
      endIndex: 0,
    });
  });

  it("行拖到末尾后选区仍钉在这一行，不跳文档末尾", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const header = portal.querySelectorAll(".tbl-row-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 95, clientY: 120 });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await dispatchMouse(document, "mousemove", { clientX: 95, clientY: 178 });
    await dispatchMouse(document, "mouseup", { clientX: 95, clientY: 178 });

    expect(rowTexts(editor)).toEqual(["B1B2B3", "A1A2A3"]);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "row",
      startIndex: 1,
      endIndex: 1,
    });
  });

  it("落位是单事务，一次 undo 即完全还原", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const before = tableJson(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 150, clientY: 95 });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await dispatchMouse(document, "mousemove", { clientX: 395, clientY: 95 });
    await dispatchMouse(document, "mouseup", { clientX: 395, clientY: 95 });
    expect(rowTexts(editor)).toEqual(["A2A3A1", "B2B3B1"]);

    await act(async () => {
      editor.commands.undo();
    });
    expect(tableJson(editor)).toEqual(before);
  });
});

describe("表格列头拖拽重排", () => {
  it("按下即拖(不静止等待)把首列拖到末尾，列序变化且选区仍钉在这一列", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 150, clientY: 95 });
    // 真机上人手按下即拖：位移在 180ms 静止门之前就已过阈值。
    await dispatchMouse(document, "mousemove", { clientX: 260, clientY: 95 });
    expect(portal.querySelector('.tbl-axis-drag-ghost[data-axis="column"]')).not.toBeNull();
    expect(portal.querySelector('.tbl-axis-drop-line[data-drop-boundary="2"]')).not.toBeNull();
    // 拖拽途中不得误弹选中工具栏。
    expect(portal.querySelector(".tbl-sel-toolbar")).toBeNull();

    await dispatchMouse(document, "mousemove", { clientX: 395, clientY: 95 });
    await dispatchMouse(document, "mouseup", { clientX: 395, clientY: 95 });

    expect(rowTexts(editor)).toEqual(["A2A3A1", "B2B3B1"]);
    // 光标绝不能被甩到文档最末尾：仍是整列 CellSelection，且落在移动后的第 3 列。
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(editor.state.selection.from).toBeLessThan(editor.state.doc.content.size - 1);
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "column",
      startIndex: 2,
      endIndex: 2,
    });
    expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();
  });

  it("短按列头仍是选列：不改文档、不出拖影、工具栏照常出现", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const before = tableJson(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[1]!;

    await dispatchMouse(header, "mousedown", { clientX: 250, clientY: 95 });
    // 轻微抖动仍在阈值内，属于点击而非拖拽。
    await dispatchMouse(document, "mousemove", { clientX: 252, clientY: 96 });
    await dispatchMouse(document, "mouseup", { clientX: 252, clientY: 96 });

    expect(tableJson(editor)).toEqual(before);
    expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "column",
      startIndex: 1,
      endIndex: 1,
    });
    expect(portal.querySelector(".tbl-sel-toolbar")).not.toBeNull();
  });

  it("Shift + 拖仍是沿轴范围拖选，既不重排也不留拖影", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const before = tableJson(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 150, clientY: 95, shiftKey: true });
    await dispatchMouse(document, "mousemove", { clientX: 250, clientY: 95, shiftKey: true });
    await act(async () => {
      vi.advanceTimersByTime(32);
    });
    await dispatchMouse(document, "mouseup", { clientX: 250, clientY: 95, shiftKey: true });

    expect(tableJson(editor)).toEqual(before);
    expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();
    expect(readTableAxisSelection(editor, "table-1")).toEqual({
      axis: "column",
      startIndex: 0,
      endIndex: 1,
    });
  });

  it("拖拽中按 Esc 取消：撤掉落位，随后松手也不改文档", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const before = tableJson(editor);
    const header = portal.querySelectorAll(".tbl-col-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 150, clientY: 95 });
    await dispatchMouse(document, "mousemove", { clientX: 395, clientY: 95 });
    expect(portal.querySelector(".tbl-axis-drag-ghost")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();

    await dispatchMouse(document, "mouseup", { clientX: 395, clientY: 95 });
    expect(tableJson(editor)).toEqual(before);
    expect(rowTexts(editor)).toEqual(["A1A2A3", "B1B2B3"]);
  });

  it("指针离开文档(mouseleave)同样取消拖拽，不改文档", async () => {
    const { editor, portal } = setupTable();
    await renderControls(editor);
    const before = tableJson(editor);
    const header = portal.querySelectorAll(".tbl-row-hdr")[0]!;

    await dispatchMouse(header, "mousedown", { clientX: 95, clientY: 120 });
    await dispatchMouse(document, "mousemove", { clientX: 95, clientY: 178 });
    expect(portal.querySelector(".tbl-axis-drag-ghost")).not.toBeNull();

    await dispatchMouse(document, "mouseleave", {});
    expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();

    await dispatchMouse(document, "mouseup", { clientX: 95, clientY: 178 });
    expect(tableJson(editor)).toEqual(before);
  });
});
