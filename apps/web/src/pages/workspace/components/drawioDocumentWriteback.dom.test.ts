// @vitest-environment jsdom

import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDrawioBlockId,
  writeDrawioResultByBlockId,
} from "./drawioDocumentWriteback";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("drawio 创建即插入后的定向写回", () => {
  it("按固定 blockId 实时更新 source+svg，不受当前选区影响", () => {
    const blockId = createDrawioBlockId();
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "diagram",
            attrs: {
              blockId,
              lang: "drawio",
              source: DEFAULT_DRAWIO_SOURCE,
              svg: null,
            },
          },
          { type: "paragraph", content: [{ type: "text", text: "光标已在别处" }] },
        ],
      },
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const source = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', 'value="实时写回"');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>实时写回</text></svg>';

    expect(writeDrawioResultByBlockId(editor, blockId, { source, svg })).toBe(true);

    const diagram = editor.state.doc.firstChild;
    expect(diagram?.attrs).toMatchObject({ blockId, source, svg });
  });
});
