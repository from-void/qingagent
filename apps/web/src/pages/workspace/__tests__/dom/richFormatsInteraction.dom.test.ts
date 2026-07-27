// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection, TextSelection, type Selection } from "@tiptap/pm/state";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, pmToMarkdown, safeParsePmDoc, type PmBlockNode, type PmDoc, type PmInlineNode } from "@qingagent/pm-schema";
import { describe, expect, it, vi } from "vitest";
import { CodeBlockCM } from "../../components/CodeBlockView";
import { createBlockDragPayload, handleQingagentPaste } from "../../components/DocumentSnapshotView";

function createEditor(content: PmDoc | JSONContent = docWithParagraph("")) {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content: content as JSONContent,
  });
}

function createCodeBlockEditor(content: PmDoc | JSONContent = docWithParagraph("")) {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createQingagentExtensions({ codeBlockExtension: CodeBlockCM }),
    content: content as JSONContent,
  });
}

function destroyEditor(editor: Editor) {
  const element = editor.options.element;
  editor.destroy();
  if (element instanceof HTMLElement) element.remove();
}

function docWithParagraph(text: string, blockId = "p-1"): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "paragraph",
        attrs: { blockId },
        ...(text ? { content: [{ type: "text" as const, text }] } : {}),
      },
    ],
  };
}

function pmText(text: string) {
  return { type: "text" as const, text };
}

function pmParagraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [pmText(text)] : [],
  };
}

function pmTable(blockId: string, cellText: string): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId },
    content: [{
      type: "tableRow",
      content: [{
        type: "tableCell",
        content: [pmParagraph(`${blockId}-cell-p`, cellText)],
      }],
    }],
  };
}

function pmDoc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function normalized(editor: Editor): PmDoc {
  return normalizePmDoc(editor.getJSON());
}

function cloneDoc(doc: PmDoc): PmDoc {
  return JSON.parse(JSON.stringify(doc)) as PmDoc;
}

function inlineText(content: readonly PmInlineNode[] | undefined) {
  return (content ?? []).map((node) => (node.type === "text" ? node.text : "")).join("");
}

function paragraphText(block: PmBlockNode | undefined) {
  if (block?.type !== "paragraph") throw new Error(`expected paragraph, got ${block?.type ?? "missing"}`);
  return inlineText(block.content);
}

function taskTexts(block: PmBlockNode | undefined) {
  if (block?.type !== "taskList") throw new Error(`expected taskList, got ${block?.type ?? "missing"}`);
  return block.content.map((item) => paragraphText(item.content[0]));
}

function findTextPosition(editor: Editor, text: string, edge: "start" | "end" = "start") {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText && node.text) {
      const index = node.text.indexOf(text);
      if (index >= 0) {
        found = pos + index + (edge === "end" ? text.length : 0);
        return false;
      }
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function findNodePosition(
  editor: Editor,
  type: string,
  predicate: (node: ProseMirrorNode) => boolean = () => true,
) {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === type && predicate(node)) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function setSelection(editor: Editor, selection: Selection) {
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}

function setTextSelection(editor: Editor, from: number, to = from) {
  setSelection(editor, TextSelection.create(editor.state.doc, from, to));
}

function key(editor: Editor, name: string) {
  return editor.commands.keyboardShortcut(name);
}

function pasteEvent(input: { text?: string; html?: string }) {
  return {
    clipboardData: {
      getData(type: string) {
        if (type === "text/plain") return input.text ?? "";
        if (type === "text/html") return input.html ?? "";
        return "";
      },
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

function fireTextInput(editor: Editor, char: string) {
  const pos = editor.state.selection.from;
  let handled = false;
  editor.view.someProp("handleTextInput", (handler) =>
    {
      const result = handler(editor.view, pos, pos, char, () => {
        editor.view.dispatch(editor.state.tr.insertText(char, pos, pos));
        return editor.state.tr;
      });
      handled = handled || result === true;
      return result;
    },
  );
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, pos, pos));
}

function richFormatsDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "taskList",
        attrs: { blockId: "tasks-all" },
        content: [
          {
            type: "taskItem",
            attrs: { blockId: "task-all-1", checked: false },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "task-all-1-p" },
                content: [
                  { type: "text", text: "待办 " },
                  { type: "inlineMath", attrs: { latex: "x+1" } },
                ],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { blockId: "task-all-2", checked: true },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "task-all-2-p" },
                content: [{ type: "text", text: "完成项" }],
              },
            ],
          },
        ],
      },
      {
        type: "callout",
        attrs: { blockId: "callout-all", emoji: "!", tone: "warning" },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "callout-all-p1" },
            content: [
              { type: "text", text: "公式 " },
              { type: "inlineMath", attrs: { latex: "a^2+b^2=c^2" } },
              { type: "text", text: " 需要复核" },
            ],
          },
          {
            type: "paragraph",
            attrs: { blockId: "callout-all-p2" },
            content: [{ type: "text", text: "第二段" }],
          },
        ],
      },
      { type: "blockMath", attrs: { blockId: "math-all", latex: "\\int_0^1 x^2\\,dx=\\frac{1}{3}" } },
      {
        type: "paragraph",
        attrs: { blockId: "tail-all" },
        content: [
          { type: "text", text: "尾段 " },
          { type: "inlineMath", attrs: { latex: "E=mc^2" } },
        ],
      },
    ],
  };
}

describe("richFormatsInteraction 粘贴解析", () => {
  it("R3-01 text/plain 块级 Markdown 粘贴为结构化块", () => {
    const editor = createEditor();
    try {
      editor.commands.selectAll();
      const event = pasteEvent({
        text: [
          "# 标题",
          "",
          "- 条目一",
          "- 条目二",
          "",
          "| A | B |",
          "| --- | --- |",
          "| 1 | 2 |",
          "",
          "```mermaid",
          "flowchart TD",
          "A-->B",
          "```",
        ].join("\n"),
      });

      expect(handleQingagentPaste(editor.view, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      const doc = normalized(editor);
      expect(doc.content.slice(0, 4).map((block) => block.type)).toEqual(["heading", "bulletList", "table", "diagram"]);
      expect(doc.content[0]).toMatchObject({ type: "heading", content: [{ type: "text", text: "标题" }] });
    } finally {
      destroyEditor(editor);
    }
  });

  it("R3-14 text/plain 不触发 ** paste rule,也不继承当前 bold mark", () => {
    const editor = createEditor();
    try {
      editor.commands.selectAll();
      editor.commands.toggleBold();
      expect(handleQingagentPaste(editor.view, pasteEvent({ text: "**raw**" }))).toBe(true);

      const first = normalized(editor).content[0];
      expect(first).toMatchObject({
        type: "paragraph",
        content: [{ type: "text", text: "**raw**" }],
      });
      expect(JSON.stringify(first)).not.toContain('"bold"');
    } finally {
      destroyEditor(editor);
    }
  });

  it("R3-12 HTML data URL 图片粘贴会提示,不再静默丢失", () => {
    const editor = createEditor();
    const onToast = vi.fn();
    try {
      const handled = handleQingagentPaste(
        editor.view,
        pasteEvent({ html: '<p>图</p><img src="data:image/png;base64,AAAA">' }),
        onToast,
      );

      expect(handled).toBe(false);
      expect(onToast).toHaveBeenCalledWith("暂不支持粘贴内嵌图片，请用工具栏上传");
    } finally {
      destroyEditor(editor);
    }
  });

  it("R4-020 HTML 坏图不会解析成 image 节点占位", () => {
    const editor = createEditor();
    try {
      expect(handleQingagentPaste(editor.view, pasteEvent({ html: '<p>图</p><img src="x">' }))).toBe(false);
      editor.commands.insertContent('<p data-block-id="p-html-img">图</p><img src="x">');

      const doc = normalized(editor);
      expect(JSON.stringify(doc)).not.toContain('"type":"image"');
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it("insertContent 解析 taskList/callout/inlineMath HTML, callout emoji 装饰不进入正文", () => {
    const editor = createEditor();
    const html =
      '<ul data-type="taskList" data-block-id="tasks-html">' +
      '<li data-type="taskItem" data-checked="true" data-block-id="task-html-1">' +
      '<div><p data-block-id="task-html-1-p">已完成 <span data-type="inline-math" data-latex="x+1"></span></p></div>' +
      "</li>" +
      '<li data-type="taskItem" data-checked="false" data-block-id="task-html-2">' +
      '<div><p data-block-id="task-html-2-p">未完成</p></div>' +
      "</li>" +
      "</ul>" +
      '<div data-pm-node="callout" data-block-id="callout-html" data-tone="danger" data-emoji="!">' +
      '<span class="pm-callout-emoji" contenteditable="false">不应进入正文</span>' +
      '<div class="pm-callout-body">' +
      '<p data-block-id="callout-html-p">正文 <span data-type="inline-math" data-latex="a^2"></span> 保留</p>' +
      "</div>" +
      "</div>" +
      '<p data-block-id="tail-html">行内 <span data-type="inline-math" data-latex="E=mc^2"></span> 结束</p>';

    try {
      editor.commands.selectAll();
      expect(editor.commands.insertContent(html)).toBe(true);

      const doc = normalized(editor);
      expect(doc.content.map((block) => block.type)).toEqual(["taskList", "callout", "paragraph"]);

      const tasks = doc.content[0];
      expect(tasks?.type).toBe("taskList");
      if (tasks?.type === "taskList") {
        expect(tasks.attrs.blockId).toBe("tasks-html");
        expect(tasks.content.map((item) => item.attrs.checked)).toEqual([true, false]);
        const firstTaskParagraph = tasks.content[0]?.content[0];
        expect(firstTaskParagraph?.type).toBe("paragraph");
        expect(firstTaskParagraph?.type === "paragraph" ? firstTaskParagraph.content : []).toEqual([
          { type: "text", text: "已完成 " },
          { type: "inlineMath", attrs: { latex: "x+1" } },
        ]);
      }

      const callout = doc.content[1];
      expect(callout?.type).toBe("callout");
      if (callout?.type === "callout") {
        expect(callout.attrs).toMatchObject({ blockId: "callout-html", emoji: "!", tone: "danger" });
        expect(JSON.stringify(callout.content)).not.toContain("不应进入正文");
        expect(callout.content[0]?.content).toEqual([
          { type: "text", text: "正文 " },
          { type: "inlineMath", attrs: { latex: "a^2" } },
          { type: "text", text: " 保留" },
        ]);
      }

      const tail = doc.content[2];
      expect(tail?.type === "paragraph" ? tail.content : []).toEqual([
        { type: "text", text: "行内 " },
        { type: "inlineMath", attrs: { latex: "E=mc^2" } },
        { type: "text", text: " 结束" },
      ]);
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 输入规则收尾", () => {
  it("R3-13 标题转换后不凭空追加空段落", () => {
    const headingEditor = createEditor();
    try {
      headingEditor.commands.selectAll();
      expect(headingEditor.commands.setHeading({ level: 1 })).toBe(true);
      expect(normalized(headingEditor).content.map((block) => block.type)).toEqual(["heading"]);
    } finally {
      destroyEditor(headingEditor);
    }
  });

  it("R4-014 单美元行内公式输入规则与双美元规则并存", () => {
    const inlineEditor = createEditor(docWithParagraph("$a^2+b^2"));
    try {
      setTextSelection(inlineEditor, findTextPosition(inlineEditor, "$a^2+b^2", "end"));
      fireTextInput(inlineEditor, "$");
      const paragraph = normalized(inlineEditor).content[0];
      expect(paragraph?.type === "paragraph" ? paragraph.content : []).toEqual([
        { type: "inlineMath", attrs: { latex: "a^2+b^2" } },
      ]);
    } finally {
      destroyEditor(inlineEditor);
    }

    const doubleEditor = createEditor(docWithParagraph("$$E=mc^2$"));
    try {
      setTextSelection(doubleEditor, findTextPosition(doubleEditor, "$$E=mc^2$", "end"));
      fireTextInput(doubleEditor, "$");
      const paragraph = normalized(doubleEditor).content[0];
      expect(paragraph?.type === "paragraph" ? paragraph.content : []).toEqual([
        { type: "inlineMath", attrs: { latex: "E=mc^2" } },
      ]);
    } finally {
      destroyEditor(doubleEditor);
    }
  });

  it("R4-014 单美元规则不吞货币和含空白的散文", () => {
    const currencyEditor = createEditor(docWithParagraph("$5 和 $1"));
    try {
      setTextSelection(currencyEditor, findTextPosition(currencyEditor, "$5 和 $1", "end"));
      fireTextInput(currencyEditor, "0");
      expect(paragraphText(normalized(currencyEditor).content[0])).toBe("$5 和 $10");
    } finally {
      destroyEditor(currencyEditor);
    }

    const proseEditor = createEditor(docWithParagraph("$ 公式 "));
    try {
      setTextSelection(proseEditor, findTextPosition(proseEditor, "$ 公式 ", "end"));
      fireTextInput(proseEditor, "$");
      expect(paragraphText(normalized(proseEditor).content[0])).toBe("$ 公式 $");
    } finally {
      destroyEditor(proseEditor);
    }
  });
});

describe("richFormatsInteraction 跨原子节点选区", () => {
  it("横跨 inlineMath 的 toggleBold 给合法行内节点加 mark, inlineMath 仍保持原子且不崩", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-bold-math" },
          content: [
            { type: "text", text: "前文 " },
            { type: "inlineMath", attrs: { latex: "x+1" } },
            { type: "text", text: " 后文" },
          ],
        },
      ],
    } satisfies PmDoc);

    try {
      setTextSelection(editor, findTextPosition(editor, "前文", "start"), findTextPosition(editor, "后文", "end"));

      expect(() => editor.commands.toggleBold()).not.toThrow();
      const paragraph = normalized(editor).content[0];
      // inlineMath 合法声明 marks 后，ProseMirror toggleMark 会覆盖选区内所有可标记
      // inline 节点；mark 只附着于整个节点，不改变它的 atom 不可拆分语义。
      expect(editor.schema.nodes.inlineMath?.spec.atom).toBe(true);
      expect(paragraph?.type === "paragraph" ? paragraph.content : []).toEqual([
        { type: "text", text: "前文 ", marks: [{ type: "bold" }] },
        { type: "inlineMath", attrs: { latex: "x+1" }, marks: [{ type: "bold" }] },
        { type: "text", text: " 后文", marks: [{ type: "bold" }] },
      ]);
    } finally {
      destroyEditor(editor);
    }
  });

  it("Delete 删除横跨 inlineMath 的选区时整体移除原子节点", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-delete-math" },
          content: [
            { type: "text", text: "删前" },
            { type: "inlineMath", attrs: { latex: "v=t^2" } },
            { type: "text", text: "删后" },
          ],
        },
      ],
    } satisfies PmDoc);

    try {
      setTextSelection(editor, findTextPosition(editor, "删前", "end"), findTextPosition(editor, "删后", "start"));

      expect(() => key(editor, "Delete")).not.toThrow();
      const paragraph = normalized(editor).content[0];
      expect(paragraphText(paragraph)).toBe("删前删后");
      expect(JSON.stringify(paragraph)).not.toContain("inlineMath");
    } finally {
      destroyEditor(editor);
    }
  });

  it("方向键从文本和 NodeSelection 穿过 inlineMath 不抛错", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-arrow-math" },
          content: [
            { type: "text", text: "A" },
            { type: "inlineMath", attrs: { latex: "\\alpha" } },
            { type: "text", text: "B" },
          ],
        },
      ],
    } satisfies PmDoc);

    try {
      const mathPos = findNodePosition(editor, "inlineMath");
      setTextSelection(editor, mathPos);
      expect(() => key(editor, "ArrowRight")).not.toThrow();
      expect(() => key(editor, "ArrowLeft")).not.toThrow();

      setSelection(editor, NodeSelection.create(editor.state.doc, mathPos));
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(() => key(editor, "ArrowRight")).not.toThrow();
      expect(() => key(editor, "ArrowLeft")).not.toThrow();
      expect(safeParsePmDoc(normalized(editor)).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 嵌套约束", () => {
  it("taskItem 内 wrapIn callout 被 schema 拒绝,命令 false 且文档不变", () => {
    const input: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "tasks-wrap" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-wrap-1", checked: false },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "task-wrap-1-p" },
                  content: [{ type: "text", text: "不能包 callout" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          attrs: { blockId: "after-task-wrap" },
          content: [{ type: "text", text: "尾段" }],
        },
      ],
    };
    const editor = createEditor(input);

    try {
      const before = cloneDoc(normalized(editor));
      setTextSelection(editor, findTextPosition(editor, "不能包", "start"), findTextPosition(editor, "callout", "end"));

      expect(editor.commands.wrapIn("callout")).toBe(false);
      expect(normalized(editor)).toEqual(before);
    } finally {
      destroyEditor(editor);
    }
  });

  it("callout 内 toggleTaskList 会转成根级 taskList,不会产生 callout 内嵌列表", () => {
    const input: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "callout",
          attrs: { blockId: "callout-task", emoji: "!", tone: "info" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "callout-task-p" },
              content: [{ type: "text", text: "不能转待办" }],
            },
          ],
        },
      ],
    };
    const editor = createEditor(input);

    try {
      setTextSelection(editor, findTextPosition(editor, "不能转", "start"), findTextPosition(editor, "待办", "end"));

      expect(editor.commands.toggleTaskList()).toBe(true);
      const doc = normalized(editor);
      expect(doc.content.map((block) => block.type)).toEqual(["taskList", "paragraph"]);
      expect(taskTexts(doc.content[0])).toEqual(["不能转待办"]);
      expect(JSON.stringify(doc)).not.toContain('"callout"');
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it("blockMath 前后 GapCursor 位置可插入段落且文档合法", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "before-gap" }, content: [{ type: "text", text: "上文" }] },
        { type: "blockMath", attrs: { blockId: "gap-math", latex: "E=mc^2" } },
        { type: "paragraph", attrs: { blockId: "after-gap" }, content: [{ type: "text", text: "下文" }] },
      ],
    } satisfies PmDoc);

    try {
      const mathPos = findNodePosition(editor, "blockMath");
      setSelection(editor, new GapCursor(editor.state.doc.resolve(mathPos)));
      expect(() =>
        editor.commands.insertContent({
          type: "paragraph",
          attrs: { blockId: "insert-before-gap" },
          content: [{ type: "text", text: "前插" }],
        }),
      ).not.toThrow();

      const remappedMathPos = findNodePosition(editor, "blockMath");
      setSelection(editor, new GapCursor(editor.state.doc.resolve(remappedMathPos + 1)));
      expect(() =>
        editor.commands.insertContent({
          type: "paragraph",
          attrs: { blockId: "insert-after-gap" },
          content: [{ type: "text", text: "后插" }],
        }),
      ).not.toThrow();

      const doc = normalized(editor);
      expect(doc.content.map((block) => block.type)).toEqual([
        "paragraph",
        "paragraph",
        "blockMath",
        "paragraph",
        "paragraph",
      ]);
      expect(doc.content.map((block) => {
        if (block.type === "paragraph") return inlineText(block.content);
        return block.type === "blockMath" ? block.attrs.latex : "";
      })).toEqual([
        "上文",
        "前插",
        "E=mc^2",
        "后插",
        "下文",
      ]);
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 复合编辑序列", () => {
  it("手工编辑表格单元格后 PM 与 Markdown 序列化保留内容", () => {
    const editor = createEditor(pmDoc([pmTable("manual-table-export", "")]));

    try {
      const paragraphPos = findNodePosition(editor, "paragraph");
      editor.view.dispatch(editor.state.tr.insertText("手工单元格", paragraphPos + 1));

      const doc = normalized(editor);
      const table = doc.content[0];
      expect(table?.type).toBe("table");
      const cell = table?.type === "table" ? table.content[0]?.content[0] : null;
      const paragraph = cell?.content[0];
      expect(paragraph?.type === "paragraph" ? inlineText(paragraph.content) : "").toBe("手工单元格");
      expect(pmToMarkdown(doc)).toContain("手工单元格");
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it("taskList 中间项 lift 出列表后分裂成两个 taskList", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "tasks-lift" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-lift-1", checked: false },
              content: [{ type: "paragraph", attrs: { blockId: "task-lift-1-p" }, content: [{ type: "text", text: "第一项" }] }],
            },
            {
              type: "taskItem",
              attrs: { blockId: "task-lift-2", checked: true },
              content: [{ type: "paragraph", attrs: { blockId: "task-lift-2-p" }, content: [{ type: "text", text: "第二项" }] }],
            },
            {
              type: "taskItem",
              attrs: { blockId: "task-lift-3", checked: false },
              content: [{ type: "paragraph", attrs: { blockId: "task-lift-3-p" }, content: [{ type: "text", text: "第三项" }] }],
            },
          ],
        },
      ],
    } satisfies PmDoc);

    try {
      setTextSelection(editor, findTextPosition(editor, "第二项", "end"));

      expect(editor.commands.liftListItem("taskItem")).toBe(true);
      const doc = normalized(editor);
      expect(doc.content.map((block) => block.type)).toEqual(["taskList", "paragraph", "taskList", "paragraph"]);
      expect(taskTexts(doc.content[0])).toEqual(["第一项"]);
      expect(paragraphText(doc.content[1])).toBe("第二项");
      expect(taskTexts(doc.content[2])).toEqual(["第三项"]);
      expect(paragraphText(doc.content[3])).toBe("");
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it("callout 节点全选删除后文档仍可 safeParsePmDoc", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "before-callout-delete" }, content: [{ type: "text", text: "前段" }] },
        {
          type: "callout",
          attrs: { blockId: "delete-callout", emoji: "!", tone: "danger" },
          content: [
            { type: "paragraph", attrs: { blockId: "delete-callout-p1" }, content: [{ type: "text", text: "风险一" }] },
            { type: "paragraph", attrs: { blockId: "delete-callout-p2" }, content: [{ type: "text", text: "风险二" }] },
          ],
        },
        { type: "paragraph", attrs: { blockId: "after-callout-delete" }, content: [{ type: "text", text: "后段" }] },
      ],
    } satisfies PmDoc);

    try {
      const calloutPos = findNodePosition(editor, "callout");
      setSelection(editor, NodeSelection.create(editor.state.doc, calloutPos));

      expect(editor.commands.deleteSelection()).toBe(true);
      const doc = normalized(editor);
      expect(doc.content.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
      expect(doc.content.map(paragraphText)).toEqual(["前段", "后段"]);
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction setContent 保真", () => {
  it("装载含全部新块的文档后 getJSON 与输入在 normalizePmDoc 后逐字节一致", () => {
    const input = richFormatsDoc();
    const editor = createEditor(docWithParagraph("占位"));

    try {
      expect(editor.commands.setContent(input as JSONContent)).toBe(true);

      const actual = JSON.stringify(normalizePmDoc(editor.getJSON()));
      const expected = JSON.stringify(normalizePmDoc(input));
      expect(actual).toBe(expected);
      expect(safeParsePmDoc(JSON.parse(actual)).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 代码块命令", () => {
  it("R2-07 使用生产 CodeBlockCM 时 setCodeBlock/toggleCodeBlock 不再空操作", () => {
    const editor = createCodeBlockEditor(docWithParagraph("const x = 1;"));

    try {
      setTextSelection(editor, findTextPosition(editor, "const"));

      expect(editor.commands.setCodeBlock()).toBe(true);
      let doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { blockId: "p-1", language: "plaintext" },
        content: [{ type: "text", text: "const x = 1;" }],
      });
      expect(safeParsePmDoc(doc).success).toBe(true);

      expect(editor.commands.setCodeBlock({ language: "javascript" })).toBe(true);
      doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { blockId: "p-1", language: "javascript" },
        content: [{ type: "text", text: "const x = 1;" }],
      });

      expect(editor.commands.toggleCodeBlock()).toBe(true);
      doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [{ type: "text", text: "const x = 1;" }],
      });
    } finally {
      destroyEditor(editor);
    }
  });

  it("代码块使用原生 ProseMirror contentDOM,不再挂载 CodeMirror 编辑器", () => {
    const editor = createCodeBlockEditor(pmDoc([{
      type: "codeBlock",
      attrs: { blockId: "code-1", language: "javascript" },
      content: [{ type: "text", text: "const x = 1;" }],
    }]));

    try {
      const code = editor.view.dom.querySelector("pre code");

      expect(code).toBeInstanceOf(HTMLElement);
      expect(code?.getAttribute("contenteditable")).not.toBe("false");
      expect(editor.view.dom.querySelector(".cm-editor")).toBeNull();
      expect(editor.view.dom.querySelector(".cm-content")).toBeNull();
      expect(editor.view.dom.querySelector(".CodeMirror")).toBeNull();
      expect(editor.view.dom.querySelector(".hljs-keyword")).toBeInstanceOf(HTMLElement);
    } finally {
      destroyEditor(editor);
    }
  });

  it('三反引号输入规则支持 "```js " 并映射 language=javascript', () => {
    const editor = createCodeBlockEditor(docWithParagraph("```js"));

    try {
      setTextSelection(editor, findTextPosition(editor, "```js", "end"));
      fireTextInput(editor, " ");

      const doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "javascript" },
      });
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it("data-language 与 code.language-* 都能解析,序列化仍输出 data-language + code class", () => {
    const editor = createCodeBlockEditor();

    try {
      expect(editor.commands.setContent('<pre data-language="js"><code>const a = 1;</code></pre>')).toBe(true);
      let doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "javascript" },
        content: [{ type: "text", text: "const a = 1;" }],
      });
      expect(editor.getHTML()).toMatch(/<pre[^>]*data-language="javascript"[^>]*><code class="language-javascript">/);

      expect(editor.commands.setContent('<pre><code class="language-ts">const b: number = 2;</code></pre>')).toBe(true);
      doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [{ type: "text", text: "const b: number = 2;" }],
      });
      expect(editor.getHTML()).toMatch(/<pre[^>]*data-language="typescript"[^>]*><code class="language-typescript">/);
    } finally {
      destroyEditor(editor);
    }
  });

  // 回归 fmt-codeblock-lang-mismatch:小众语言(yaml/groovy/hcl)不在白名单,旧 resolveLanguage
  // 会把它们压成 plaintext;现改为原样穿透,setContent 后 language attr 必须保留原值。
  it("setContent 的小众语言(yaml/groovy/hcl)不被压成 plaintext,原样保留", () => {
    const editor = createCodeBlockEditor();
    try {
      for (const lang of ["yaml", "groovy", "hcl"]) {
        expect(
          editor.commands.setContent(`<pre data-language="${lang}"><code>x: 1</code></pre>`),
        ).toBe(true);
        const doc = normalized(editor);
        expect(doc.content[0]).toMatchObject({ type: "codeBlock", attrs: { language: lang } });
      }
      // 别名仍归一(yml→yaml),不被穿透逻辑破坏
      expect(editor.commands.setContent('<pre data-language="yml"><code>x: 1</code></pre>')).toBe(true);
      expect(normalized(editor).content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "yaml" },
      });
    } finally {
      destroyEditor(editor);
    }
  });

  it("composition 事件期间仍由 ProseMirror 写入代码块文本且 selection 不越界", () => {
    const editor = createCodeBlockEditor(pmDoc([{
      type: "codeBlock",
      attrs: { blockId: "code-ime", language: "plaintext" },
    }]));

    try {
      const codePos = findNodePosition(editor, "codeBlock");
      setTextSelection(editor, codePos + 1);
      const code = editor.view.dom.querySelector("pre code");
      expect(code).toBeInstanceOf(HTMLElement);

      expect(() => {
        code?.dispatchEvent(new Event("compositionstart", { bubbles: true }));
        editor.commands.insertContent("中文");
        code?.dispatchEvent(new Event("compositionupdate", { bubbles: true }));
        code?.dispatchEvent(new Event("compositionend", { bubbles: true }));
      }).not.toThrow();

      const doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({
        type: "codeBlock",
        attrs: { blockId: "code-ime", language: "plaintext" },
        content: [{ type: "text", text: "中文" }],
      });
      const selection = editor.state.selection;
      expect(selection.from).toBeGreaterThan(codePos);
      expect(selection.to).toBeLessThanOrEqual(codePos + editor.state.doc.nodeAt(codePos)!.nodeSize);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 列表类型切换 input rule", () => {
  // 构造单条列表文档(用 JSONContent 直接喂 createEditor)
  function listDoc(listType: "bulletList" | "orderedList", text: string): JSONContent {
    return {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: listType,
          attrs: listType === "orderedList" ? { blockId: "l-1", start: 1 } : { blockId: "l-1" },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "p-1" },
                  ...(text ? { content: [{ type: "text", text }] } : {}),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  // 在当前光标处模拟"键入一个字符"以触发 input rule——走生产同一路径(view.someProp handleTextInput),
  // 这样能真实验证多个 input-rule plugin 的先后(我们的切换规则 priority 高,应先于 StarterKit 命中)。
  function fireInputRule(editor: Editor, char: string) {
    const pos = editor.state.selection.from;
    // handleTextInput 第 5 参是 deflt(默认插入回调);input rule 不会用它,传个 no-op tr 即可。
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, pos, pos, char, () => editor.state.tr),
    );
  }

  it('无序列表项里输 "1. " → 整条切成有序列表,且不产生嵌套', () => {
    const editor = createEditor(listDoc("bulletList", "1."));
    try {
      setTextSelection(editor, findTextPosition(editor, "1.", "end"));
      fireInputRule(editor, " ");
      const doc = normalized(editor);
      // 顶层首块由 bulletList 变成 orderedList → 证明是"切换"而非"嵌套"(嵌套时顶层仍是 bulletList);
      // 全文不再出现 bulletList,二次确认没有嵌套残留。
      // (列表位于文末时 toggleList 会补一个末尾空段落,与工具栏按钮行为一致,这里不作约束。)
      expect(doc.content[0]?.type).toBe("orderedList");
      expect(JSON.stringify(doc).includes('"bulletList"')).toBe(false);
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it('有序列表项里输 "- " → 整条切成无序列表', () => {
    const editor = createEditor(listDoc("orderedList", "-"));
    try {
      setTextSelection(editor, findTextPosition(editor, "-", "end"));
      fireInputRule(editor, " ");
      const doc = normalized(editor);
      expect(doc.content[0]?.type).toBe("bulletList");
      expect(JSON.stringify(doc).includes('"orderedList"')).toBe(false);
      expect(safeParsePmDoc(doc).success).toBe(true);
    } finally {
      destroyEditor(editor);
    }
  });

  it('普通段落里输 "1. " 仍由 StarterKit 起新有序列表(切换规则不在列表里时放行)', () => {
    const editor = createEditor(docWithParagraph("1."));
    try {
      setTextSelection(editor, findTextPosition(editor, "1.", "end"));
      fireInputRule(editor, " ");
      const doc = normalized(editor);
      expect(doc.content[0]?.type).toBe("orderedList");
    } finally {
      destroyEditor(editor);
    }
  });

  // 块手柄菜单「转换为」走 convertBlock → toggleBulletList/toggleOrderedList,双向都要可用
  // (E2E 在被改乱的真 doc 上对 OL→UL 命中过空块、读数存疑,这里用干净文档确定性验证双向)。
  it("有序列表 → toggleBulletList → 无序列表(菜单「无序列表」)", () => {
    const editor = createEditor(listDoc("orderedList", "甲项"));
    try {
      setTextSelection(editor, findTextPosition(editor, "甲项", "end"));
      editor.chain().focus().toggleBulletList().run();
      const doc = normalized(editor);
      expect(doc.content[0]?.type).toBe("bulletList");
      expect(JSON.stringify(doc).includes('"orderedList"')).toBe(false);
    } finally {
      destroyEditor(editor);
    }
  });

  it("无序列表 → toggleOrderedList → 有序列表(菜单「有序列表」)", () => {
    const editor = createEditor(listDoc("bulletList", "乙项"));
    try {
      setTextSelection(editor, findTextPosition(editor, "乙项", "end"));
      editor.chain().focus().toggleOrderedList().run();
      const doc = normalized(editor);
      expect(doc.content[0]?.type).toBe("orderedList");
      expect(JSON.stringify(doc).includes('"bulletList"')).toBe(false);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormatsInteraction 块手柄拖拽源定位", () => {
  // BlockHandle 拖拽用 resolve(块内位置).before(1) 取顶层块、NodeSelection 选中它。
  // 这是拖拽源最易出错的非显然一步,这里逐块验证;同时固化"列表项归属整条列表"的 v1 行为。
  it("resolve(块内位置).before(1) 的 NodeSelection 命中对应顶层块", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "p-a" }, content: [{ type: "text", text: "AAA" }] },
        { type: "heading", attrs: { blockId: "h-b", level: 2 }, content: [{ type: "text", text: "BBB" }] },
        {
          type: "bulletList",
          attrs: { blockId: "l-c" },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", attrs: { blockId: "p-c1" }, content: [{ type: "text", text: "CCC" }] },
              ],
            },
          ],
        },
      ] as JSONContent["content"],
    });
    try {
      const expectByText: Record<string, string> = {
        AAA: "paragraph",
        BBB: "heading",
        CCC: "bulletList", // 列表项内的块,拖拽源是整条列表(v1 只重排顶层块)
      };
      for (const [text, topType] of Object.entries(expectByText)) {
        const inside = findTextPosition(editor, text, "start");
        const blockPos = editor.state.doc.resolve(inside).before(1);
        const sel = NodeSelection.create(editor.state.doc, blockPos);
        expect(sel.node.type.name).toBe(topType);
        expect(sel.node.textContent).toContain(text);
      }
    } finally {
      destroyEditor(editor);
    }
  });

  it("R2-16 表格块拖拽 payload 使用原始 NodeSelection slice 且标记为 move", () => {
    const editor = createEditor(pmDoc([
      pmParagraph("p-before", "前段"),
      pmTable("table-drag", "A1"),
      pmParagraph("p-after", "后段"),
    ]));

    try {
      const tablePos = findNodePosition(editor, "table");
      const payload = createBlockDragPayload(editor.view, tablePos);

      expect(payload.selection.node.type.name).toBe("table");
      expect(payload.dragging.move).toBe(true);
      expect(payload.dragging.node.node.type.name).toBe("table");
      expect(payload.dragging.slice.content.firstChild?.type.name).toBe("table");

      editor.view.dispatch(editor.state.tr.setSelection(payload.selection));
      (editor.view as unknown as { dragging: typeof payload.dragging }).dragging = payload.dragging;
      expect((editor.view as unknown as { dragging: typeof payload.dragging }).dragging.node.node.type.name).toBe("table");
    } finally {
      destroyEditor(editor);
    }
  });
});
