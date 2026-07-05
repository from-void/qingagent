// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, safeParsePmDoc, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBlockAtPos, resolveDropIntent } from "./ColumnDnD";
import { ColumnCM, ColumnListCM } from "./ColumnView";
import {
  buildListItemReorderTransaction,
  getListItemRowMetrics,
  getListItemRowRect,
  ListItemDnDExtension,
  resolveListItemAtPos,
  resolveListItemByBlockId,
  resolveListItemDropIntent,
  type ListItemRowMetrics,
  type RectLike as ListItemRectLike,
} from "./ListItemDnD";

const mountedEditors: Editor[] = [];

function createEditor(content: JSONContent): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      ...createQingagentExtensions({
        columnListExtension: ColumnListCM,
        columnExtension: ColumnCM,
      }),
      ListItemDnDExtension,
    ],
    content,
  });
  mountedEditors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of mountedEditors.splice(0)) {
    const element = editor.options.element;
    editor.destroy();
    if (element instanceof HTMLElement) element.remove();
  }
  document.body.classList.remove("pm-listitem-dnd-active-scope");
  document.body.innerHTML = "";
});

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

function paragraph(blockId: string, value: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: value ? [text(value)] : [],
  };
}

function listItem(blockId: string, value: string, children: JSONContent[] = []): JSONContent {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(`${blockId}-p`, value), ...children],
  };
}

function taskItem(blockId: string, value: string, checked: boolean, children: JSONContent[] = []): JSONContent {
  return {
    type: "taskItem",
    attrs: { blockId, checked },
    content: [paragraph(`${blockId}-p`, value), ...children],
  };
}

function bulletList(blockId: string, items: JSONContent[]): JSONContent {
  return { type: "bulletList", attrs: { blockId }, content: items };
}

function orderedList(blockId: string, start: number, items: JSONContent[]): JSONContent {
  return { type: "orderedList", attrs: { blockId, start }, content: items };
}

function taskList(blockId: string, items: JSONContent[]): JSONContent {
  return { type: "taskList", attrs: { blockId }, content: items };
}

function columnList(blockId: string, columns: Array<{ id: string; ratio: number; blocks: JSONContent[] }>): JSONContent {
  return {
    type: "columnList",
    attrs: { blockId },
    content: columns.map((column) => ({
      type: "column",
      attrs: { blockId: column.id, widthRatio: column.ratio },
      content: column.blocks,
    })),
  };
}

function doc(content: JSONContent[]): JSONContent {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function normalized(editor: Editor): PmDoc {
  return normalizePmDoc(editor.getJSON()) as PmDoc;
}

function findNodePosition(editor: Editor, type: string, blockId?: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === type && (blockId == null || node.attrs.blockId === blockId)) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function dispatchListItemReorder(
  editor: Editor,
  sourceId: string,
  targetId: string,
  placement: "before" | "after" = "before",
  targetDepth?: number,
) {
  const tr = buildListItemReorderTransaction(
    editor.state,
    findNodePosition(editor, "listItem", sourceId),
    findNodePosition(editor, "listItem", targetId),
    placement,
    targetDepth,
  );
  expect(tr).not.toBeNull();
  editor.view.dispatch(tr!);
}

function dispatchTaskItemReorder(
  editor: Editor,
  sourceId: string,
  targetId: string,
  placement: "before" | "after" = "before",
  targetDepth?: number,
) {
  const tr = buildListItemReorderTransaction(
    editor.state,
    findNodePosition(editor, "taskItem", sourceId),
    findNodePosition(editor, "taskItem", targetId),
    placement,
    targetDepth,
  );
  expect(tr).not.toBeNull();
  editor.view.dispatch(tr!);
}

function firstList(doc: PmDoc): Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }> {
  const block = doc.content[0];
  if (block?.type !== "bulletList" && block?.type !== "orderedList" && block?.type !== "taskList") {
    throw new Error(`expected list, got ${block?.type ?? "missing"}`);
  }
  return block;
}

function itemIds(list: Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>): string[] {
  return list.content.map((item) => item.attrs.blockId);
}

function itemText(item: { content?: Array<{ type: string; text?: string; content?: unknown[] }> }): string {
  return (item.content ?? [])
    .map((child) => {
      if (child.type === "text") return child.text ?? "";
      return itemText(child as never);
    })
    .join("");
}

function childList(
  item: { content?: unknown[] },
  type: "bulletList" | "orderedList" | "taskList",
): Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }> | null {
  return (((item.content ?? []) as PmBlockNode[]).find((child) => child.type === type) as Extract<
    PmBlockNode,
    { type: "bulletList" | "orderedList" | "taskList" }
  > | undefined) ?? null;
}

function assertParagraphFirstAndNoEmptyLists(value: JSONContent) {
  const visit = (node: JSONContent) => {
    if (node.type === "listItem" || node.type === "taskItem") {
      expect(node.content?.[0]?.type).toBe("paragraph");
    }
    if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
      expect(node.content?.length ?? 0).toBeGreaterThan(0);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(value);
}

function stripListBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripListBlockIds);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (
      key === "attrs" &&
      (record.type === "bulletList" || record.type === "orderedList" || record.type === "taskList") &&
      child &&
      typeof child === "object"
    ) {
      const attrs = { ...(child as Record<string, unknown>) };
      attrs.blockId = "<list>";
      next[key] = attrs;
    } else {
      next[key] = stripListBlockIds(child);
    }
  }
  return next;
}

function selectItem(editor: Editor, type: "listItem" | "taskItem", blockId: string) {
  const pos = findNodePosition(editor, type, blockId);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

function rect(left: number, top: number, width: number, height: number): ListItemRectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function rowMetrics(left: number, contentLeft: number, top: number, width = 320, height = 20): ListItemRowMetrics {
  const itemRect = rect(left, top, width, height);
  const contentRect = rect(contentLeft, top, Math.max(12, itemRect.right - contentLeft), height);
  return {
    rowRect: itemRect,
    itemRect,
    contentRect,
    contentElement: document.createElement("p"),
    itemLeft: left,
    markerLeft: left,
    contentLeft,
    contentRight: itemRect.right,
    handleLeft: left,
    parentListPaddingLeft: Math.max(0, contentLeft - left),
  };
}

function resolveIntentWithMetrics(
  editor: Editor,
  sourceId: string,
  targetId: string,
  coords: { left: number; top: number },
  metricsByBlockId: Record<string, ListItemRowMetrics>,
  lastZone?: { region: "R1" | "R2" | "R3"; targetDepth: number; targetItemPos: number },
) {
  const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", sourceId));
  const targetPos = findNodePosition(editor, "listItem", targetId);
  expect(source).not.toBeNull();
  return resolveListItemDropIntent({
    state: editor.state,
    source,
    coords,
    posAtCoords: () => ({ pos: targetPos + 1 }),
    getRect: (item) => metricsByBlockId[item.blockId ?? ""]?.rowRect ?? rect(100, 0, 320, 20),
    getRowMetrics: (item) => metricsByBlockId[item.blockId ?? ""] ?? null,
    lastZone,
  });
}

function startItemDrag(editor: Editor, type: "listItem" | "taskItem", blockId: string) {
  const pos = findNodePosition(editor, type, blockId);
  const selection = NodeSelection.create(editor.state.doc, pos);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
  (editor.view as unknown as { dragging: { slice: Slice; move: true; node: NodeSelection } }).dragging = {
    slice: selection.content(),
    move: true,
    node: selection,
  };
}

function callHandleDrop(editor: Editor, targetPos: number) {
  const original = editor.view.posAtCoords.bind(editor.view);
  (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = () => ({
    pos: targetPos,
    inside: -1,
  });
  const preventDefault = vi.fn();
  const event = {
    clientX: 10,
    clientY: 10,
    preventDefault,
  } as unknown as DragEvent;
  let handled = false;
  const emptySlice = new Slice(Fragment.empty, 0, 0);
  editor.view.someProp("handleDrop", (handler) => {
    const result = handler(editor.view, event, emptySlice, true);
    if (result) handled = true;
    return result;
  });
  (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = original;
  return { handled, preventDefault };
}

function mockListItemDomMetrics(
  editor: Editor,
  blockId: string,
  itemRect: ListItemRectLike,
  contentRect: ListItemRectLike,
) {
  const pos = findNodePosition(editor, "listItem", blockId);
  const dom = editor.view.nodeDOM(pos);
  expect(dom).toBeInstanceOf(HTMLElement);
  const itemDom = dom as HTMLElement;
  itemDom.getBoundingClientRect = vi.fn(() => itemRect as DOMRect);
  const contentEl = itemDom.querySelector("p") ?? itemDom;
  contentEl.getBoundingClientRect = vi.fn(() => contentRect as DOMRect);
}

function callDomEvent(editor: Editor, name: "dragover" | "dragleave", event: DragEvent): boolean {
  let handled = false;
  editor.view.someProp("handleDOMEvents", (handlers) => {
    const handler = handlers[name];
    if (!handler) return false;
    handled = Boolean(handler(editor.view, event));
    return handled;
  });
  return handled;
}

describe("列表行 DnD 事务", () => {
  it("bulletList 第 3 行拖到第 1 行前:顺序变、blockId 保留、单 undo 还原", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-1", "一"), listItem("li-2", "二"), listItem("li-3", "三")]),
        paragraph("tail", ""),
      ]),
    );
    const before = JSON.stringify(normalized(editor));

    dispatchListItemReorder(editor, "li-3", "li-1");

    const out = firstList(normalized(editor));
    expect(itemIds(out)).toEqual(["li-3", "li-1", "li-2"]);
    expect(out.content.map(itemText)).toEqual(["三", "一", "二"]);
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("orderedList 重排保留 start,行号由顺序自然重算", () => {
    const editor = createEditor(
      doc([
        orderedList("list", 7, [listItem("li-1", "一"), listItem("li-2", "二"), listItem("li-3", "三")]),
        paragraph("tail", ""),
      ]),
    );
    const before = JSON.stringify(normalized(editor));

    dispatchListItemReorder(editor, "li-3", "li-1");

    const out = firstList(normalized(editor));
    if (out.type !== "orderedList") throw new Error(`expected orderedList, got ${out.type}`);
    expect(out.attrs.start).toBe(7);
    expect(itemIds(out)).toEqual(["li-3", "li-1", "li-2"]);
    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("taskList 重排时 checked 跟随 taskItem 节点", () => {
    const editor = createEditor(
      doc([
        taskList("tasks", [
          taskItem("task-1", "一", false),
          taskItem("task-2", "二", false),
          taskItem("task-3", "三", true),
        ]),
        paragraph("tail", ""),
      ]),
    );
    const before = JSON.stringify(normalized(editor));

    dispatchTaskItemReorder(editor, "task-3", "task-1");

    const out = firstList(normalized(editor));
    if (out.type !== "taskList") throw new Error(`expected taskList, got ${out.type}`);
    expect(itemIds(out)).toEqual(["task-3", "task-1", "task-2"]);
    expect(out.content.map((item) => item.attrs.checked)).toEqual([true, false, false]);
    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("父 listItem 含子列表时,拖父行会带着子列表整体移动", () => {
    const nested = bulletList("nested", [listItem("li-3-child", "子项")]);
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-1", "父一"),
          listItem("li-2", "父二"),
          listItem("li-3", "父三", [nested]),
        ]),
      ]),
    );

    dispatchListItemReorder(editor, "li-3", "li-1");

    const out = firstList(normalized(editor));
    expect(itemIds(out)).toEqual(["li-3", "li-1", "li-2"]);
    const moved = out.content[0]!;
    expect(moved.content.some((child) => child.type === "bulletList" && child.attrs.blockId === "nested")).toBe(true);
    expect(JSON.stringify(moved)).toContain("li-3-child");
  });

  it("sink1:同 root 内右移一层成为前一行子项,保留 item blockId,新 wrapper list 有 blockId,单 undo", () => {
    const content = doc([
      bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
      paragraph("tail", ""),
    ]);
    const editor = createEditor(content);
    const oracle = createEditor(content);
    const before = JSON.stringify(normalized(editor));

    dispatchListItemReorder(editor, "li-b", "li-a", "after", 2);
    selectItem(oracle, "listItem", "li-b");
    expect(oracle.commands.sinkListItem("listItem")).toBe(true);

    const out = firstList(normalized(editor));
    expect(itemIds(out)).toEqual(["li-a", "li-c"]);
    const nested = childList(out.content[0]!, "bulletList");
    expect(nested).not.toBeNull();
    expect(nested!.attrs.blockId).toEqual(expect.any(String));
    expect(nested!.attrs.blockId).not.toBe("");
    expect(itemIds(nested!)).toEqual(["li-b"]);
    expect(resolveListItemByBlockId(editor.state, "li-b")).not.toBeNull();
    expect(stripListBlockIds(normalized(editor))).toEqual(stripListBlockIds(normalized(oracle)));
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("lift1:左移一层后跟父项平级,空父子列表删除,结构对照 liftListItem,单 undo", () => {
    const content = doc([
      bulletList("list", [
        listItem("li-a", "A", [bulletList("nested", [listItem("li-b", "B")])]),
        listItem("li-c", "C"),
      ]),
      paragraph("tail", ""),
    ]);
    const editor = createEditor(content);
    const oracle = createEditor(content);
    const before = JSON.stringify(normalized(editor));

    dispatchListItemReorder(editor, "li-b", "li-a", "after", 1);
    selectItem(oracle, "listItem", "li-b");
    expect(oracle.commands.liftListItem("listItem")).toBe(true);

    const out = firstList(normalized(editor));
    expect(itemIds(out)).toEqual(["li-a", "li-b", "li-c"]);
    expect(childList(out.content[0]!, "bulletList")).toBeNull();
    expect(stripListBlockIds(normalized(editor))).toEqual(stripListBlockIds(normalized(oracle)));
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("深度 clamp:水平坐标超出 dPrev+1 时只降一级", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-b"));
    const targetPos = findNodePosition(editor, "listItem", "li-a");
    expect(source).not.toBeNull();

    const intent = resolveListItemDropIntent({
      state: editor.state,
      source,
      coords: { left: 999, top: 30 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: (item) => (item.blockId === "li-a" ? rect(0, 0, 320, 20) : rect(0, 40, 320, 20)),
    });

    expect(intent).toMatchObject({ kind: "reorder", placement: "after", targetDepth: 2 });
  });

  it("首项没有前一行时不可 sink,直接事务也保持 noop", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B")]),
        paragraph("tail", ""),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-a"));
    const targetPos = findNodePosition(editor, "listItem", "li-b");
    expect(source).not.toBeNull();

    const intent = resolveListItemDropIntent({
      state: editor.state,
      source,
      coords: { left: 10, top: 0 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: () => rect(0, 0, 320, 20),
      getRowMetrics: () => rowMetrics(0, 24, 0),
    });
    expect(intent).toMatchObject({ kind: "noop", targetDepth: 1 });
    expect(
      buildListItemReorderTransaction(
        editor.state,
        findNodePosition(editor, "listItem", "li-a"),
        targetPos,
        "before",
        99,
      ),
    ).toBeNull();
  });

  it("taskItem 右移一层时结构合法,checked 和 blockId 跟随节点", () => {
    const editor = createEditor(
      doc([
        taskList("tasks", [
          taskItem("task-a", "A", false),
          taskItem("task-b", "B", true),
          taskItem("task-c", "C", false),
        ]),
        paragraph("tail", ""),
      ]),
    );

    dispatchTaskItemReorder(editor, "task-b", "task-a", "after", 2);

    const out = firstList(normalized(editor));
    if (out.type !== "taskList") throw new Error(`expected taskList, got ${out.type}`);
    expect(itemIds(out)).toEqual(["task-a", "task-c"]);
    const nested = childList(out.content[0]!, "taskList");
    expect(nested).not.toBeNull();
    expect(nested!.attrs.blockId).toEqual(expect.any(String));
    expect(nested!.content[0]!.attrs.blockId).toBe("task-b");
    expect((nested!.content[0]!.attrs as { checked?: boolean }).checked).toBe(true);
    assertParagraphFirstAndNoEmptyLists(editor.getJSON());
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  it("paragraph block* 严守:跨级后每个 item 首子都是 paragraph,且无空 list 残留", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-a", "A"),
          listItem("li-b", "B", [bulletList("nested-b", [listItem("li-b-child", "B child")])]),
          listItem("li-c", "C"),
        ]),
        paragraph("tail", ""),
      ]),
    );

    dispatchListItemReorder(editor, "li-c", "li-b", "after", 2);

    assertParagraphFirstAndNoEmptyLists(editor.getJSON());
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  it("文档末尾就是 list 时,跨级后一次 undo 完整回到 before,防 TrailingNode 污染历史", () => {
    const editor = createEditor(
      doc([bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")])]),
    );
    const before = JSON.stringify(normalized(editor));

    dispatchListItemReorder(editor, "li-b", "li-a", "after", 2);

    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("columnList 内列表行重排不触发 columnEdge,也不破坏分栏结构", () => {
    const editor = createEditor(
      doc([
        columnList("cols", [
          {
            id: "col-1",
            ratio: 0.5,
            blocks: [bulletList("list", [listItem("li-1", "一"), listItem("li-2", "二"), listItem("li-3", "三")])],
          },
          { id: "col-2", ratio: 0.5, blocks: [paragraph("p-right", "右栏")] },
        ]),
      ]),
    );
    const source = resolveBlockAtPos(editor.state, findNodePosition(editor, "listItem", "li-3"));
    const columnIntent = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 108, top: 20 },
      posAtCoords: () => ({ pos: findNodePosition(editor, "listItem", "li-1") + 1 }),
      getRect: () => rect(100, 10, 200, 40),
    });
    expect(columnIntent.kind).not.toBe("columnEdge");

    dispatchListItemReorder(editor, "li-3", "li-1");

    const out = normalized(editor).content[0] as Extract<PmBlockNode, { type: "columnList" }>;
    expect(out.type).toBe("columnList");
    expect(out.content).toHaveLength(2);
    const list = out.content[0]!.content[0] as Extract<PmBlockNode, { type: "bulletList" }>;
    expect(itemIds(list)).toEqual(["li-3", "li-1", "li-2"]);
    expect(itemText(out.content[1]!.content[0]! as never)).toBe("右栏");
    expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
  });
});

describe("列表行 DnD 几何", () => {
  it("父 listItem 含子列表时,row rect 只取首行高度,但横向保留整行宽度", () => {
    const item = document.createElement("li");
    const paragraphEl = document.createElement("p");
    const nestedList = document.createElement("ul");
    item.append(paragraphEl, nestedList);

    item.getBoundingClientRect = vi.fn(() => rect(10, 20, 300, 120) as DOMRect);
    paragraphEl.getBoundingClientRect = vi.fn(() => rect(34, 20, 120, 24) as DOMRect);
    nestedList.getBoundingClientRect = vi.fn(() => rect(34, 44, 240, 96) as DOMRect);

    const rowRect = getListItemRowRect(item, "listItem");

    expect(rowRect).toEqual(rect(10, 20, 300, 24));
    // 拖柄像素位置依赖浏览器真实 marker/checkbox 布局,由真机验收覆盖。
  });

  it("list-style outside 真机几何下,itemLeft 使用 marker 列而不是退化成正文左缘", () => {
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const paragraphEl = document.createElement("p");
    list.style.paddingLeft = "24px";
    item.append(paragraphEl);
    list.append(item);
    document.body.append(list);

    item.getBoundingClientRect = vi.fn(() => rect(100, 20, 300, 24) as DOMRect);
    paragraphEl.getBoundingClientRect = vi.fn(() => rect(100, 20, 300, 24) as DOMRect);

    const metrics = getListItemRowMetrics(item, "listItem");

    expect(metrics.contentLeft).toBe(100);
    expect(metrics.markerLeft).toBe(76);
    expect(metrics.itemLeft).toBe(76);
    expect(metrics.handleLeft).toBe(76);
  });

  it("父项含子列表时,before/after 阈值用首行高度,不被子列表高度污染", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-parent", "父项", [bulletList("nested", [listItem("li-child", "子项")])]),
          listItem("li-middle", "中间"),
          listItem("li-source", "来源"),
        ]),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-source"));
    const targetPos = findNodePosition(editor, "listItem", "li-parent");
    expect(source).not.toBeNull();

    const intent = resolveListItemDropIntent({
      state: editor.state,
      source,
      coords: { left: 220, top: 115 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: (item) => (item.blockId === "li-parent" ? rect(0, 100, 320, 20) : rect(0, 140, 320, 20)),
    });

    expect(intent).toMatchObject({ kind: "reorder", placement: "after" });
  });
});

describe("列表行 DnD 三响应区", () => {
  it("R1 marker 带按 Y 命中同级 before/after", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    const metricsByBlockId = {
      "li-a": rowMetrics(100, 124, 0),
      "li-b": rowMetrics(100, 124, 30),
      "li-c": rowMetrics(100, 124, 60),
    };

    expect(resolveIntentWithMetrics(editor, "li-c", "li-b", { left: 110, top: 34 }, metricsByBlockId)).toMatchObject({
      kind: "reorder",
      region: "R1",
      placement: "before",
      targetDepth: 1,
    });
    expect(resolveIntentWithMetrics(editor, "li-a", "li-b", { left: 110, top: 46 }, metricsByBlockId)).toMatchObject({
      kind: "reorder",
      region: "R1",
      placement: "after",
      targetDepth: 1,
    });
  });

  it("R2 正文区恒定嵌入目标行下级 children 头", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    const metricsByBlockId = {
      "li-a": rowMetrics(100, 124, 0),
      "li-b": rowMetrics(100, 124, 30),
      "li-c": rowMetrics(100, 124, 60),
    };

    const intent = resolveIntentWithMetrics(editor, "li-c", "li-b", { left: 130, top: 32 }, metricsByBlockId);
    expect(intent).toMatchObject({ kind: "reorder", region: "R2", placement: "after", targetDepth: 2 });
    if (intent.kind !== "reorder") throw new Error("expected reorder");
    const tr = buildListItemReorderTransaction(
      editor.state,
      intent.source.itemPos,
      intent.target.itemPos,
      intent.placement,
      intent.targetDepth,
    );
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const out = firstList(normalized(editor));
    const nested = childList(out.content[1]!, "bulletList");
    expect(nested).not.toBeNull();
    expect(itemIds(nested!)).toEqual(["li-c"]);
  });

  it("R3 祖先列命中上级 depth,并用 clamp 处理越界 X", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-a", "A", [bulletList("nested", [listItem("li-child", "child")])]),
          listItem("li-source", "source"),
        ]),
        paragraph("tail", ""),
      ]),
    );
    const metricsByBlockId = {
      "li-a": rowMetrics(100, 124, 0),
      "li-child": rowMetrics(124, 148, 30),
      "li-source": rowMetrics(100, 124, 60),
    };

    expect(resolveIntentWithMetrics(editor, "li-source", "li-child", { left: 90, top: 34 }, metricsByBlockId)).toMatchObject({
      kind: "reorder",
      region: "R3",
      placement: "after",
      targetDepth: 1,
    });
    expect(resolveIntentWithMetrics(editor, "li-source", "li-child", { left: -999, top: 34 }, metricsByBlockId)).toMatchObject({
      kind: "reorder",
      region: "R3",
      targetDepth: 1,
    });
  });

  it("hysteresis 在边界内维持 lastZone,向左偏置让升级更灵敏", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    const targetItemPos = findNodePosition(editor, "listItem", "li-b");
    const metricsByBlockId = {
      "li-a": rowMetrics(100, 124, 0),
      "li-b": rowMetrics(100, 124, 30),
      "li-c": rowMetrics(100, 124, 60),
    };

    expect(
      resolveIntentWithMetrics(editor, "li-c", "li-b", { left: 132, top: 34 }, metricsByBlockId, {
        region: "R1",
        targetDepth: 1,
        targetItemPos,
      }),
    ).toMatchObject({ kind: "reorder", region: "R1", targetDepth: 1 });

    expect(
      resolveIntentWithMetrics(editor, "li-c", "li-b", { left: 123, top: 34 }, metricsByBlockId, {
        region: "R2",
        targetDepth: 2,
        targetItemPos,
      }),
    ).toMatchObject({ kind: "reorder", region: "R2", targetDepth: 2 });

    expect(
      resolveIntentWithMetrics(editor, "li-c", "li-b", { left: 121, top: 34 }, metricsByBlockId, {
        region: "R2",
        targetDepth: 2,
        targetItemPos,
      }),
    ).toMatchObject({ kind: "reorder", region: "R1", targetDepth: 1 });
  });
});

describe("列表行 DnD DOM 状态", () => {
  it("listItem dragover 加 active class 隐藏 dropcursor,并渲染单根 widget 落点线", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    startItemDrag(editor, "listItem", "li-c");
    const targetPos = findNodePosition(editor, "listItem", "li-b");
    const originalPosAtCoords = editor.view.posAtCoords.bind(editor.view);
    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = () => ({
      pos: targetPos + 1,
      inside: -1,
    });
    (editor.view.dom as HTMLElement).getBoundingClientRect = vi.fn(() => rect(0, 0, 500, 400) as DOMRect);
    mockListItemDomMetrics(editor, "li-a", rect(100, 0, 320, 20), rect(124, 0, 296, 20));
    mockListItemDomMetrics(editor, "li-b", rect(100, 30, 320, 20), rect(124, 30, 296, 20));
    mockListItemDomMetrics(editor, "li-c", rect(100, 60, 320, 20), rect(124, 60, 296, 20));
    const dropcursor = document.createElement("div");
    dropcursor.className = "prosemirror-dropcursor-block";
    document.body.append(dropcursor);

    const preventDefault = vi.fn();
    const handled = callDomEvent(editor, "dragover", {
      clientX: 130,
      clientY: 34,
      preventDefault,
    } as unknown as DragEvent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(true);
    expect(document.body.classList.contains("pm-listitem-dnd-active-scope")).toBe(true);
    expect(document.body.querySelector(".prosemirror-dropcursor-block")).toBe(dropcursor);
    const lines = editor.view.dom.querySelectorAll(".pm-listitem-drop-line");
    expect(lines).toHaveLength(1);
    const line = lines[0] as HTMLElement;
    expect(line.dataset.qingagentListDropTarget).toBe("after");
    expect(line.style.left).toBe("124px");
    expect(line.style.width).toBe("296px");

    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = originalPosAtCoords;
  });

  it("同一拖拽横向移动时自绘落点线在 R2/R1/R3 间实时切换,并压住原生 dropcursor", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-a", "A", [bulletList("nested-a", [listItem("li-a1", "A1"), listItem("li-a2", "A2")])]),
          listItem("li-b", "B", [bulletList("nested-b", [listItem("li-b1", "B1"), listItem("li-b2", "B2")])]),
        ]),
        paragraph("tail", ""),
      ]),
    );
    startItemDrag(editor, "listItem", "li-a2");
    const targetPos = findNodePosition(editor, "listItem", "li-b1");
    const originalPosAtCoords = editor.view.posAtCoords.bind(editor.view);
    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = () => ({
      pos: targetPos + 1,
      inside: -1,
    });
    (editor.view.dom as HTMLElement).getBoundingClientRect = vi.fn(() => rect(0, 0, 1200, 800) as DOMRect);
    mockListItemDomMetrics(editor, "li-a", rect(524, 0, 648, 24), rect(548, 0, 624, 24));
    mockListItemDomMetrics(editor, "li-a1", rect(548, 30, 624, 24), rect(560, 30, 612, 24));
    mockListItemDomMetrics(editor, "li-a2", rect(548, 60, 624, 24), rect(560, 60, 612, 24));
    mockListItemDomMetrics(editor, "li-b", rect(524, 100, 648, 24), rect(548, 100, 624, 24));
    mockListItemDomMetrics(editor, "li-b1", rect(548, 130, 624, 24), rect(560, 130, 612, 24));
    mockListItemDomMetrics(editor, "li-b2", rect(548, 160, 624, 24), rect(560, 160, 612, 24));

    const nativeDropcursor = document.createElement("div");
    nativeDropcursor.className = "prosemirror-dropcursor-block";
    document.body.append(nativeDropcursor);

    const dragoverAt = (x: number) => {
      const handled = callDomEvent(editor, "dragover", {
        clientX: x,
        clientY: 136,
        preventDefault: vi.fn(),
      } as unknown as DragEvent);
      expect(handled).toBe(true);
      const line = editor.view.dom.querySelector<HTMLElement>(".pm-listitem-drop-line");
      expect(line).not.toBeNull();
      return {
        left: line!.style.left,
        className: line!.className,
      };
    };

    expect(dragoverAt(570)).toMatchObject({ left: "572px", className: expect.stringContaining("--r2") });
    expect(dragoverAt(548)).toMatchObject({ left: "548px", className: expect.stringContaining("--r1") });
    expect(dragoverAt(520)).toMatchObject({ left: "524px", className: expect.stringContaining("--r3") });
    expect(dragoverAt(570)).toMatchObject({ left: "572px", className: expect.stringContaining("--r2") });
    expect(document.body.classList.contains("pm-listitem-dnd-active-scope")).toBe(true);
    expect(document.body.querySelector(".prosemirror-dropcursor-block")).toBe(nativeDropcursor);

    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = originalPosAtCoords;
  });

  it("dragleave 进入 editor 内部节点不清线,离开整个 editor 才清 lastZone/class", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    startItemDrag(editor, "listItem", "li-c");
    const targetPos = findNodePosition(editor, "listItem", "li-b");
    const originalPosAtCoords = editor.view.posAtCoords.bind(editor.view);
    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = () => ({
      pos: targetPos + 1,
      inside: -1,
    });
    (editor.view.dom as HTMLElement).getBoundingClientRect = vi.fn(() => rect(0, 0, 500, 400) as DOMRect);
    mockListItemDomMetrics(editor, "li-a", rect(100, 0, 320, 20), rect(124, 0, 296, 20));
    mockListItemDomMetrics(editor, "li-b", rect(100, 30, 320, 20), rect(124, 30, 296, 20));
    mockListItemDomMetrics(editor, "li-c", rect(100, 60, 320, 20), rect(124, 60, 296, 20));
    callDomEvent(editor, "dragover", {
      clientX: 130,
      clientY: 34,
      preventDefault: vi.fn(),
    } as unknown as DragEvent);
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(true);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(1);

    const inner = document.createElement("span");
    editor.view.dom.append(inner);
    callDomEvent(editor, "dragleave", { relatedTarget: inner } as unknown as DragEvent);
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(true);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(1);

    callDomEvent(editor, "dragleave", { relatedTarget: document.body } as unknown as DragEvent);
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(false);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(0);

    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = originalPosAtCoords;
  });

  it("dragleave 时 relatedTarget 为 null(真机子边界抖动)但指针仍在编辑器内→不清线,落到编辑器外才清", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B"), listItem("li-c", "C")]),
        paragraph("tail", ""),
      ]),
    );
    startItemDrag(editor, "listItem", "li-c");
    const targetPos = findNodePosition(editor, "listItem", "li-b");
    const originalPosAtCoords = editor.view.posAtCoords.bind(editor.view);
    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = () => ({
      pos: targetPos + 1,
      inside: -1,
    });
    (editor.view.dom as HTMLElement).getBoundingClientRect = vi.fn(() => rect(0, 0, 500, 400) as DOMRect);
    mockListItemDomMetrics(editor, "li-a", rect(100, 0, 320, 20), rect(124, 0, 296, 20));
    mockListItemDomMetrics(editor, "li-b", rect(100, 30, 320, 20), rect(124, 30, 296, 20));
    mockListItemDomMetrics(editor, "li-c", rect(100, 60, 320, 20), rect(124, 60, 296, 20));
    callDomEvent(editor, "dragover", { clientX: 130, clientY: 34, preventDefault: vi.fn() } as unknown as DragEvent);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(1);

    // relatedTarget 为 null + 指针仍在编辑器矩形内(往左移做 R3,跨了子元素边界):不应清线
    callDomEvent(editor, "dragleave", {
      relatedTarget: null,
      clientX: 60,
      clientY: 34,
    } as unknown as DragEvent);
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(true);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(1);

    // relatedTarget 为 null + 指针落到编辑器矩形外:才清线
    callDomEvent(editor, "dragleave", {
      relatedTarget: null,
      clientX: -50,
      clientY: 34,
    } as unknown as DragEvent);
    expect(editor.view.dom.classList.contains("pm-listitem-dnd-active")).toBe(false);
    expect(editor.view.dom.querySelectorAll(".pm-listitem-drop-line")).toHaveLength(0);

    (editor.view as unknown as { posAtCoords: typeof editor.view.posAtCoords }).posAtCoords = originalPosAtCoords;
  });
});

describe("列表行 DnD 无效 drop", () => {
  it("拖到不同 list type 时吞掉 drop,不回落到 ProseMirror 原生插入", () => {
    const editor = createEditor(
      doc([
        bulletList("bullets", [listItem("li-1", "一")]),
        orderedList("orders", 1, [listItem("oli-1", "甲")]),
        paragraph("tail", ""),
      ]),
    );
    const before = JSON.stringify(normalized(editor));
    startItemDrag(editor, "listItem", "li-1");

    const drop = callHandleDrop(editor, findNodePosition(editor, "listItem", "oli-1") + 1);

    expect(drop.handled).toBe(true);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("拖到自身 descendant 时吞掉 drop,doc 保持不变", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-parent", "父项", [bulletList("nested", [listItem("li-child", "子项")])]),
          listItem("li-sibling", "兄弟"),
        ]),
        paragraph("tail", ""),
      ]),
    );
    const before = JSON.stringify(normalized(editor));
    startItemDrag(editor, "listItem", "li-parent");

    const drop = callHandleDrop(editor, findNodePosition(editor, "listItem", "li-child") + 1);

    expect(drop.handled).toBe(true);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("拖父项进子孙仍判 invalid,防自陷", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [
          listItem("li-parent", "父项", [bulletList("nested", [listItem("li-child", "子项")])]),
          listItem("li-sibling", "兄弟"),
        ]),
        paragraph("tail", ""),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-parent"));
    const targetPos = findNodePosition(editor, "listItem", "li-child");
    expect(source).not.toBeNull();

    const intent = resolveListItemDropIntent({
      state: editor.state,
      source,
      coords: { left: 48, top: 30 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: () => rect(24, 20, 320, 20),
    });

    expect(intent).toMatchObject({ kind: "invalid" });
    expect(
      buildListItemReorderTransaction(
        editor.state,
        findNodePosition(editor, "listItem", "li-parent"),
        targetPos,
        "after",
        2,
      ),
    ).toBeNull();
  });

  it("同 listType 但跨 column root 时判 invalid", () => {
    const editor = createEditor(
      doc([
        columnList("cols", [
          {
            id: "col-1",
            ratio: 0.5,
            blocks: [bulletList("left-list", [listItem("li-left", "左")])],
          },
          {
            id: "col-2",
            ratio: 0.5,
            blocks: [bulletList("right-list", [listItem("li-right", "右")])],
          },
        ]),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-left"));
    const targetPos = findNodePosition(editor, "listItem", "li-right");
    expect(source).not.toBeNull();

    const intent = resolveListItemDropIntent({
      state: editor.state,
      source,
      coords: { left: 100, top: 10 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: () => rect(80, 0, 320, 20),
    });

    expect(intent).toMatchObject({ kind: "invalid" });
    expect(
      buildListItemReorderTransaction(
        editor.state,
        findNodePosition(editor, "listItem", "li-left"),
        targetPos,
        "before",
        1,
      ),
    ).toBeNull();
  });

  it("脏坐标 NaN/负 Y 回退 native,有限负 X 走 clamp 不丢线", () => {
    const editor = createEditor(
      doc([
        bulletList("list", [listItem("li-a", "A"), listItem("li-b", "B")]),
        paragraph("tail", ""),
      ]),
    );
    const source = resolveListItemAtPos(editor.state.doc, findNodePosition(editor, "listItem", "li-a"));
    expect(source).not.toBeNull();
    const posAtCoords = vi.fn(() => ({ pos: findNodePosition(editor, "listItem", "li-b") + 1 }));

    expect(
      resolveListItemDropIntent({
        state: editor.state,
        source,
        coords: { left: Number.NaN, top: 10 },
        posAtCoords,
        getRect: () => rect(0, 0, 320, 20),
      }),
    ).toEqual({ kind: "native" });
    expect(posAtCoords).not.toHaveBeenCalled();

    expect(
      resolveListItemDropIntent({
        state: editor.state,
        source,
        coords: { left: 10, top: -1 },
        posAtCoords,
        getRect: () => rect(0, 0, 320, 20),
      }),
    ).toEqual({ kind: "native" });
    expect(posAtCoords).not.toHaveBeenCalled();

    expect(
      resolveListItemDropIntent({
        state: editor.state,
        source,
        coords: { left: -999, top: 10 },
        posAtCoords,
        getRect: () => rect(0, 0, 320, 20),
      }),
    ).not.toMatchObject({ kind: "native" });
    expect(posAtCoords).toHaveBeenCalledTimes(1);
  });
});
