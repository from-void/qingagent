import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { migratePmDoc } from "../migrations";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";
import {
  normalizeStoredPmDoc,
  safeParsePmDoc,
} from "../validators";

const markedCodeDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [{
    type: "blockquote",
    attrs: { blockId: "quote" },
    content: [{
      type: "codeBlock",
      attrs: { blockId: "code", language: "typescript" },
      content: [{
        type: "text",
        text: "const answer = 42;",
        marks: [
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.com/source" } },
        ],
      }],
    }],
  }],
} as const;

describe("codeBlock marks", () => {
  it("canonical validator 拒绝 runtime schema 无法编辑的 codeBlock marks", () => {
    expect(safeParsePmDoc(markedCodeDoc).success).toBe(false);

    const schema = getSchema(createQingagentExtensions());
    expect(() => ProseMirrorNode.fromJSON(schema, markedCodeDoc).check()).toThrow(
      /Invalid content for node codeBlock/,
    );
  });

  it("存量读取与迁移仅剥离历史 marks，完整保留代码文本和结构", () => {
    const expected = {
      ...markedCodeDoc,
      content: [{
        ...markedCodeDoc.content[0],
        content: [{
          ...markedCodeDoc.content[0].content[0],
          content: [{ type: "text", text: "const answer = 42;" }],
        }],
      }],
    };

    expect(normalizeStoredPmDoc(markedCodeDoc)).toEqual(expected);
    expect(migratePmDoc(markedCodeDoc, 1, 1)).toEqual(expected);

    const schema = getSchema(createQingagentExtensions());
    expect(() => ProseMirrorNode.fromJSON(schema, expected).check()).not.toThrow();
  });
});
