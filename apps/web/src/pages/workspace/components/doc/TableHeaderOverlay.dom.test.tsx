import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import type { PmDoc } from "@qingagent/pm-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableHeaderOverlay } from "./TableHeaderOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let editor: Editor | null = null;
let rafQueue = new Map<number, FrameRequestCallback>();
let rafSequence = 0;
let observers: ResizeObserverStub[] = [];
let previousResizeObserver: typeof ResizeObserver | undefined;

class ResizeObserverStub {
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  flush() { this.callback([], this as unknown as ResizeObserver); }
}

beforeEach(() => {
  rafQueue = new Map();
  rafSequence = 0;
  observers = [];
  previousResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: ResizeObserverStub });
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
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  if (previousResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: previousResizeObserver });
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

describe("TableHeaderOverlay", () => {
  it("标题行滚出而表体仍可见时出现，点击映射回真 cell", async () => {
    const setup = setupEditor(true);
    const scrollIntoView = vi.fn();
    Object.defineProperty(setup.trueCells[0]!, "scrollIntoView", { configurable: true, value: scrollIntoView });
    await renderOverlay(setup.overlayHost);

    const overlay = setup.portal.querySelector<HTMLElement>(".table-header-overlay-viewport");
    expect(overlay).not.toBeNull();
    expect(overlay?.style.top).toBe("0px");
    expect(overlay?.style.width).toBe("240px");
    expect(setup.portal.querySelectorAll(".table-header-overlay__table th")).toHaveLength(2);

    await act(async () => {
      setup.portal.querySelector<HTMLTableCellElement>(".table-header-overlay__table th")?.click();
    });
    expect(editor?.isActive("table")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(setup.portal.querySelector(".table-header-overlay-viewport")).not.toBeNull();
  });

  it("横滚与列宽变化按 rAF 同步真表 left、总宽和各 cell 宽", async () => {
    const setup = setupEditor(true);
    await renderOverlay(setup.overlayHost);
    setup.tableRect.mockReturnValue(rect(60, -40, 260, 200));
    setup.cellRects[0]!.mockReturnValue(rect(60, -40, 150, 30));
    setup.cellRects[1]!.mockReturnValue(rect(210, -40, 110, 30));

    setup.wrapper.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());

    const overlayTable = setup.portal.querySelector<HTMLTableElement>(".table-header-overlay__table")!;
    expect(overlayTable.style.left).toBe("-40px");
    expect(overlayTable.style.width).toBe("260px");
    const overlayCells = overlayTable.querySelectorAll<HTMLTableCellElement>("th");
    expect(overlayCells[0]?.style.width).toBe("150px");
    expect(overlayCells[1]?.style.width).toBe("110px");
  });

  it("横滚状态按 rAF 写入 wrapper 属性，归零与卸载时清理", async () => {
    const setup = setupEditor(true);
    await renderOverlay(setup.overlayHost);
    expect(setup.wrapper.hasAttribute("data-scrolled-x")).toBe(false);

    Object.defineProperty(setup.wrapper, "scrollLeft", { configurable: true, writable: true, value: 24 });
    setup.wrapper.dispatchEvent(new Event("scroll"));
    expect(setup.wrapper.hasAttribute("data-scrolled-x")).toBe(false);
    await act(async () => flushAnimationFrames());
    expect(setup.wrapper.hasAttribute("data-scrolled-x")).toBe(true);

    setup.wrapper.scrollLeft = 0;
    setup.wrapper.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());
    expect(setup.wrapper.hasAttribute("data-scrolled-x")).toBe(false);

    setup.wrapper.scrollLeft = 12;
    setup.wrapper.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());
    act(() => root?.unmount());
    root = null;
    expect(setup.wrapper.hasAttribute("data-scrolled-x")).toBe(false);
  });

  it("表尾仍有表体可见时保持固定，表滚完或回滚到表头可见时消失", async () => {
    const setup = setupEditor(true);
    await renderOverlay(setup.overlayHost);
    expect(setup.portal.querySelector(".table-header-overlay-viewport")).not.toBeNull();

    setup.tableRect.mockReturnValue(rect(100, -180, 240, 200));
    setup.ws.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());
    expect(setup.portal.querySelector(".table-header-overlay-viewport")).not.toBeNull();

    setup.tableRect.mockReturnValue(rect(100, -200, 240, 200));
    setup.ws.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());
    expect(setup.portal.querySelector(".table-header-overlay-viewport")).toBeNull();

    setup.tableRect.mockReturnValue(rect(100, 10, 240, 200));
    setup.headerRect.mockReturnValue(rect(100, 10, 240, 30));
    setup.ws.dispatchEvent(new Event("scroll"));
    await act(async () => flushAnimationFrames());
    expect(setup.portal.querySelector(".table-header-overlay-viewport")).toBeNull();
  });

  it("复用正文语义样式但隔离整页纸面盒模型，并保留单元格底色与文字标记", async () => {
    const setup = setupEditor(true, false, true);
    await renderOverlay(setup.overlayHost);

    const overlay = setup.portal.querySelector<HTMLElement>(".table-header-overlay-viewport");
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains("wf-doc")).toBe(false);
    const content = overlay?.querySelector<HTMLElement>(".table-header-overlay-content");
    expect(content).not.toBeNull();
    expect(overlay?.style.width).toBe("240px");
    expect(overlay?.querySelector("th")?.getAttribute("data-bg-color")).toBe("rose");
    expect(overlay?.querySelector("mark")?.getAttribute("data-color")).toBe("yellow");
    expect(overlay?.querySelector("span")?.getAttribute("data-text-color")).toBe("red");
  });

  it("无完整标题行或只读态均不渲染，光标在表内仍然固定", async () => {
    const noHeader = setupEditor(false);
    await renderOverlay(noHeader.overlayHost);
    expect(noHeader.portal.querySelector(".table-header-overlay-viewport")).toBeNull();
    act(() => root?.unmount());
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";

    const inTable = setupEditor(true, true);
    await renderOverlay(inTable.overlayHost);
    expect(inTable.portal.querySelector(".table-header-overlay-viewport")).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    inTable.editor.setEditable(false);
    await renderOverlay(inTable.overlayHost);
    expect(inTable.portal.querySelector(".table-header-overlay-viewport")).toBeNull();
  });

  it("卸载时取消待执行 rAF、清理监听并 disconnect observer", async () => {
    const setup = setupEditor(true);
    const removeScroll = vi.spyOn(setup.ws, "removeEventListener");
    await renderOverlay(setup.overlayHost);
    setup.ws.dispatchEvent(new Event("scroll"));
    expect(rafQueue.size).toBe(1);

    act(() => root?.unmount());
    root = null;
    expect(rafQueue.size).toBe(0);
    expect(removeScroll).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnected).toBe(true);
  });
});

function setupEditor(withHeaderRow: boolean, selectionInTable = false, decoratedHeader = false) {
  const portal = document.createElement("div");
  portal.id = "view-workspace";
  const ws = document.createElement("div");
  ws.className = "ws-right";
  const editorHost = document.createElement("div");
  const overlayHost = document.createElement("div");
  ws.appendChild(editorHost);
  portal.append(ws, overlayHost);
  document.body.appendChild(portal);
  const instance = new Editor({
    element: editorHost,
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "table",
          attrs: { blockId: "sticky-table" },
          content: [
            { type: "tableRow", content: [cell("h1", "甲", withHeaderRow, decoratedHeader), cell("h2", "乙", withHeaderRow)] },
            { type: "tableRow", content: [cell("d1", "一", false), cell("d2", "二", false)] },
          ],
        },
        { type: "paragraph", attrs: { blockId: "tail" }, content: [{ type: "text", text: "尾段" }] },
      ],
    } satisfies PmDoc,
  });
  editor = instance;
  editor.view.dom.classList.add("wf-doc");
  if (!selectionInTable) {
    let tailPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.blockId === "tail") tailPos = pos;
      return true;
    });
    editor.commands.setTextSelection(tailPos + 1);
  }
  const table = editor.view.dom.querySelector<HTMLTableElement>("table")!;
  const wrapper = table.closest<HTMLElement>(".tableWrapper") ?? table;
  const headerRow = table.rows[0]!;
  const trueCells = Array.from(headerRow.cells);
  vi.spyOn(ws, "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(rect(100, -40, 240, 200));
  const tableRect = vi.spyOn(table, "getBoundingClientRect").mockReturnValue(rect(100, -40, 240, 200));
  const headerRect = vi.spyOn(headerRow, "getBoundingClientRect").mockReturnValue(rect(100, -40, 240, 30));
  const cellRects = trueCells.map((tableCell, index) =>
    vi.spyOn(tableCell, "getBoundingClientRect").mockReturnValue(rect(100 + index * 120, -40, 120, 30)));
  return { editor: instance, portal, ws, overlayHost, table, wrapper, trueCells, tableRect, headerRect, cellRects };
}

async function renderOverlay(host: HTMLElement) {
  root = createRoot(host);
  await act(async () => root?.render(<TableHeaderOverlay editor={editor!} />));
}

function flushAnimationFrames() {
  const queued = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [id, callback] of queued) callback(id);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: left, y: top, width, height });
}

function cell(blockId: string, text: string, header: boolean, decorated = false) {
  return {
    type: header ? "tableHeader" as const : "tableCell" as const,
    ...(decorated ? { attrs: { backgroundColor: "rose" as const } } : {}),
    content: [{
      type: "paragraph" as const,
      attrs: { blockId },
      content: [{
        type: "text" as const,
        text,
        ...(decorated ? {
          marks: [
            { type: "textColor" as const, attrs: { color: "red" as const } },
            { type: "highlight" as const, attrs: { color: "yellow" as const } },
          ],
        } : {}),
      }],
    }],
  };
}
