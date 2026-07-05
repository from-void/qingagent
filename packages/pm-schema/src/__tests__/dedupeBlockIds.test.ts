// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";

type BlockIdDoc = {
  type: string;
  attrs?: { blockId?: string; [key: string]: unknown };
  content?: BlockIdDoc[];
  text?: string;
};

function createEditor(content: JSONContent = doc([paragraph("anchor", "起点")])): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
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

describe("DedupeBlockIds", () => {
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

  it("replace-all/setContent 类远端应用遇到重复 id 时不静默改写", () => {
    const editor = createEditor(doc([paragraph("p-1", "原文")]));
    try {
      editor.commands.setContent(doc([paragraph("remote", "远端一"), paragraph("remote", "远端二")]));

      expect(collectBlockIds(editor.getJSON() as BlockIdDoc)).toEqual(["remote", "remote"]);
    } finally {
      destroyEditor(editor);
    }
  });
});
