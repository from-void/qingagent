import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, type PmDoc, type PmMark } from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";
import {
  resolveAiModifyLiveSelection,
  resolveAiModifyTarget,
  resolveItemBlockIdAtPos,
  type SavedAiSelection,
} from "../../components/DocToolbar";
import { sanitizeToolbarLinkHref } from "../../data/toolbarUnlock";

function editorWithText(text = "目标文本") {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-1" },
          content: [{ type: "text", text }],
        },
      ],
    } satisfies PmDoc,
  });
}

function editorWithParagraphs(texts: string[]) {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: texts.map((text, index) => ({
        type: "paragraph",
        attrs: { blockId: `p-${index + 1}` },
        content: text ? [{ type: "text", text }] : [],
      })),
    } satisfies PmDoc,
  });
}

function editorWithList(items: string[]) {
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "bulletList",
          attrs: { blockId: "list-1" },
          content: items.map((text, index) => ({
            type: "listItem",
            attrs: { blockId: `item-${index + 1}` },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: `item-${index + 1}-p` },
                content: [{ type: "text", text }],
              },
            ],
          })),
        },
      ],
    } satisfies PmDoc,
  });
}

function editorWithSeparatedLists() {
  const list = (id: string, itemId: string, text: string) => ({
    type: "bulletList" as const,
    attrs: { blockId: id },
    content: [{
      type: "listItem" as const,
      attrs: { blockId: itemId },
      content: [{
        type: "paragraph" as const,
        attrs: { blockId: `${itemId}-p` },
        content: [{ type: "text" as const, text }],
      }],
    }],
  });
  return new Editor({
    extensions: createQingagentExtensions(),
    content: {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        list("list-1", "item-1", "第一行"),
        {
          type: "paragraph",
          attrs: { blockId: "between" },
          content: [{ type: "text", text: "中间段落" }],
        },
        list("list-2", "item-2", "第二行"),
      ],
    } satisfies PmDoc,
  });
}

function selectedEditor(text = "目标文本") {
  const editor = editorWithText(text);
  editor.commands.setTextSelection({ from: 1, to: text.length + 1 });
  return editor;
}

function textBlockRanges(editor: Editor): Array<{ from: number; to: number; text: string }> {
  const ranges: Array<{ from: number; to: number; text: string }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      ranges.push({
        from: pos + 1,
        to: pos + 1 + node.textContent.length,
        text: node.textContent,
      });
    }
    return true;
  });
  return ranges;
}

function firstTextMarks(editor: Editor): readonly PmMark[] {
  const doc = normalizePmDoc(editor.getJSON());
  const block = doc.content[0];
  if (block?.type !== "paragraph" && block?.type !== "heading") return [];
  const node = block.content?.find((child) => child.type === "text");
  return node?.type === "text" ? node.marks ?? [] : [];
}

describe("toolbarRichtext PM-010", () => {
  it("主 toolbar marks 点击效果能进入 PM JSON 并保留 inline-code DOM class", () => {
    const cases: Array<{ name: string; run: (editor: Editor) => void; mark: PmMark["type"] }> = [
      { name: "bold", run: (editor) => editor.chain().focus().toggleBold().run(), mark: "bold" },
      { name: "italic", run: (editor) => editor.chain().focus().toggleItalic().run(), mark: "italic" },
      { name: "underline", run: (editor) => editor.chain().focus().toggleUnderline().run(), mark: "underline" },
      { name: "strike", run: (editor) => editor.chain().focus().toggleStrike().run(), mark: "strike" },
      { name: "code", run: (editor) => editor.chain().focus().toggleCode().run(), mark: "code" },
    ];

    for (const item of cases) {
      const editor = selectedEditor();
      try {
        item.run(editor);
        expect(firstTextMarks(editor), item.name).toContainEqual({ type: item.mark });
        if (item.mark === "code") {
          expect(editor.getHTML()).toContain('class="inline-code"');
        }
      } finally {
        editor.destroy();
      }
    }
  });

  it("link/highlight/align/H3-H6 经 TipTap 写入 PM 白名单结构", () => {
    const linkEditor = selectedEditor();
    try {
      const href = sanitizeToolbarLinkHref("https://example.com/doc")!;
      linkEditor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      expect(firstTextMarks(linkEditor)).toContainEqual({ type: "link", attrs: { href } });
    } finally {
      linkEditor.destroy();
    }

    const highlightEditor = selectedEditor();
    try {
      highlightEditor.chain().focus().toggleHighlight({ color: "yellow" }).run();
      expect(firstTextMarks(highlightEditor)).toContainEqual({ type: "highlight", attrs: { color: "yellow" } });
    } finally {
      highlightEditor.destroy();
    }

    for (const align of ["left", "center", "right", "justify"] as const) {
      const editor = selectedEditor();
      try {
        editor.chain().focus().setTextAlign(align).run();
        const doc = normalizePmDoc(editor.getJSON());
        expect(doc.content[0]?.type).toBe("paragraph");
        expect(doc.content[0]?.attrs.textAlign ?? "left").toBe(align);
      } finally {
        editor.destroy();
      }
    }

    for (const level of [3, 4, 5, 6] as const) {
      const editor = selectedEditor();
      try {
        editor.chain().focus().toggleHeading({ level }).run();
        const doc = normalizePmDoc(editor.getJSON());
        expect(doc.content[0]).toMatchObject({ type: "heading", attrs: { level } });
      } finally {
        editor.destroy();
      }
    }
  });

  it("highlight 序列化只输出 data-color,不输出 inline 纯黄背景", () => {
    const editor = selectedEditor();
    try {
      editor.chain().focus().toggleHighlight({ color: "yellow" }).run();
      const html = editor.getHTML();

      expect(html).toContain('data-color="yellow"');
      expect(html).not.toContain("background-color");
      expect(html).not.toContain("yellow;");
    } finally {
      editor.destroy();
    }
  });

  it("从 HTML 解析 mark[data-color] 时保留 highlight color", () => {
    const editor = editorWithText("占位");
    try {
      editor.commands.setContent('<p><mark data-color="green">绿色高亮</mark></p>');
      expect(firstTextMarks(editor)).toContainEqual({
        type: "highlight",
        attrs: { color: "green" },
      });
    } finally {
      editor.destroy();
    }
  });

  it("list/blockquote 命令经 TipTap 写入 PM 块级结构", () => {
    const cases: Array<{ name: string; run: (editor: Editor) => void; type: string }> = [
      { name: "bulletList", run: (editor) => editor.chain().focus().toggleBulletList().run(), type: "bulletList" },
      { name: "orderedList", run: (editor) => editor.chain().focus().toggleOrderedList().run(), type: "orderedList" },
      { name: "blockquote", run: (editor) => editor.chain().focus().toggleBlockquote().run(), type: "blockquote" },
    ];

    for (const item of cases) {
      const editor = selectedEditor();
      try {
        item.run(editor);
        const doc = normalizePmDoc(editor.getJSON());
        expect(doc.content[0]?.type, item.name).toBe(item.type);
      } finally {
        editor.destroy();
      }
    }
  });
});

describe("DocToolbar AI 修改选区", () => {
  it("当前空白选区不会 fallback 到旧选区", () => {
    const editor = editorWithText("旧段   新段");
    try {
      const [range] = textBlockRanges(editor);
      if (!range) throw new Error("fixture missing range");
      const spaceStart = range.text.indexOf("   ");
      editor.commands.setTextSelection({
        from: range.from + spaceStart,
        to: range.from + spaceStart + 3,
      });
      const savedSelection: SavedAiSelection = {
        text: "旧段",
        location: "正文",
        from: range.from,
        to: range.from + 2,
      };

      expect(resolveAiModifyTarget(editor, savedSelection)).toEqual({
        kind: "emptySelection",
      });
    } finally {
      editor.destroy();
    }
  });

  it("跨段选区禁止作为 AI 修改定位", () => {
    const editor = editorWithParagraphs(["第一段", "第二段"]);
    try {
      const [first, second] = textBlockRanges(editor);
      if (!first || !second) throw new Error("fixture missing ranges");
      editor.commands.setTextSelection({ from: first.from, to: second.to });

      expect(resolveAiModifyLiveSelection(editor)).toEqual({
        kind: "crossBlockSelection",
      });
    } finally {
      editor.destroy();
    }
  });

  it("列表单行选区用 item blockId,不是顶层 list blockId", () => {
    const editor = editorWithList(["第一行", "第二行"]);
    try {
      const [, second] = textBlockRanges(editor);
      if (!second) throw new Error("fixture missing list item range");
      editor.commands.setTextSelection({ from: second.from, to: second.to });

      const target = resolveAiModifyLiveSelection(editor);

      expect(resolveItemBlockIdAtPos(editor, second.from)).toBe("item-2");
      expect(target).toMatchObject({
        kind: "ready",
        selectionRefs: ["item-2"],
      });
    } finally {
      editor.destroy();
    }
  });

  it("列表多行选区携带有序 item refs,普通跨段落规则不误拦", () => {
    const editor = editorWithList(["第一行", "第二行", "第三行"]);
    try {
      const [first, second] = textBlockRanges(editor);
      if (!first || !second) throw new Error("fixture missing list item ranges");
      editor.commands.setTextSelection({ from: first.from, to: second.to });

      expect(resolveAiModifyLiveSelection(editor)).toMatchObject({
        kind: "ready",
        selectionRefs: ["item-1", "item-2"],
      });
    } finally {
      editor.destroy();
    }
  });

  it("跨两个列表且夹普通段落的选区沿用跨段落拒绝,不提交残缺 item refs", () => {
    const editor = editorWithSeparatedLists();
    try {
      const [first, , second] = textBlockRanges(editor);
      if (!first || !second) throw new Error("fixture missing separated list ranges");
      editor.commands.setTextSelection({ from: first.from, to: second.to });

      expect(resolveAiModifyLiveSelection(editor)).toEqual({
        kind: "crossBlockSelection",
      });
    } finally {
      editor.destroy();
    }
  });
});
