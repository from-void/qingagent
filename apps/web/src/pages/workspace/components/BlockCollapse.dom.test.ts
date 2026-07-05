// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlockCollapseExtension,
  createExpandBlockCollapseMeta,
  expandBlockCollapse,
  getBlockCollapseInfo,
  qingagentCollapseKey,
  setBlockCollapseForceExpanded,
  toggleBlockCollapse,
} from "./BlockCollapse";
import { ColumnCM, ColumnListCM } from "./ColumnView";

const mountedEditors: Editor[] = [];

function createEditor(
  content: JSONContent,
  options: { docId?: string | null; forceExpanded?: boolean } = {},
): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      ...createQingagentExtensions({
        columnListExtension: ColumnListCM,
        columnExtension: ColumnCM,
      }),
      BlockCollapseExtension.configure({
        docId: options.docId ?? "collapse-doc",
        forceExpanded: options.forceExpanded ?? false,
      }),
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
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
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

function heading(blockId: string, level: number, value: string): JSONContent {
  return {
    type: "heading",
    attrs: { blockId, level },
    content: [text(value)],
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

function findNodePosition(editor: Editor, type: string, blockId: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === type && node.attrs.blockId === blockId) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function listCollapseDoc(): JSONContent {
  return doc([
    bulletList("list-root", [
      listItem("li-parent", "父项", [
        bulletList("list-child", [
          listItem("li-child", "子项"),
        ]),
      ]),
      listItem("li-single", "单层"),
    ]),
    taskList("task-root", [
      taskItem("task-parent", "待办父项", false, [
        taskList("task-child", [
          taskItem("task-child-item", "待办子项", false),
        ]),
      ]),
    ]),
  ]);
}

function headingCollapseDoc(): JSONContent {
  return doc([
    heading("h1-a", 1, "一"),
    heading("h2-a", 2, "一-二"),
    paragraph("p-under-h2", "下级正文"),
    heading("h2-empty", 2, "空节"),
    heading("h1-b", 1, "二"),
    paragraph("p-after-h1b", "不应隐藏"),
  ]);
}

describe("BlockCollapse", () => {
  it("只给含子 list 的普通 listItem 和有 body 的 heading 开放折叠", () => {
    const editor = createEditor(listCollapseDoc());

    const parentInfo = getBlockCollapseInfo(editor.state, findNodePosition(editor, "listItem", "li-parent"));
    const singleInfo = getBlockCollapseInfo(editor.state, findNodePosition(editor, "listItem", "li-single"));
    const taskInfo = getBlockCollapseInfo(editor.state, findNodePosition(editor, "taskItem", "task-parent"));

    expect(parentInfo).toMatchObject({ canToggle: true, blockId: "li-parent", kind: "listItem" });
    expect(singleInfo).toBeNull();
    expect(taskInfo).toBeNull();

    const headingEditor = createEditor(headingCollapseDoc());
    expect(getBlockCollapseInfo(headingEditor.state, findNodePosition(headingEditor, "heading", "h1-a"))).toMatchObject({
      canToggle: true,
      blockId: "h1-a",
      kind: "heading",
    });
    // H2 后面只有正文(无更深 H3)也应可折叠——折叠它会隐藏其下正文区间
    expect(getBlockCollapseInfo(headingEditor.state, findNodePosition(headingEditor, "heading", "h2-a"))).toMatchObject({
      canToggle: true,
      blockId: "h2-a",
      kind: "heading",
    });
    // 空节标题(紧邻同级标题、节下无任何 body)不出折叠箭头
    expect(getBlockCollapseInfo(headingEditor.state, findNodePosition(headingEditor, "heading", "h2-empty"))).toBeNull();
  });

  it("折叠列表只隐藏托管子 list,并保持 getJSON 零污染", () => {
    const editor = createEditor(listCollapseDoc());
    const before = normalized(editor);

    toggleBlockCollapse(editor, "li-parent");

    const parent = editor.view.dom.querySelector('li[data-block-id="li-parent"]');
    const childList = editor.view.dom.querySelector('ul[data-block-id="list-child"]');
    const task = editor.view.dom.querySelector('li[data-block-id="task-parent"]');
    expect(parent?.classList.contains("is-folded-head")).toBe(true);
    expect(childList?.classList.contains("is-folded-hidden")).toBe(true);
    expect(task?.classList.contains("is-folded-head")).toBe(false);
    expect(normalized(editor)).toEqual(before);
    expect(JSON.stringify(editor.getJSON())).not.toContain("collapsed");
  });

  it("折叠标题只隐藏同一父容器内到下个同级/上级标题前的区间", () => {
    const editor = createEditor(headingCollapseDoc());
    const before = normalized(editor);

    toggleBlockCollapse(editor, "h1-a");

    expect(editor.view.dom.querySelector('[data-block-id="h1-a"]')?.classList.contains("is-folded-head")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="h2-a"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="p-under-h2"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="h1-b"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(normalized(editor)).toEqual(before);
  });

  it("折叠 H2(节下仅正文)只隐藏正文,不越过下个同级 H2", () => {
    const editor = createEditor(headingCollapseDoc());

    toggleBlockCollapse(editor, "h2-a");

    expect(editor.view.dom.querySelector('[data-block-id="h2-a"]')?.classList.contains("is-folded-head")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="p-under-h2"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="h2-empty"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(editor.view.dom.querySelector('[data-block-id="h1-b"]')?.classList.contains("is-folded-hidden")).toBe(false);
  });

  it("已折叠标题末尾回车:在折叠区后插入同级标题,且原标题保持折叠", () => {
    const editor = createEditor(headingCollapseDoc());
    toggleBlockCollapse(editor, "h2-a"); // h2-a 下接 p-under-h2,可折叠
    const h2Pos = findNodePosition(editor, "heading", "h2-a");
    const h2Node = editor.state.doc.nodeAt(h2Pos)!;
    editor.commands.setTextSelection(h2Pos + 1 + h2Node.content.size); // 光标到 h2-a 末尾

    const handled = editor.view.someProp("handleKeyDown", (fn) =>
      fn(editor.view, new KeyboardEvent("keydown", { key: "Enter" })),
    );
    expect(handled).toBe(true);

    // 原标题仍折叠
    expect(getBlockCollapseInfo(editor.state, findNodePosition(editor, "heading", "h2-a"))?.collapsed).toBe(true);
    // 光标落在新的 2 级标题里
    const $from = editor.state.selection.$from;
    expect($from.parent.type.name).toBe("heading");
    expect($from.parent.attrs.level).toBe(2);
    // 新标题在 p-under-h2(h2-a 的折叠区)之后
    expect($from.before($from.depth)).toBeGreaterThan(findNodePosition(editor, "paragraph", "p-under-h2"));
  });

  it("标题折叠不会跨 column 父容器", () => {
    const editor = createEditor(doc([
      columnList("cols", [
        {
          id: "col-a",
          ratio: 0.5,
          blocks: [heading("col-h1", 1, "左"), heading("col-h2", 2, "左下"), paragraph("col-p", "左文")],
        },
        {
          id: "col-b",
          ratio: 0.5,
          blocks: [heading("other-h2", 2, "右下"), paragraph("other-p", "右文")],
        },
      ]),
    ]));

    toggleBlockCollapse(editor, "col-h1");

    expect(editor.view.dom.querySelector('[data-block-id="col-h2"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="col-p"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="other-h2"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(editor.view.dom.querySelector('[data-block-id="other-p"]')?.classList.contains("is-folded-hidden")).toBe(false);
  });

  it("toggle 只发非 docChanged transaction,不触发 update/undo", () => {
    const editor = createEditor(listCollapseDoc());
    const update = vi.fn();
    const transactions: boolean[] = [];
    editor.on("update", update);
    editor.on("transaction", ({ transaction }) => {
      transactions.push(transaction.docChanged);
    });

    toggleBlockCollapse(editor, "li-parent");

    expect(update).not.toHaveBeenCalled();
    expect(transactions).toEqual([false]);
    expect(editor.commands.undo()).toBe(false);
  });

  // 回归 fold-collapse-triangle-disappears:折叠 toggle 不发 update,常驻三角重算改成监听
  // transaction 并按 collapse meta 过滤。锁定契约:toggle 事务必须携带 qingagentCollapseKey meta,
  // 否则 DocumentSnapshotView 的 transaction 监听过滤不到、三角又只能靠滚动出现。
  it("toggle transaction 携带 qingagentCollapseKey meta(常驻三角重算依赖此信号)", () => {
    const editor = createEditor(listCollapseDoc());
    const metas: unknown[] = [];
    editor.on("transaction", ({ transaction }) => {
      metas.push(transaction.getMeta(qingagentCollapseKey));
    });

    toggleBlockCollapse(editor, "li-parent");

    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ kind: "toggle", blockId: "li-parent" });
  });

  it("localStorage 按 docId 保留折叠状态,缺失 blockId 不报错", () => {
    const first = createEditor(listCollapseDoc(), { docId: "doc-persist" });
    toggleBlockCollapse(first, "li-parent");
    first.destroy();

    const second = createEditor(listCollapseDoc(), { docId: "doc-persist" });
    expect(second.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(true);

    expect(() => createEditor(doc([paragraph("new-p", "新文档")]), { docId: "doc-persist" })).not.toThrow();
  });

  it("编辑后 Decoration 位置继续跟随当前文档", () => {
    const editor = createEditor(headingCollapseDoc());
    toggleBlockCollapse(editor, "h1-a");
    const h1Pos = findNodePosition(editor, "heading", "h1-a");

    editor.view.dispatch(editor.state.tr.insertText("改", h1Pos + 1));

    expect(editor.view.dom.querySelector('[data-block-id="h2-a"]')?.classList.contains("is-folded-hidden")).toBe(true);
    expect(editor.view.dom.querySelector('[data-block-id="p-under-h2"]')?.classList.contains("is-folded-hidden")).toBe(true);
  });

  it("审阅态强制全展开但保留折叠 Set", () => {
    const editor = createEditor(listCollapseDoc());
    toggleBlockCollapse(editor, "li-parent");
    expect(editor.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(true);

    setBlockCollapseForceExpanded(editor, true);
    expect(editor.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(qingagentCollapseKey.getState(editor.state)?.collapsed.has("li-parent")).toBe(true);

    setBlockCollapseForceExpanded(editor, false);
    expect(editor.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(true);
  });

  it("拖拽消费端 expand meta 会展开已折叠目标", () => {
    const editor = createEditor(listCollapseDoc());
    toggleBlockCollapse(editor, "li-parent");

    editor.view.dispatch(
      editor.state.tr
        .setMeta(qingagentCollapseKey, createExpandBlockCollapseMeta("li-parent"))
        .setMeta("skipTrailingNode", true),
    );

    expect(editor.view.dom.querySelector('li[data-block-id="li-parent"]')?.classList.contains("is-folded-head")).toBe(false);
    expect(editor.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(qingagentCollapseKey.getState(editor.state)?.collapsed.has("li-parent")).toBe(false);
  });

  it("standalone expand helper 也只改 collapse state", () => {
    const editor = createEditor(listCollapseDoc());
    toggleBlockCollapse(editor, "li-parent");

    expandBlockCollapse(editor, "li-parent");

    expect(editor.view.dom.querySelector('ul[data-block-id="list-child"]')?.classList.contains("is-folded-hidden")).toBe(false);
    expect(qingagentCollapseKey.getState(editor.state)?.collapsed.has("li-parent")).toBe(false);
  });
});
