// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmColumnListNode, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnCM, ColumnListCM } from "../../components/ColumnView";
import { resolveDropIntent, resolveBlockAtPos, type RectLike } from "../../components/ColumnDnD";
import { BlockHandle } from "../../components/doc/BlockHandle";
import { createBlockDragPayload } from "../../components/doc/structureNodes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("分栏内块手柄与拖放", () => {
  it("栏内块起始边界命中自己的手柄，且块菜单能力可用", async () => {
    const fixture = createFixture([
      columns("cols", [
        column("left", [paragraph("left-a", "左栏甲"), paragraph("left-b", "左栏乙")]),
        column("right", [paragraph("right-a", "右栏")]),
      ]),
    ]);
    editor = fixture.editor;
    root = createRoot(fixture.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));

    const blockPos = findBlockPos(editor, "left-a");
    const blockDom = setNodeRect(editor, blockPos, rect(120, 100, 240, 28));
    setNodeRect(editor, findBlockPos(editor, "cols"), rect(100, 90, 620, 100));
    setEditorRect(editor, rect(0, 0, 1000, 800));
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: blockPos, inside: -1 });

    await act(async () => {
      blockDom.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 160,
        clientY: 112,
        bubbles: true,
      }));
    });

    const handle = fixture.workspace.querySelector<HTMLElement>(
      '.block-handle-wrap[data-node-type="paragraph"]',
    );
    expect(handle).not.toBeNull();
    expect(handle?.style.left).toBe("120px");

    await act(async () => handle?.querySelector<HTMLButtonElement>(".block-handle-btn")?.click());
    const menu = fixture.workspace.querySelector<HTMLElement>(".block-handle-menu");
    expect(menu?.textContent).toContain("转换为");
    expect(menu?.textContent).toContain("删除");
  });

  it("栏内块可纵向拖到另一栏，落点按目标块上半区插入", () => {
    const fixture = createFixture([
      columns("cols", [
        column("left", [paragraph("left-a", "待移动"), paragraph("left-b", "左栏保留")]),
        column("right", [paragraph("right-a", "右栏目标")]),
      ]),
    ]);
    editor = fixture.editor;
    const sourcePos = findBlockPos(editor, "left-a");
    const targetPos = findBlockPos(editor, "right-a");
    setNodeRect(editor, targetPos, rect(440, 100, 240, 40));
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: targetPos, inside: -1 });
    startBlockDrag(editor, sourcePos);

    const source = resolveBlockAtPos(editor.state, sourcePos);
    const intent = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 560, top: 105 },
      posAtCoords: (coords) => editor!.view.posAtCoords(coords),
      getRect: (block) => nodeRect(editor!, block.pos),
    });
    expect(intent).toMatchObject({
      kind: "vertical",
      placement: "before",
      target: { pos: targetPos, parentType: "column" },
    });

    const drop = callHandleDrop(editor, { clientX: 560, clientY: 105 });
    expect(drop.handled).toBe(true);
    expect(drop.preventDefault).toHaveBeenCalled();

    const list = normalized(editor).content[0] as PmColumnListNode;
    expect(list.type).toBe("columnList");
    expect(list.content.map((item) => item.content.map((block) => block.attrs.blockId))).toEqual([
      ["left-b"],
      ["left-a", "right-a"],
    ]);
  });

  it("栏内唯一块可拖到分栏外，源空栏沿用既有单栏解散语义", () => {
    const fixture = createFixture([
      columns("cols", [
        column("left", [paragraph("left-a", "拖出内容")]),
        column("right", [paragraph("right-a", "剩余内容")]),
      ]),
      paragraph("tail", "分栏后正文"),
    ]);
    editor = fixture.editor;
    const sourcePos = findBlockPos(editor, "left-a");
    const targetPos = findBlockPos(editor, "tail");
    setNodeRect(editor, targetPos, rect(100, 240, 620, 40));
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: targetPos, inside: -1 });
    startBlockDrag(editor, sourcePos);

    const source = resolveBlockAtPos(editor.state, sourcePos);
    const intent = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 410, top: 275 },
      posAtCoords: (coords) => editor!.view.posAtCoords(coords),
      getRect: (block) => nodeRect(editor!, block.pos),
    });
    expect(intent).toMatchObject({
      kind: "vertical",
      placement: "after",
      target: { pos: targetPos, parentType: "doc" },
    });

    const drop = callHandleDrop(editor, { clientX: 410, clientY: 275 });
    expect(drop.handled).toBe(true);
    const output = normalized(editor);
    expect(output.content.map((block) => block.attrs.blockId)).toEqual([
      "right-a",
      "tail",
      "left-a",
    ]);
    expect(output.content.some((block) => block.type === "columnList")).toBe(false);
  });

  it("指针位于分栏行间隙时仍命中整行 columnList 手柄", async () => {
    const fixture = createFixture([
      columns("cols", [
        column("left", [paragraph("left-a", "左栏")]),
        column("right", [paragraph("right-a", "右栏")]),
      ]),
    ]);
    editor = fixture.editor;
    root = createRoot(fixture.reactHost);
    await act(async () => root?.render(<BlockHandle editor={editor!} />));

    const leftPos = findBlockPos(editor, "left-a");
    setNodeRect(editor, findBlockPos(editor, "cols"), rect(100, 90, 620, 100));
    setNodeRect(editor, leftPos, rect(110, 100, 260, 28));
    setNodeRect(editor, findBlockPos(editor, "right-a"), rect(450, 100, 260, 28));
    setEditorRect(editor, rect(0, 0, 1000, 800));
    // 浏览器在列间隙可能仍把坐标吸附到左栏块边界，手柄逻辑必须用 x 几何纠偏。
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: leftPos, inside: -1 });

    await act(async () => {
      editor!.view.dom.dispatchEvent(new MouseEvent("mousemove", {
        clientX: 410,
        clientY: 112,
        bubbles: true,
      }));
    });

    expect(
      fixture.workspace.querySelector('.block-handle-wrap[data-node-type="columnList"]'),
    ).not.toBeNull();
  });
});

function createFixture(content: JSONContent[]) {
  const workspace = document.createElement("div");
  workspace.id = "view-workspace";
  const editorElement = document.createElement("div");
  const reactHost = document.createElement("div");
  workspace.append(editorElement, reactHost);
  document.body.appendChild(workspace);
  const nextEditor = new Editor({
    element: editorElement,
    extensions: createQingagentExtensions({
      columnListExtension: ColumnListCM,
      columnExtension: ColumnCM,
    }),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content,
    },
  });
  return { workspace, reactHost, editor: nextEditor };
}

function paragraph(blockId: string, value: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text: value }],
  };
}

function column(blockId: string, blocks: JSONContent[]): JSONContent {
  return {
    type: "column",
    attrs: { blockId, widthRatio: 0.5 },
    content: blocks,
  };
}

function columns(blockId: string, content: JSONContent[]): JSONContent {
  return {
    type: "columnList",
    attrs: { blockId },
    content,
  };
}

function normalized(value: Editor): PmDoc {
  return normalizePmDoc(value.getJSON()) as PmDoc;
}

function findBlockPos(value: Editor, blockId: string): number {
  let found: number | null = null;
  value.state.doc.descendants((node, pos) => {
    if (node.attrs.blockId !== blockId) return true;
    found = pos;
    return false;
  });
  expect(found).not.toBeNull();
  return found!;
}

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function setNodeRect(value: Editor, pos: number, valueRect: RectLike): HTMLElement {
  const dom = value.view.nodeDOM(pos);
  expect(dom).toBeInstanceOf(HTMLElement);
  (dom as HTMLElement).getBoundingClientRect = vi.fn(() => valueRect as DOMRect);
  return dom as HTMLElement;
}

function setEditorRect(value: Editor, valueRect: RectLike) {
  value.view.dom.getBoundingClientRect = vi.fn(() => valueRect as DOMRect);
}

function nodeRect(value: Editor, pos: number): RectLike | null {
  const dom = value.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

function startBlockDrag(value: Editor, sourcePos: number) {
  const payload = createBlockDragPayload(value.view, sourcePos);
  value.view.dispatch(value.state.tr.setSelection(payload.selection));
  (value.view as unknown as { dragging: typeof payload.dragging }).dragging = payload.dragging;
}

function callHandleDrop(value: Editor, coords: { clientX: number; clientY: number }) {
  const preventDefault = vi.fn();
  const event = {
    ...coords,
    preventDefault,
  } as unknown as DragEvent;
  const emptySlice = new Slice(Fragment.empty, 0, 0);
  let handled = false;
  value.view.someProp("handleDrop", (handler) => {
    const result = handler(value.view, event, emptySlice, true);
    if (result) handled = true;
    return result;
  });
  return { handled, preventDefault };
}
