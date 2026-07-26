import { Editor, type JSONContent } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it } from "vitest";

const PLACEHOLDER = "输入正文,或点左侧 + 插入其他块";
const editors: Editor[] = [];

function createEditor(content?: JSONContent): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createQingagentExtensions(),
    ...(content ? { content } : {}),
  });
  editors.push(editor);
  return editor;
}

function placeholderCount(editor: Editor): number {
  return Array.from(editor.view.dom.querySelectorAll("[data-placeholder]"))
    .filter((element) => element.getAttribute("data-placeholder") === PLACEHOLDER)
    .length;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.view.dom.parentElement?.remove();
    editor.destroy();
  });
});

describe("空文档正文占位", () => {
  it("全文只有一个空段落时仅显示一条", () => {
    const editor = createEditor();

    expect(placeholderCount(editor)).toBe(1);
  });

  it("连续回车形成多个空段落时一条都不显示", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph" }, { type: "paragraph" }, { type: "paragraph" }],
    });

    expect(placeholderCount(editor)).toBe(0);
  });

  it("插入 drawio 块后删除，回到单一空段落时恢复一条", () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: "diagram",
      attrs: { lang: "drawio", source: "<mxGraphModel><root /></mxGraphModel>" },
    });

    expect(placeholderCount(editor)).toBe(0);

    const diagramPos = findTopLevelNodePos(editor, "diagram");
    expect(diagramPos).not.toBeNull();
    editor.commands.deleteRange({ from: diagramPos!, to: diagramPos! + editor.state.doc.nodeAt(diagramPos!)!.nodeSize });

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(placeholderCount(editor)).toBe(1);
  });
});

function findTopLevelNodePos(editor: Editor, typeName: string): number | null {
  let found: number | null = null;
  editor.state.doc.forEach((node, offset) => {
    if (found === null && node.type.name === typeName) found = offset;
  });
  return found;
}
