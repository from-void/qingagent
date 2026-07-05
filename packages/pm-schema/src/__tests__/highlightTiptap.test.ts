// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";

describe("highlight TipTap extension", () => {
  it("renders highlight color as data-color without inline background style", () => {
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "p-highlight" },
            content: [{ type: "text", text: "高亮文本" }],
          },
        ],
      },
    });

    try {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.chain().focus().toggleHighlight({ color: "yellow" }).run();

      const html = editor.getHTML();
      expect(html).toContain('data-color="yellow"');
      expect(html).not.toContain("background-color");
    } finally {
      editor.destroy();
    }
  });

  it("parses mark[data-color] back into the highlight color attr", () => {
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: '<p><mark data-color="green">绿色</mark></p>',
    });

    try {
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            content: [
              {
                marks: [{ type: "highlight", attrs: { color: "green" } }],
              },
            ],
          },
        ],
      });
    } finally {
      editor.destroy();
    }
  });

  it("renders and parses textColor as data-text-color", () => {
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: '<p><span data-text-color="red">红字</span></p>',
    });

    try {
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            content: [
              {
                marks: [{ type: "textColor", attrs: { color: "red" } }],
              },
            ],
          },
        ],
      });
      expect(editor.getHTML()).toContain('data-text-color="red"');
    } finally {
      editor.destroy();
    }
  });

  it("renders table cell background as data-bg-color", () => {
    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "table",
            attrs: { blockId: "table-color" },
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: { backgroundColor: "rose" },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { blockId: "cell-p" },
                        content: [{ type: "text", text: "底色" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    try {
      expect(editor.getHTML()).toContain('data-bg-color="rose"');
    } finally {
      editor.destroy();
    }
  });
});
