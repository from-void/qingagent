// @vitest-environment jsdom

import { Editor, Extension, type AnyExtension, type JSONContent } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap, handlePaste } from "@tiptap/pm/tables";
import { describe, expect, it } from "vitest";
import { applyBlockEdits } from "../ai-ir/applyBlockEdits";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";
import { APPLYING_REMOTE_META, createDedupeBlockIdsTransaction } from "../tiptap/dedupeBlockIds";
import { normalizePmDoc } from "../validators";

type BlockIdDoc = {
  type: string;
  attrs?: { blockId?: string; [key: string]: unknown };
  content?: BlockIdDoc[];
  text?: string;
};

function createEditor(
  content: JSONContent = doc([paragraph("anchor", "起点")]),
  extraExtensions: AnyExtension[] = [],
): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [...extraExtensions, ...createQingagentExtensions()],
    content,
  });
}

function destroyEditor(editor: Editor) {
  const element = editor.options.element;
  editor.destroy();
  if (element instanceof HTMLElement) element.remove();
}

function doc(content: JSONContent[]): JSONContent {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function paragraph(blockId: string, text = ""): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : undefined,
  };
}

function bulletList(blockId: string, items: JSONContent[]): JSONContent {
  return { type: "bulletList", attrs: { blockId }, content: items };
}

function orderedList(blockId: string, items: JSONContent[]): JSONContent {
  return { type: "orderedList", attrs: { blockId, start: 1 }, content: items };
}

function listItem(blockId: string, content: JSONContent[]): JSONContent {
  return { type: "listItem", attrs: { blockId }, content };
}

function taskList(blockId: string, items: JSONContent[]): JSONContent {
  return { type: "taskList", attrs: { blockId }, content: items };
}

function taskItem(blockId: string, content: JSONContent[], checked = false): JSONContent {
  return { type: "taskItem", attrs: { blockId, checked }, content };
}

function blockMath(blockId: string, latex: string): JSONContent {
  return { type: "blockMath", attrs: { blockId, latex } };
}

function fileAttachment(blockId: string): JSONContent {
  return {
    type: "fileAttachment",
    attrs: {
      blockId,
      fileId: "file-r9",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      size: 42,
    },
  };
}

function collectBlockIds(value: BlockIdDoc): string[] {
  const ids: string[] = [];
  const visit = (node: BlockIdDoc) => {
    if (typeof node.attrs?.blockId === "string") ids.push(node.attrs.blockId);
    for (const child of node.content ?? []) visit(child);
  };
  visit(value);
  return ids;
}

function insertTopLevel(editor: Editor, content: JSONContent) {
  const node = editor.schema.nodeFromJSON(content);
  editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, node));
}

function insertHtmlAtEnd(editor: Editor, html: string) {
  expect(editor.commands.insertContentAt(editor.state.doc.content.size, html)).toBe(true);
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  let handled = false;
  editor.view.someProp("handleKeyDown", (handler) => {
    const result = handler(editor.view, event);
    handled = handled || result === true;
    return result === true;
  });
  return handled;
}

function topLevelBlocks(editor: Editor): BlockIdDoc[] {
  return (editor.getJSON() as BlockIdDoc).content ?? [];
}

function blockIdAtPath(editor: Editor, path: readonly number[]): string {
  let node: BlockIdDoc = editor.getJSON() as BlockIdDoc;
  for (const index of path) {
    node = node.content?.[index] as BlockIdDoc;
  }
  const blockId = node.attrs?.blockId;
  if (typeof blockId !== "string") throw new Error(`missing blockId at path ${path.join(".")}`);
  return blockId;
}

function selectTableRect(
  editor: Editor,
  tableIndex: number,
  rect: { left: number; top: number; right: number; bottom: number },
) {
  let tablePos = 0;
  for (let index = 0; index < tableIndex; index += 1) {
    tablePos += editor.state.doc.child(index).nodeSize;
  }
  const tableNode = editor.state.doc.child(tableIndex);
  const tableStart = tablePos + 1;
  const map = TableMap.get(tableNode);
  const anchor = tableStart + map.positionAt(rect.top, rect.left, tableNode);
  const head = tableStart + map.positionAt(rect.bottom - 1, rect.right - 1, tableNode);
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, anchor, head)));
}

function table(blockId: string, rows: string[][]): JSONContent {
  return {
    type: "table",
    attrs: { blockId },
    content: rows.map((row) => ({
      type: "tableRow",
      content: row.map((text) => ({
        type: "tableCell",
        content: [paragraph(`${blockId}-${text}`, text)],
      })),
    })),
  };
}

function assertBlockEditsUsable(editor: Editor, tableRef: string) {
  const result = applyBlockEdits(normalizePmDoc(editor.getJSON()), [
    {
      action: "replaceBlock",
      ref: "tail",
      block: { type: "paragraph", runs: [{ text: "尾段已改" }] },
    },
    {
      action: "insertTableRow",
      ref: tableRef,
      at: "end",
      cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "AI 新行" }] }] }],
    },
  ]);
  expect(result.ok, result.error).toBe(true);
}

function pasteSelectedCells(editor: Editor, targetTableIndex: number, targetRect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) {
  const slice = editor.state.selection.content();
  selectTableRect(editor, targetTableIndex, targetRect);
  expect(handlePaste(editor.view, {} as ClipboardEvent, slice)).toBe(true);
}

function pasteSelectedCellsThroughDom(editor: Editor, targetTableIndex: number, targetRect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) {
  const serialized = editor.view.serializeForClipboard(editor.state.selection.content());
  const wrapper = document.createElement("div");
  wrapper.appendChild(serialized.dom);
  selectTableRect(editor, targetTableIndex, targetRect);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (type: string) => type === "text/html" ? wrapper.innerHTML : serialized.text,
      setData: () => undefined,
    },
  });
  editor.view.dom.dispatchEvent(event);
}

const AppendLocalDuplicateAfterRemote = Extension.create({
  name: "appendLocalDuplicateAfterRemote",
  priority: 1_000,

  addProseMirrorPlugins() {
    let appended = false;
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (appended || !transactions.some((tr) => tr.getMeta(APPLYING_REMOTE_META))) return null;
          appended = true;
          const duplicate = newState.schema.nodeFromJSON(paragraph("remote", "同批本地追加"));
          return newState.tr.insert(newState.doc.content.size, duplicate);
        },
      }),
    ];
  },
});

describe("DedupeBlockIds", () => {
  it("trailingNode 为列表追加的文末空段不分配 blockId", () => {
    const editor = createEditor(doc([paragraph("before", "旧正文")]));
    try {
      editor.chain()
        .setMeta(APPLYING_REMOTE_META, true)
        .setContent(doc([
          orderedList("list-1", [
            listItem("item-1", [paragraph("item-1-p", "第一项")]),
          ]),
        ]))
        .run();

      const blocks = topLevelBlocks(editor);
      expect(blocks.map((block) => block.type)).toEqual(["orderedList", "paragraph"]);
      expect(blocks[1]?.content).toBeUndefined();
      expect(blocks[1]?.attrs?.blockId).toBeNull();
    } finally {
      destroyEditor(editor);
    }
  });

  it("R9：原子块后 Enter 新建的段落在本地事务内获得 blockId", () => {
    const editor = createEditor(doc([
      paragraph("before", "前文"),
      blockMath("math", "E=mc^2"),
      paragraph("tail", "文末"),
    ]));
    try {
      const mathPos = editor.state.doc.child(0).nodeSize;
      const math = editor.state.doc.nodeAt(mathPos);
      expect(math).not.toBeNull();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, mathPos)));

      expect(pressEnter(editor)).toBe(true);
      expect(editor.state.selection).toBeInstanceOf(TextSelection);
      expect(editor.state.selection.from).toBe(mathPos + math!.nodeSize + 1);
      editor.view.dispatch(editor.state.tr.insertText("紧跟输入", editor.state.selection.from));
      const blocks = topLevelBlocks(editor);
      expect(blocks.map((block) => block.type)).toEqual([
        "paragraph",
        "blockMath",
        "paragraph",
        "paragraph",
      ]);
      expect(blocks[2]?.attrs?.blockId).toMatch(/^block-inserted(?:~\d+)?$/);
      expect(blocks[2]?.content?.[0]?.text).toBe("紧跟输入");
    } finally {
      destroyEditor(editor);
    }
  });

  it("R9：附件后 Enter 新段的 blockId 与输入位置在本地事务内稳定", () => {
    const editor = createEditor(doc([
      paragraph("before", "前文"),
      fileAttachment("file"),
      paragraph("tail", "文末"),
    ]));
    try {
      const filePos = editor.state.doc.child(0).nodeSize;
      const file = editor.state.doc.nodeAt(filePos);
      expect(file).not.toBeNull();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, filePos)));

      expect(pressEnter(editor)).toBe(true);
      expect(editor.state.selection).toBeInstanceOf(TextSelection);
      expect(editor.state.selection.from).toBe(filePos + file!.nodeSize + 1);
      editor.view.dispatch(editor.state.tr.insertText("附件后输入", editor.state.selection.from));

      const blocks = topLevelBlocks(editor);
      expect(blocks.map((block) => block.type)).toEqual([
        "paragraph",
        "fileAttachment",
        "paragraph",
        "paragraph",
      ]);
      expect(blocks[2]?.attrs?.blockId).toMatch(/^block-inserted(?:~\d+)?$/);
      expect(blocks[2]?.content?.[0]?.text).toBe("附件后输入");
    } finally {
      destroyEditor(editor);
    }
  });

  it("真实 EditorView paste 事件复制整行后，全文档唯一且 AI 编辑可用", () => {
    const editor = createEditor(doc([
      table("table-1", [["a1", "a2"], ["b1", "b2"], ["c1", "c2"]]),
      paragraph("tail", "尾段"),
    ]));
    try {
      selectTableRect(editor, 0, { left: 0, top: 0, right: 2, bottom: 1 });
      pasteSelectedCellsThroughDom(editor, 0, { left: 0, top: 2, right: 2, bottom: 3 });

      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(ids).toContain("table-1-a1~1");
      expect(new Set(ids).size).toBe(ids.length);
      assertBlockEditsUsable(editor, "table-1");
    } finally {
      destroyEditor(editor);
    }
  });

  it("PM 原生整行复制粘贴后，重写后出现的 cell 后代 blockId", () => {
    const editor = createEditor(doc([
      table("table-1", [["a1", "a2"], ["b1", "b2"], ["c1", "c2"]]),
      paragraph("tail", "尾段"),
    ]));
    try {
      selectTableRect(editor, 0, { left: 0, top: 0, right: 2, bottom: 1 });
      pasteSelectedCells(editor, 0, { left: 0, top: 2, right: 2, bottom: 3 });

      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(new Set(ids).size).toBe(ids.length);
      assertBlockEditsUsable(editor, "table-1");
    } finally {
      destroyEditor(editor);
    }
  });

  it("PM 原生整列复制粘贴后，全文档唯一且 AI 块/表格编辑可用", () => {
    const editor = createEditor(doc([
      table("table-1", [["a1", "a2", "a3"], ["b1", "b2", "b3"]]),
      paragraph("tail", "尾段"),
    ]));
    try {
      selectTableRect(editor, 0, { left: 0, top: 0, right: 1, bottom: 2 });
      pasteSelectedCells(editor, 0, { left: 2, top: 0, right: 3, bottom: 2 });

      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(new Set(ids).size).toBe(ids.length);
      assertBlockEditsUsable(editor, "table-1");
    } finally {
      destroyEditor(editor);
    }
  });

  it("PM 原生跨表复制粘贴后，按全文档序保留首个 id 并重写目标表后代", () => {
    const editor = createEditor(doc([
      table("table-source", [["a1", "a2"], ["b1", "b2"]]),
      table("table-target", [["c1", "c2"], ["d1", "d2"]]),
      paragraph("tail", "尾段"),
    ]));
    try {
      selectTableRect(editor, 0, { left: 0, top: 0, right: 2, bottom: 1 });
      pasteSelectedCells(editor, 1, { left: 0, top: 1, right: 2, bottom: 2 });

      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("table-source-a1");
      expect(ids).toContain("table-source-a1~1");
      assertBlockEditsUsable(editor, "table-target");
    } finally {
      destroyEditor(editor);
    }
  });

  it("本地插入外部 HTML 带 data-block-id 后，全文档 blockId 保持唯一", () => {
    const editor = createEditor(doc([paragraph("p-1", "原文")]));
    try {
      insertHtmlAtEnd(editor, '<p data-block-id="p-1">粘贴段落</p>');

      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(ids).toEqual(["p-1", "p-1~1"]);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      destroyEditor(editor);
    }
  });

  it("分配新 id 时避开已有 ~N，保留原本唯一的顶层 id", () => {
    const editor = createEditor(doc([paragraph("dup", "原文"), paragraph("dup~1", "既有后缀")]));
    try {
      insertTopLevel(editor, paragraph("dup", "粘贴段落"));

      const ids = topLevelBlocks(editor).map((node) => node.attrs?.blockId);
      expect(ids).toEqual(["dup", "dup~1", "dup~2"]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("嵌套 listItem 与顶层块撞 id 时，只重写后出现的子项", () => {
    const editor = createEditor(doc([paragraph("item-dup", "顶层先出现")]));
    try {
      insertTopLevel(
        editor,
        bulletList("list-1", [
          listItem("item-dup", [
            paragraph("item-dup-p", "父项"),
            orderedList("nested-list", [
              listItem("nested-item", [paragraph("item-dup-p", "子项段落也重复")]),
            ]),
          ]),
        ]),
      );

      expect(blockIdAtPath(editor, [0])).toBe("item-dup");
      expect(blockIdAtPath(editor, [1, 0])).toBe("item-dup~1");
      expect(blockIdAtPath(editor, [1, 0, 0])).toBe("item-dup-p");
      expect(blockIdAtPath(editor, [1, 0, 1, 0, 0])).toBe("item-dup-p~1");
      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      destroyEditor(editor);
    }
  });

  it("taskItem 重复 id 也参与全文档去重", () => {
    const editor = createEditor(doc([paragraph("task-1", "既有块")]));
    try {
      insertTopLevel(
        editor,
        taskList("tasks", [
          taskItem("task-1", [paragraph("task-1-p", "待办")], true),
          taskItem("task-1", [paragraph("task-1-p", "待办二")], false),
        ]),
      );

      expect(blockIdAtPath(editor, [0])).toBe("task-1");
      expect(blockIdAtPath(editor, [1, 0])).toBe("task-1~1");
      expect(blockIdAtPath(editor, [1, 1])).toBe("task-1~2");
      expect(blockIdAtPath(editor, [1, 0, 0])).toBe("task-1-p");
      expect(blockIdAtPath(editor, [1, 1, 0])).toBe("task-1-p~1");
      const ids = collectBlockIds(editor.getJSON() as BlockIdDoc);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      destroyEditor(editor);
    }
  });

  it("去重 appendTransaction 不进入 undo 历史", () => {
    const editor = createEditor(doc([paragraph("p-1", "原文")]));
    try {
      insertTopLevel(editor, paragraph("p-1", "粘贴段落"));
      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["p-1", "p-1~1"]);

      expect(editor.commands.undo()).toBe(true);
      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["p-1"]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("未标记为远端的 whole-doc 本地事务也必须去重", () => {
    const editor = createEditor(doc([paragraph("p-1", "原文")]));
    try {
      editor.commands.setContent(doc([paragraph("local", "本地一"), paragraph("local", "本地二")]));

      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["local", "local~1"]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("显式标记的 remote/replace-all 事务仍跳过去重", () => {
    const editor = createEditor(doc([paragraph("p-1", "原文")]));
    try {
      editor.chain()
        .setMeta(APPLYING_REMOTE_META, true)
        .setContent(doc([paragraph("remote", "远端一"), paragraph("remote", "远端二")]))
        .run();

      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["remote", "remote"]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("同一 append 批次含 remote 与其后本地写入时，只跳 remote 且仍归一本地结果", () => {
    const editor = createEditor(
      doc([paragraph("p-1", "原文")]),
      [AppendLocalDuplicateAfterRemote],
    );
    try {
      editor.chain()
        .setMeta(APPLYING_REMOTE_META, true)
        .setContent(doc([paragraph("remote", "远端正文")]))
        .run();

      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["remote", "remote~1"]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("存量文档可显式执行一次性归一事务，规则与入口去重一致", () => {
    const editor = createEditor(doc([
      paragraph("dup", "首个保留"),
      paragraph("dup", "后续重写"),
      paragraph("dup~1", "既有后缀保留"),
    ]));
    try {
      const repair = createDedupeBlockIdsTransaction(editor.state);
      expect(repair).not.toBeNull();
      editor.view.dispatch(repair!);

      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["dup", "dup~2", "dup~1"]);
      expect(createDedupeBlockIdsTransaction(editor.state)).toBeNull();
    } finally {
      destroyEditor(editor);
    }
  });
});
