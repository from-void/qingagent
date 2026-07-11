import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { pmToMarkdown, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectTableColumns, setTableCellSelectionFromDom, TableAxisSelectionExtension } from "../../data/tableToolbar";
import { TableControls } from "./TableControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let editors: Editor[] = [];
let rafQueue = new Map<number, FrameRequestCallback>();
let rafSequence = 0;
let resizeObservers: ResizeObserverStub[] = [];
let previousResizeObserver: typeof ResizeObserver | undefined;

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
  previousResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
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
  if (previousResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: previousResizeObserver,
    });
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
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
    {
      type: "paragraph" as const,
      attrs: { blockId: "tail" },
      content: [{ type: "text" as const, text: "尾段" }],
    },
  ];
  const editor = new Editor({
    element: editorHost,
    extensions: [...createQingagentExtensions(), TableAxisSelectionExtension],
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
  it("矩形 CellSelection 可见合并按钮，合并后可见拆分按钮", async () => {
    const { editor, portal, tables } = setupTable({ blockId: "table-1" });
    const cells = tables[0]!.querySelectorAll("td");
    expect(setTableCellSelectionFromDom(editor, cells[0] as HTMLTableCellElement, cells[1] as HTMLTableCellElement)).toBe(true);
    await renderControls(editor);
    const merge = portal.querySelector<HTMLButtonElement>('[title="合并单元格"]');
    expect(merge?.disabled).toBe(false);
    await act(async () => { merge?.click(); });
    const split = portal.querySelector<HTMLButtonElement>('[title="拆分单元格"]');
    expect(split?.disabled).toBe(false);
  });
  it("HTML 粘贴合并表后可显示逻辑列头、删列、AI 回填并正确导出 md", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    const tail = editor.view.dom.querySelector('[data-block-id="tail"]')?.firstChild;
    if (!tail) throw new Error("tail not found");
    editor.commands.setTextSelection(editor.view.posAtDOM(tail, 0));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      files: [],
      getData: (type: string) => type === "text/html"
        ? '<table><tr><th colspan="2">合并头</th><th>右</th></tr><tr><td rowspan="2">跨行</td><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>'
        : "",
      setData: () => undefined,
    } });
    editor.view.dom.dispatchEvent(event);
    const pasted = editor.view.dom.querySelectorAll("table")[1];
    expect(pasted).toBeTruthy();
    const text = pasted?.querySelector("td")?.firstChild;
    if (!text) throw new Error("pasted cell not found");
    editor.commands.setTextSelection(editor.view.posAtDOM(text, 0));
    const { onAiModify } = await renderControls(editor);
    expect(portal.querySelectorAll(".tbl-col-hdr")).toHaveLength(3);
    await mouseDown(portal.querySelectorAll(".tbl-col-hdr")[2] ?? null);
    const ai = portal.querySelector<HTMLButtonElement>('.tbl-sel-toolbar [title="发送到对话"]');
    expect(ai?.disabled).toBe(false);
    await act(async () => { ai?.click(); });
    expect(onAiModify).toHaveBeenCalled();
    await act(async () => { portal.querySelector<HTMLButtonElement>('.tbl-sel-toolbar [title="删除列"]')?.click(); });
    expect(pmToMarkdown(editor.getJSON() as unknown as PmDoc)).toContain("<table>");
    expect(pmToMarkdown(editor.getJSON() as unknown as PmDoc)).toContain('rowspan="2"');
  });
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

  it("含 span 的表按逻辑列渲染行列 chrome，并允许原生整列选区", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", merged: true });
    await renderControls(editor);

    expect(portal.querySelectorAll(".tbl-col-hdr")).toHaveLength(2);
    expect(portal.querySelectorAll(".tbl-row-hdr")).toHaveLength(2);
    expect(portal.querySelector(".tbl-span-hint")).toBeNull();
    await mouseDown(portal.querySelectorAll(".tbl-col-hdr")[1] ?? null);
    expect((editor.state.selection as CellSelection).isColSelection()).toBe(true);
  });

  it("colspan 表每个逻辑列插入点都生效，内部边界扩展原 span", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", merged: true });
    await renderControls(editor);
    const dots = portal.querySelectorAll<HTMLButtonElement>(".tbl-dot-col");
    expect(dots).toHaveLength(3);
    await act(async () => { dots[1]?.click(); });
    const json = editor.getJSON() as unknown as PmDoc;
    const table = json.content[0];
    expect(table?.type === "table" ? table.content[0]?.content[0]?.attrs?.colspan : null).toBe(3);
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
    const { editor, portal, tables } = setupTable({ blockId: "table-1" });
    const tableElement = tables[0]!;
    setRect(tableElement, rect(100, 100, 400, 80));
    [...tableElement.rows].forEach((row, rowIndex) => {
      setRect(row, rect(100, 100 + rowIndex * 40, 400, 40));
      [...row.cells].forEach((tableCell, colIndex) => {
        setRect(tableCell, rect(100 + colIndex * 200, 100 + rowIndex * 40, 200, 40));
      });
    });
    await renderControls(editor);
    const viewport = portal.querySelector(".tbl-chrome-viewport");
    expect(viewport).not.toBeNull();
    for (const chrome of portal.querySelectorAll(".tbl-col-hdr,.tbl-row-hdr,.tbl-dot")) {
      expect(chrome.closest(".tbl-chrome-viewport")).toBe(viewport);
      expect((chrome as HTMLElement).style.position).toBe("absolute");
    }
    const viewportWidth = Number.parseFloat((viewport as HTMLElement).style.width);
    const lastColumnDot = [...portal.querySelectorAll<HTMLElement>(".tbl-dot-col")].at(-1)!;
    expect(Number.parseFloat(lastColumnDot.style.left)).toBeGreaterThan(viewportWidth);
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

  it("wrapper 横滚会重测；离开表格立即解除旧 wrapper 与 observer", async () => {
    const { editor, portal, tables } = setupTable({ blockId: "table-1" });
    const tableElement = tables[0]!;
    const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
    const removeSpy = vi.spyOn(wrapper, "removeEventListener");
    await renderControls(editor);
    const observer = resizeObservers[0]!;
    expect(observer.observed.has(wrapper)).toBe(true);
    expect(observer.observed.has(tableElement)).toBe(true);

    setRect(wrapper, rect(390, 90, 220, 100));
    await act(async () => {
      wrapper.dispatchEvent(new Event("scroll"));
      flushAnimationFrames();
    });
    expect((portal.querySelector(".tbl-chrome-viewport") as HTMLElement).style.left).toBe("382px");

    const tailText = editor.view.dom.querySelector('[data-block-id="tail"]')?.firstChild;
    if (!tailText) throw new Error("tail text not found");
    await act(async () => {
      editor.commands.setTextSelection(editor.view.posAtDOM(tailText, 0));
    });
    expect(portal.querySelector(".tbl-chrome-viewport")).toBeNull();
    expect(observer.observed.has(wrapper)).toBe(false);
    expect(observer.observed.has(tableElement)).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("组件卸载会清理 wrapper scroll、ResizeObserver 与待执行 rAF", async () => {
    const { editor, tables } = setupTable({ blockId: "table-1" });
    const tableElement = tables[0]!;
    const wrapper = tableElement.closest(".tableWrapper") ?? tableElement;
    const removeSpy = vi.spyOn(wrapper, "removeEventListener");
    await renderControls(editor);
    const observer = resizeObservers[0]!;
    window.dispatchEvent(new Event("resize"));
    expect(rafQueue.size).toBeGreaterThan(0);

    act(() => root?.unmount());
    root = null;
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(observer.observed.size).toBe(0);
    expect(rafQueue.size).toBe(0);
  });
});

describe("TableControls 行列拖拽排序", () => {
  it("长按行头显示拖影/落点线并单事务移动到末尾", async () => {
    vi.useFakeTimers();
    try {
      const { editor, portal } = setupTable({ blockId: "table-1" });
      await renderControls(editor);
      const rowHeader = portal.querySelectorAll(".tbl-row-hdr")[0]!;
      await act(async () => {
        rowHeader.dispatchEvent(new MouseEvent("mousedown", { clientX: 95, clientY: 120, bubbles: true }));
        vi.advanceTimersByTime(181);
      });
      expect(portal.querySelector('.tbl-axis-drag-ghost[data-axis="row"]')).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 180, bubbles: true }));
      });
      expect(portal.querySelector('.tbl-axis-drop-line[data-drop-boundary="2"]')).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: 150, clientY: 180, bubbles: true }));
      });
      const tableNode = editor.state.doc.firstChild!;
      expect(tableNode.child(0).textContent).toBe("A3A4");
      expect(tableNode.child(1).textContent).toBe("A1A2");
      expect(portal.querySelector(".tbl-axis-drag-ghost")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Alt 拖列头落位为克隆，全部后代 blockId 保持唯一", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    await renderControls(editor);
    const colHeader = portal.querySelectorAll(".tbl-col-hdr")[0]!;
    await act(async () => {
      colHeader.dispatchEvent(new MouseEvent("mousedown", { clientX: 150, clientY: 95, altKey: true, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 120, altKey: true, bubbles: true }));
    });
    expect(portal.querySelector('.tbl-axis-drag-ghost[data-clone="true"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300, clientY: 120, altKey: true, bubbles: true }));
    });
    expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(3);
    const ids: string[] = [];
    editor.state.doc.descendants((node) => {
      if (typeof node.attrs.blockId === "string") ids.push(node.attrs.blockId);
      return true;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("跨合并区 fail-closed：指示线禁止且松手 toast，不改表", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", merged: true });
    const before = editor.state.doc.firstChild?.toJSON();
    const onToast = vi.fn();
    await renderControls(editor, vi.fn(async () => true), onToast);
    const colHeader = portal.querySelectorAll(".tbl-col-hdr")[0]!;
    await act(async () => {
      colHeader.dispatchEvent(new MouseEvent("mousedown", { clientX: 150, clientY: 95, altKey: true, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 120, altKey: true, bubbles: true }));
    });
    expect(portal.querySelector('.tbl-axis-drop-line[data-drop-allowed="false"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300, clientY: 120, altKey: true, bubbles: true }));
    });
    expect(onToast).toHaveBeenCalledWith("合并单元格跨越移动边界，无法排序");
    expect(editor.state.doc.firstChild?.toJSON()).toEqual(before);
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

  it("单 cell 文本选区显示 A6 工具栏并复用链接浮层写入 mark", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    let textPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "A1") textPos = pos;
      return true;
    });
    editor.commands.setTextSelection({ from: textPos, to: textPos + 2 });
    await renderControls(editor);

    const toolbar = portal.querySelector<HTMLElement>(".tbl-sel-toolbar");
    expect(toolbar).not.toBeNull();
    for (const title of ["行内代码", "背景高亮", "左对齐", "居中", "右对齐", "链接"]) {
      expect(toolbar?.querySelector(`[title="${title}"]`)).not.toBeNull();
    }
    const linkButton = toolbar?.querySelector<HTMLButtonElement>('[title="链接"]');
    expect(linkButton?.disabled).toBe(false);
    await act(async () => linkButton?.click());
    const input = portal.querySelector<HTMLInputElement>(".link-hover-card .lhc-input");
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "https://example.com/table");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(JSON.stringify(editor.getJSON())).toContain('"href":"https://example.com/table"');
  });

  it("矩形 CellSelection 的链接按钮禁用，新格式按钮仍可用", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    expect(selectTableColumns(editor, "table-1", 0, 1)).toBe(true);
    await renderControls(editor);

    const toolbar = portal.querySelector<HTMLElement>(".tbl-sel-toolbar");
    expect(toolbar?.querySelector<HTMLButtonElement>('[title="链接"]')?.disabled).toBe(true);
    expect(toolbar?.querySelector<HTMLButtonElement>('[title="行内代码"]')?.disabled).toBe(false);
    expect(toolbar?.querySelector<HTMLButtonElement>('[title="背景高亮"]')?.disabled).toBe(false);
    await act(async () => toolbar?.querySelector<HTMLButtonElement>('[title="背景高亮"]')?.click());
    expect(portal.querySelector('.tbl-color-group.open [role="menu"]')).not.toBeNull();
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
      extensions: [...createQingagentExtensions(), TableAxisSelectionExtension],
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

    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(selectTableColumns(editor, "table-large", 0, 19)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}
