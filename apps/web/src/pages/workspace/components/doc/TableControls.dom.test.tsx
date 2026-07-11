import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectTableColumns } from "../../data/tableToolbar";
import { TableControls } from "./TableControls";

let root: Root | null = null;
let editors: Editor[] = [];
let rafQueue = new Map<number, FrameRequestCallback>();
let rafSequence = 0;
let resizeObservers: ResizeObserverStub[] = [];

class ResizeObserverStub {
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  flush() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  rafQueue = new Map();
  rafSequence = 0;
  resizeObservers = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++rafSequence;
    rafQueue.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id);
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  for (const editor of editors) editor.destroy();
  editors = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushAnimationFrames(): void {
  const queued = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [id, callback] of queued) callback(id);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: left, y: top, width, height });
}

function setRect(element: Element, value: DOMRect): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
}

function cell(text: string, id: string, attrs?: { colspan?: number; rowspan?: number }) {
  return {
    type: "tableCell" as const,
    ...(attrs ? { attrs } : {}),
    content: [{
      type: "paragraph" as const,
      attrs: { blockId: id },
      ...(text ? { content: [{ type: "text" as const, text }] } : {}),
    }],
  };
}

function table(blockId: string, prefix: string, merged = false) {
  if (merged) {
    return {
      type: "table" as const,
      attrs: { blockId },
      content: [
        { type: "tableRow" as const, content: [cell(`${prefix}1`, `p-${prefix}-1`, { colspan: 2 })] },
        { type: "tableRow" as const, content: [cell(`${prefix}2`, `p-${prefix}-2`), cell(`${prefix}3`, `p-${prefix}-3`)] },
      ],
    };
  }
  return {
    type: "table" as const,
    attrs: { blockId },
    content: [
      { type: "tableRow" as const, content: [cell(`${prefix}1`, `p-${prefix}-1`), cell(`${prefix}2`, `p-${prefix}-2`)] },
      { type: "tableRow" as const, content: [cell(`${prefix}3`, `p-${prefix}-3`), cell(`${prefix}4`, `p-${prefix}-4`)] },
    ],
  };
}

function setupTable(options: {
  blockId?: string;
  merged?: boolean;
  secondTable?: boolean;
  editable?: boolean;
} = {}) {
  const portal = document.createElement("div");
  portal.id = "view-workspace";
  const ws = document.createElement("div");
  ws.className = "ws-right";
  const editorHost = document.createElement("div");
  const controlsHost = document.createElement("div");
  ws.appendChild(editorHost);
  portal.append(ws, controlsHost);
  document.body.appendChild(portal);

  const firstId = options.blockId ?? "";
  const content = [
    table(firstId, "A", options.merged),
    ...(options.secondTable ? [table("table-2", "B")] : []),
  ];
  const editor = new Editor({
    element: editorHost,
    extensions: createQingagentExtensions(),
    editable: options.editable ?? true,
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content,
    } satisfies PmDoc,
  });
  editors.push(editor);
  editor.view.dom.classList.add("wf-doc");

  const tables = [...editor.view.dom.querySelectorAll("table")];
  for (const [tableIndex, tableElement] of tables.entries()) {
    const baseTop = 100 + tableIndex * 140;
    const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
    setRect(wrapper, rect(90, baseTop - 10, 220, 100));
    setRect(tableElement, rect(100, baseTop, 200, 80));
    [...tableElement.rows].forEach((row, rowIndex) => {
      setRect(row, rect(100, baseTop + rowIndex * 40, 200, 40));
      [...row.cells].forEach((tableCell, colIndex) => {
        const width = tableCell.colSpan > 1 ? 200 : 100;
        setRect(tableCell, rect(100 + colIndex * 100, baseTop + rowIndex * 40, width, 40));
      });
    });
  }
  setRect(ws, rect(0, 0, 800, 600));

  root = createRoot(controlsHost);
  return { editor, portal, ws, tables };
}

async function renderControls(editor: Editor, onAiModify = vi.fn(async () => true), onToast = vi.fn()) {
  await act(async () => {
    root!.render(<TableControls editor={editor} onAiModify={onAiModify} onToast={onToast} />);
  });
  return { onAiModify, onToast };
}

async function mouseDown(element: Element | null): Promise<void> {
  if (!element) throw new Error("target not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

describe("TableControls 真选区与 chrome", () => {
  it("行列头按下后 editor selection 是正确的 CellSelection", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    await renderControls(editor);

    await mouseDown(portal.querySelectorAll(".tbl-col-hdr")[1] ?? null);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect((editor.state.selection as CellSelection).isColSelection()).toBe(true);
    expect(portal.querySelectorAll(".tbl-col-hdr.active")).toHaveLength(1);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await mouseDown(portal.querySelectorAll(".tbl-row-hdr")[1] ?? null);
    expect((editor.state.selection as CellSelection).isRowSelection()).toBe(true);
    expect(portal.querySelectorAll(".tbl-row-hdr.active")).toHaveLength(1);
  });

  it("两张表选列只产生当前表的 selectedCell，不注入全局 nth-child CSS", async () => {
    const { editor, portal, tables } = setupTable({ blockId: "table-1", secondTable: true });
    const secondCell = tables[1]!.rows[0]!.cells[0]!;
    const textNode = secondCell.querySelector("p")?.firstChild;
    if (!textNode) throw new Error("second table text node not found");
    editor.commands.setTextSelection(editor.view.posAtDOM(textNode, 0));
    await renderControls(editor);

    await mouseDown(portal.querySelector(".tbl-col-hdr"));
    expect(tables[0]!.querySelectorAll(".selectedCell")).toHaveLength(0);
    expect(tables[1]!.querySelectorAll(".selectedCell")).toHaveLength(2);
    expect([...document.head.querySelectorAll("style")].some((style) => style.textContent?.includes("nth-child"))).toBe(false);
  });

  it("含 span 的表不渲染任何行列 chrome，只显示延期提示", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", merged: true });
    await renderControls(editor);

    expect(portal.querySelector(".tbl-span-hint")?.textContent).toContain("含合并单元格的表格暂不支持行列操作");
    expect(portal.querySelector(".tbl-col-hdr")).toBeNull();
    expect(portal.querySelector(".tbl-row-hdr")).toBeNull();
    expect(portal.querySelector(".tbl-dot")).toBeNull();
    expect(portal.querySelector(".tbl-sel-toolbar")).toBeNull();
  });

  it("只读态不渲染表格 chrome", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", editable: false });
    await renderControls(editor);
    expect(portal.querySelector(".tbl-chrome-viewport")).toBeNull();
    expect(portal.querySelector(".tbl-span-hint")).toBeNull();
  });

  it("首位圆点分别调用 addColumnBefore 与 addRowBefore", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    await renderControls(editor);

    await act(async () => {
      portal.querySelector<HTMLButtonElement>('[data-table-insert="column-before"]')?.click();
    });
    expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(3);

    await act(async () => {
      portal.querySelector<HTMLButtonElement>('[data-table-insert="row-before"]')?.click();
    });
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
  });

  it("所有行列头和插入圆点均位于裁剪 viewport 内", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    await renderControls(editor);
    const viewport = portal.querySelector(".tbl-chrome-viewport");
    expect(viewport).not.toBeNull();
    for (const chrome of portal.querySelectorAll(".tbl-col-hdr,.tbl-row-hdr,.tbl-dot")) {
      expect(chrome.closest(".tbl-chrome-viewport")).toBe(viewport);
      expect((chrome as HTMLElement).style.position).toBe("absolute");
    }
  });

  it("window resize 与 ResizeObserver 都会按新 rect 重新测量", async () => {
    const { editor, portal, tables } = setupTable({ blockId: "table-1" });
    await renderControls(editor);
    const tableElement = tables[0]!;
    const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
    setRect(wrapper, rect(190, 190, 260, 120));
    setRect(tableElement, rect(200, 200, 200, 80));
    [...tableElement.rows].forEach((row, rowIndex) => {
      setRect(row, rect(200, 200 + rowIndex * 40, 200, 40));
      [...row.cells].forEach((tableCell, colIndex) => {
        setRect(tableCell, rect(200 + colIndex * 100, 200 + rowIndex * 40, 100, 40));
      });
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      flushAnimationFrames();
    });
    expect((portal.querySelector(".tbl-chrome-viewport") as HTMLElement).style.left).toBe("182px");

    setRect(wrapper, rect(290, 290, 260, 120));
    resizeObservers[0]?.flush();
    await act(async () => flushAnimationFrames());
    expect((portal.querySelector(".tbl-chrome-viewport") as HTMLElement).style.left).toBe("282px");
  });
});

describe("TableControls AI 修改", () => {
  it("回调 false 保留真选区，只有 true 才清除", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    const onAiModify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await renderControls(editor, onAiModify);
    await mouseDown(portal.querySelector(".tbl-row-hdr"));

    await act(async () => {
      portal.querySelector<HTMLButtonElement>(".dt-ai")?.click();
    });
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(onAiModify).toHaveBeenLastCalledWith(expect.objectContaining({
      blockId: "table-1",
      label: "A1 | A2",
      suffix: "表格·第1行",
      tableSelection: expect.objectContaining({ axis: "row", startIndex: 0, endIndex: 0 }),
    }));

    await act(async () => {
      portal.querySelector<HTMLButtonElement>(".dt-ai")?.click();
    });
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(portal.querySelector(".tbl-row-hdr.active")).toBeNull();
  });

  it("表缺 blockId 时表头拒绝建选区并 toast", async () => {
    const { editor, portal } = setupTable();
    const onToast = vi.fn();
    await renderControls(editor, vi.fn(async () => true), onToast);
    await mouseDown(portal.querySelector(".tbl-row-hdr"));
    expect(onToast).toHaveBeenCalledWith("无法定位表格,请重新选择");
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
  });
});

describe("TableControls 大表拖选基准", () => {
  it("100×100 表拖选 20 步按 rAF 合并 dispatch，且不超时", async () => {
    const startedAt = performance.now();
    const portal = document.createElement("div");
    portal.id = "view-workspace";
    const ws = document.createElement("div");
    ws.className = "ws-right";
    const editorHost = document.createElement("div");
    const controlsHost = document.createElement("div");
    ws.appendChild(editorHost);
    portal.append(ws, controlsHost);
    document.body.appendChild(portal);
    const rows = Array.from({ length: 100 }, (_, rowIndex) => ({
      type: "tableRow" as const,
      content: Array.from({ length: 100 }, (_, colIndex) =>
        cell("", `p-${rowIndex}-${colIndex}`)),
    }));
    const editor = new Editor({
      element: editorHost,
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "table", attrs: { blockId: "table-large" }, content: rows }],
      } satisfies PmDoc,
    });
    editors.push(editor);
    editor.view.dom.classList.add("wf-doc");
    const tableElement = editor.view.dom.querySelector("table")!;
    const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
    setRect(wrapper, rect(0, 0, 1000, 2000));
    setRect(tableElement, rect(0, 10, 1000, 2000));
    [...tableElement.rows].forEach((row, rowIndex) => {
      setRect(row, rect(0, 10 + rowIndex * 20, 1000, 20));
      [...row.cells].forEach((tableCell, colIndex) => {
        setRect(tableCell, rect(colIndex * 10, 10 + rowIndex * 20, 10, 20));
      });
    });
    setRect(ws, rect(0, 0, 1000, 800));
    root = createRoot(controlsHost);
    await renderControls(editor);
    const dispatchSpy = vi.spyOn(editor.view, "dispatch");

    await mouseDown(portal.querySelector(".tbl-col-hdr"));
    await act(async () => {
      for (let step = 1; step <= 20; step++) {
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: step * 10 - 1, clientY: 20, bubbles: true }));
      }
      flushAnimationFrames();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(dispatchSpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(selectTableColumns(editor, "table-large", 0, 19)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);
});
