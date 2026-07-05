// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, safeParsePmDoc, type PmBlockNode, type PmDoc, type PmInlineNode } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";

function createEditor(content: PmDoc | JSONContent = docWithParagraph("")) {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createQingagentExtensions(),
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

function normalized(editor: Editor): PmDoc {
  return normalizePmDoc(editor.getJSON());
}

function typeText(editor: Editor, text: string) {
  for (const char of [...text]) {
    const { from, to } = editor.state.selection;
    let handled = false;

    editor.view.someProp("handleTextInput", (handler) => {
      handled =
        handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)) === true;
      return handled;
    });

    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
}

function key(editor: Editor, name: string) {
  editor.commands.keyboardShortcut(name);
}

function closeHistoryEvent(editor: Editor) {
  editor.view.dispatch(closeHistory(editor.state.tr));
}

function setFirstTextblockStart(editor: Editor) {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  editor.commands.setTextSelection(found!);
}

function setSelectionAtText(editor: Editor, text: string, edge: "start" | "end" = "end") {
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
  editor.commands.setTextSelection(found!);
}

function taskListOf(doc: PmDoc) {
  const block = doc.content[0];
  if (block?.type !== "taskList") throw new Error(`expected taskList, got ${block?.type ?? "missing"}`);
  return block;
}

function paragraphOf(block: PmBlockNode) {
  if (block.type !== "paragraph") throw new Error(`expected paragraph, got ${block.type}`);
  return block;
}

function inlineText(content: readonly PmInlineNode[] | undefined) {
  return (content ?? []).map((node) => (node.type === "text" ? node.text : "")).join("");
}

function hasNodeType(editor: Editor, type: string) {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === type) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function richFormatsDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "taskList",
        attrs: { blockId: "tasks" },
        content: [
          {
            type: "taskItem",
            attrs: { blockId: "task-1", checked: false },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "task-1-p" },
                content: [{ type: "text", text: "确认边界" }],
              },
            ],
          },
        ],
      },
      {
        type: "callout",
        attrs: { blockId: "callout-1", emoji: "💡", tone: "warning" },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "callout-1-p1" },
            content: [
              { type: "text", text: "中文公式 " },
              { type: "inlineMath", attrs: { latex: "a^2+b^2=c^2" } },
            ],
          },
          {
            type: "paragraph",
            attrs: { blockId: "callout-1-p2" },
            content: [{ type: "text", text: "第二段" }],
          },
        ],
      },
      { type: "blockMath", attrs: { blockId: "math-1", latex: "\\int_0^1 x^2\\,dx=\\frac{1}{3}" } },
    ],
  };
}

describe("richFormats 输入规则边界", () => {
  it("'[] '/'[x] ' 只在可承载待办的根段落触发,列表/标题内保持文字", () => {
    const unchecked = createEditor();
    try {
      typeText(unchecked, "[] 未完成");
      const list = taskListOf(normalized(unchecked));
      expect(list.content[0]?.attrs.checked).toBe(false);
      expect(inlineText(paragraphOf(list.content[0]!.content[0]!).content)).toBe("未完成");
    } finally {
      destroyEditor(unchecked);
    }

    const checked = createEditor();
    try {
      typeText(checked, "[x] 已完成");
      const list = taskListOf(normalized(checked));
      expect(list.content[0]?.attrs.checked).toBe(true);
      expect(inlineText(paragraphOf(list.content[0]!.content[0]!).content)).toBe("已完成");
    } finally {
      destroyEditor(checked);
    }

    const inList = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "bulletList",
          attrs: { blockId: "list-1" },
          content: [
            {
              type: "listItem",
              attrs: { blockId: "li-1" },
              content: [{ type: "paragraph", attrs: { blockId: "li-1-p" } }],
            },
          ],
        },
      ],
    } satisfies PmDoc);
    try {
      setFirstTextblockStart(inList);
      typeText(inList, "[] ");
      const block = normalized(inList).content[0];
      expect(block?.type).toBe("bulletList");
      const firstChild = block?.type === "bulletList" ? block.content[0]?.content[0] : undefined;
      expect(firstChild?.type === "paragraph" ? inlineText(firstChild.content) : "").toBe("[] ");
    } finally {
      destroyEditor(inList);
    }

    const heading = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "heading", attrs: { blockId: "h-1", level: 3 } }],
    } satisfies PmDoc);
    try {
      setFirstTextblockStart(heading);
      typeText(heading, "[x] 标题");
      const block = normalized(heading).content[0];
      expect(block?.type).toBe("heading");
      expect(block?.type === "heading" ? inlineText(block.content) : "").toBe("[x] 标题");
    } finally {
      destroyEditor(heading);
    }
  });

  it("美元金额不误转公式,中文上下文 $$a^2$$ 转 inlineMath", () => {
    const money = createEditor();
    try {
      typeText(money, "$$50 and $$60");
      const block = paragraphOf(normalized(money).content[0]!);
      expect(block.content).toEqual([{ type: "text", text: "$$50 and $$60" }]);
    } finally {
      destroyEditor(money);
    }

    const chinese = createEditor();
    try {
      typeText(chinese, "中文 $$a^2$$ 转换");
      const block = paragraphOf(normalized(chinese).content[0]!);
      expect(block.content).toEqual([
        { type: "text", text: "中文 " },
        { type: "inlineMath", attrs: { latex: "a^2" } },
        { type: "text", text: " 转换" },
      ]);
    } finally {
      destroyEditor(chinese);
    }
  });

  it("'$$$..$$$' 块级公式转换时吞掉宿主段落", () => {
    const editor = createEditor();
    try {
      typeText(editor, "$$$E = mc^2$$$");
      const doc = normalized(editor);
      expect(doc.content[0]).toMatchObject({ type: "blockMath", attrs: { latex: "E = mc^2" } });
      expect(
        doc.content.some((block) => block.type === "paragraph" && inlineText(block.content).includes("$$$")),
      ).toBe(false);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormats 结构操作", () => {
  it("taskList 中 Enter 延续待办项,空项 Backspace 退出列表", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-1", checked: true },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "task-1-p" },
                  content: [{ type: "text", text: "第一项" }],
                },
              ],
            },
          ],
        },
      ],
    } satisfies PmDoc);
    try {
      setSelectionAtText(editor, "第一项");
      key(editor, "Enter");

      let list = taskListOf(normalized(editor));
      expect(list.content).toHaveLength(2);
      expect(list.content[0]?.attrs.checked).toBe(true);
      expect(list.content[1]?.attrs.checked).toBe(false);

      key(editor, "Backspace");
      const afterBackspace = normalized(editor);
      expect(afterBackspace.content.map((block) => block.type)).toEqual(["taskList", "paragraph"]);
      list = taskListOf(afterBackspace);
      expect(list.content).toHaveLength(1);
      expect(inlineText(paragraphOf(afterBackspace.content[1]!).content)).toBe("");
    } finally {
      destroyEditor(editor);
    }
  });

  it("callout wrapIn 后可 lift 还原,内部 Enter 保留多段 paragraph", () => {
    const liftEditor = createEditor(docWithParagraph("提示"));
    try {
      setSelectionAtText(liftEditor, "提示");
      liftEditor.chain().focus().wrapIn("callout").run();
      expect(normalized(liftEditor).content[0]).toMatchObject({
        type: "callout",
        attrs: { emoji: "💡", tone: "info" },
      });

      setSelectionAtText(liftEditor, "提示");
      liftEditor.chain().focus().lift("callout").run();
      const block = normalized(liftEditor).content[0];
      expect(block?.type).toBe("paragraph");
      expect(block?.type === "paragraph" ? inlineText(block.content) : "").toBe("提示");
    } finally {
      destroyEditor(liftEditor);
    }

    const multiParagraph = createEditor(docWithParagraph("第一段"));
    try {
      setSelectionAtText(multiParagraph, "第一段");
      multiParagraph.chain().focus().wrapIn("callout").run();
      setSelectionAtText(multiParagraph, "第一段");
      key(multiParagraph, "Enter");
      typeText(multiParagraph, "第二段");

      const block = normalized(multiParagraph).content[0];
      expect(block?.type).toBe("callout");
      expect(block?.type === "callout" ? block.content.map((paragraph) => inlineText(paragraph.content)) : []).toEqual([
        "第一段",
        "第二段",
      ]);
    } finally {
      destroyEditor(multiParagraph);
    }
  });

  it("undo/redo 能穿过 taskList、callout 和 inlineMath 节点", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "p-task" }, content: [{ type: "text", text: "任务" }] },
        { type: "paragraph", attrs: { blockId: "p-callout" }, content: [{ type: "text", text: "提示" }] },
        { type: "paragraph", attrs: { blockId: "p-math" }, content: [{ type: "text", text: "公式 " }] },
      ],
    } satisfies PmDoc);
    try {
      setSelectionAtText(editor, "任务");
      editor.chain().focus().toggleTaskList().run();
      closeHistoryEvent(editor);

      setSelectionAtText(editor, "提示");
      editor.chain().focus().wrapIn("callout").run();
      closeHistoryEvent(editor);

      setSelectionAtText(editor, "公式 ");
      editor.chain().focus().insertContent({ type: "inlineMath", attrs: { latex: "x^2" } }).run();
      closeHistoryEvent(editor);

      const richDoc = normalized(editor);
      expect(hasNodeType(editor, "taskList")).toBe(true);
      expect(hasNodeType(editor, "callout")).toBe(true);
      expect(hasNodeType(editor, "inlineMath")).toBe(true);

      expect(editor.commands.undo()).toBe(true);
      expect(hasNodeType(editor, "inlineMath")).toBe(false);
      expect(hasNodeType(editor, "callout")).toBe(true);
      expect(hasNodeType(editor, "taskList")).toBe(true);

      expect(editor.commands.undo()).toBe(true);
      expect(hasNodeType(editor, "callout")).toBe(false);
      expect(hasNodeType(editor, "taskList")).toBe(true);

      expect(editor.commands.undo()).toBe(true);
      expect(hasNodeType(editor, "taskList")).toBe(false);

      expect(editor.commands.redo()).toBe(true);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.commands.redo()).toBe(true);
      expect(normalized(editor)).toEqual(richDoc);
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormats 序列化往返", () => {
  it("getJSON 经 normalizePmDoc + safeParsePmDoc 后可 setContent 重装载", () => {
    const editor = createEditor(richFormatsDoc());
    try {
      const doc = normalized(editor);
      const parsed = safeParsePmDoc(doc);
      expect(parsed.success).toBe(true);

      const reloaded = createEditor(docWithParagraph("占位"));
      try {
        expect(() => reloaded.commands.setContent(doc as JSONContent)).not.toThrow();
        const reloadedDoc = normalized(reloaded);
        expect(safeParsePmDoc(reloadedDoc).success).toBe(true);
        expect(reloadedDoc.content.slice(0, doc.content.length)).toEqual(doc.content);
      } finally {
        destroyEditor(reloaded);
      }
    } finally {
      destroyEditor(editor);
    }
  });

  it("含 inlineMath 的段落复制 HTML 后再 parse 回来保真", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-inline-math" },
          content: [
            { type: "text", text: "中文 " },
            { type: "inlineMath", attrs: { latex: "a^2" } },
            { type: "text", text: " 结尾" },
          ],
        },
      ],
    } satisfies PmDoc);
    try {
      const html = editor.getHTML();
      expect(html).toContain('data-type="inline-math"');
      expect(html).toContain('data-latex="a^2"');

      const parsed = createEditor();
      try {
        expect(() => parsed.commands.setContent(html)).not.toThrow();
        const block = paragraphOf(normalized(parsed).content[0]!);
        expect(block.content).toEqual([
          { type: "text", text: "中文 " },
          { type: "inlineMath", attrs: { latex: "a^2" } },
          { type: "text", text: " 结尾" },
        ]);
      } finally {
        destroyEditor(parsed);
      }
    } finally {
      destroyEditor(editor);
    }
  });
});

describe("richFormats checkbox DOM 交互", () => {
  it("点击 checkbox 会切换 taskItem.checked 并反映到 getJSON", () => {
    const editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "taskList",
          attrs: { blockId: "tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "task-1", checked: false },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "task-1-p" },
                  content: [{ type: "text", text: "切换我" }],
                },
              ],
            },
          ],
        },
      ],
    } satisfies PmDoc);
    try {
      const checkbox = editor.view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const item = checkbox?.closest("li") as HTMLElement | null;
      expect(checkbox).not.toBeNull();
      expect(item).not.toBeNull();
      expect(checkbox!.checked).toBe(false);

      checkbox!.click();
      expect(taskListOf(normalized(editor)).content[0]?.attrs.checked).toBe(true);
      expect(checkbox!.checked).toBe(true);
      expect(item!.dataset.checked).toBe("true");

      checkbox!.click();
      expect(taskListOf(normalized(editor)).content[0]?.attrs.checked).toBe(false);
      expect(checkbox!.checked).toBe(false);
      expect(item!.dataset.checked).toBe("false");
    } finally {
      destroyEditor(editor);
    }
  });
});
