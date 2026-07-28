// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { collectMatches } from "./docFindModel";
import { collectDocFindSegments } from "./docFindPm";

describe("docFindPm", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("合并同一 textblock 内连续的不同 mark 文本并允许跨格式命中", () => {
    editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p-1" },
        content: [
          { type: "text", text: "查", marks: [{ type: "bold" }] },
          { type: "text", text: "找", marks: [{ type: "italic" }] },
          { type: "text", text: "词" },
        ],
      }],
    });

    const segments = collectDocFindSegments(editor.state.doc);
    expect(segments).toEqual([{ text: "查找词", pos: 1 }]);
    expect(collectMatches(segments, "查找词", true).matches).toEqual([
      { from: 1, to: 4 },
    ]);
  });

  it("不同 textblock 仍保持独立，禁止跨块匹配", () => {
    editor = createEditor({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p-1" },
          content: [{ type: "text", text: "跨" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "p-2" },
          content: [{ type: "text", text: "块" }],
        },
      ],
    });

    const segments = collectDocFindSegments(editor.state.doc);
    expect(segments).toHaveLength(2);
    expect(collectMatches(segments, "跨块", true).matches).toEqual([]);
  });
});

function createEditor(content: Record<string, unknown>): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createQingagentExtensions(),
    content,
  });
}
