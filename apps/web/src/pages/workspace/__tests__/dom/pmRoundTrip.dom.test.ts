import { Editor } from "@tiptap/core";
import {
  createDedupeBlockIdsTransaction,
  createQingagentExtensions,
} from "@qingagent/pm-schema/tiptap";
import {
  aiIrToPm,
  normalizePmDoc,
  qingmlParse,
  type PmDoc,
} from "@qingagent/pm-schema";
import { describe, expect, it } from "vitest";

describe("pmRoundTrip", () => {
  it("sets restricted PM JSON into TipTap and reads normalized JSON back", () => {
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "block-title", level: 3, anchor: "heading-anchor" },
          content: [{ type: "text", text: "三级标题" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "block-p" },
          content: [{ type: "text", text: "正文", marks: [{ type: "bold" }] }],
        },
        {
          type: "blockquote",
          attrs: { blockId: "block-quote" },
          content: [{ type: "paragraph", attrs: { blockId: "block-quote-p" }, content: [{ type: "text", text: "引用" }] }],
        },
        {
          type: "bulletList",
          attrs: { blockId: "block-list" },
          content: [
            {
              type: "listItem",
              attrs: { blockId: "block-list-item" },
              content: [{ type: "paragraph", attrs: { blockId: "block-list-item-p" }, content: [{ type: "text", text: "条目" }] }],
            },
          ],
        },
        { type: "horizontalRule", attrs: { blockId: "block-hr" } },
        {
          type: "codeBlock",
          attrs: { blockId: "block-code", language: "typescript" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "image",
          attrs: {
            blockId: "block-image",
            src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
            alt: "架构图",
	            caption: "图 1",
	            width: 320,
	            height: 180,
	            align: "right",
	          },
	        },
        {
          type: "fileAttachment",
          attrs: {
            blockId: "block-file",
            fileId: "550e8400-e29b-41d4-a716-446655440000",
            filename: "report.pdf",
            mimeType: "application/pdf",
            size: 1024,
          },
        },
      ],
    };

    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: doc,
    });

    try {
      expect(normalizePmDoc(editor.getJSON())).toEqual(doc);
    } finally {
      editor.destroy();
    }
  });

  it("保留 QingML 文学分节空段落经过 normalize、dedupe 与 setContent 往返", () => {
    const parsed = qingmlParse(
      "<p>第一节第一行<br/>第一节第二行</p><p></p><p>第二节第一行</p>",
    );
    const normalized = normalizePmDoc(aiIrToPm({ blocks: parsed.blocks }));
    expect(normalized.content).toHaveLength(3);
    expect(normalized.content[1]).toMatchObject({
      type: "paragraph",
      content: [],
    });

    const editor = new Editor({
      extensions: createQingagentExtensions(),
      content: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "placeholder" },
          content: [{ type: "text", text: "占位" }],
        }],
      } satisfies PmDoc,
    });

    try {
      expect(editor.commands.setContent(normalized)).toBe(true);
      const dedupe = createDedupeBlockIdsTransaction(editor.state);
      if (dedupe) editor.view.dispatch(dedupe);

      const roundTrip = normalizePmDoc(editor.getJSON());
      expect(roundTrip.content).toHaveLength(3);
      const emptyParagraph = roundTrip.content[1];
      expect(emptyParagraph?.type).toBe("paragraph");
      if (emptyParagraph?.type !== "paragraph") throw new Error("文学分节空段落丢失");
      expect(emptyParagraph.content ?? []).toEqual([]);

      const renderedParagraphs = editor.view.dom.querySelectorAll("p");
      expect(renderedParagraphs).toHaveLength(3);
      expect(renderedParagraphs[1]?.textContent).toBe("");
    } finally {
      editor.destroy();
    }
  });
});
