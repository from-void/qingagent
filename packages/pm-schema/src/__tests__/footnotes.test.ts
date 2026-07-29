// @vitest-environment jsdom

import { Editor, getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import {
  aiBlockSchema,
  aiBlocksToQingml,
  aiIrToPm,
  pmToAiIr,
  qingmlParse,
} from "../index";
import { createQingagentExtensions } from "../tiptap/createQingagentExtensions";
import { safeParsePmDoc } from "../validators";

describe("脚注 QingML → AI-IR → PM", () => {
  it("解析纯文本脚注并在 PM 中生成稳定行内原子", () => {
    const parsed = qingmlParse(
      `<p block-id="source">甲<footnote id="source_a">出处 &amp; 页码 [12]</footnote>乙` +
      `<footnote>无显式编号</footnote></p>`,
    );
    expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      runs: [
        { text: "甲" },
        { type: "footnote", id: "source_a", note: "出处 & 页码 [12]" },
        { text: "乙" },
        { type: "footnote", note: "无显式编号" },
      ],
    });
    expect(parsed.blocks.every((block) => aiBlockSchema.safeParse(block).success)).toBe(true);

    const first = aiIrToPm({ blocks: parsed.blocks });
    const second = aiIrToPm({ blocks: parsed.blocks });
    expect(first).toEqual(second);
    const paragraph = first.content[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("缺少段落");
    const references = paragraph.content?.filter((node) => node.type === "footnoteReference") ?? [];
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({
      type: "footnoteReference",
      attrs: { id: "source_a", note: "出处 & 页码 [12]" },
    });
    expect(references[1]?.type === "footnoteReference" ? references[1].attrs.id : "").toMatch(
      /^[A-Za-z0-9_-]{1,64}$/,
    );
    expect(safeParsePmDoc(first).success).toBe(true);
  });

  it("PM 与 QingML 往返保留稳定 id、纯文本 note 和重复引用", () => {
    const doc = aiIrToPm({
      blocks: [{
        type: "paragraph",
        blockId: "p1",
        runs: [
          { text: "一" },
          { type: "footnote", id: "same_note", note: `引文 <甲> & "乙"` },
          { text: "二" },
          { type: "footnote", id: "same_note", note: `引文 <甲> & "乙"` },
        ],
      }],
    });
    const ai = pmToAiIr(doc);
    expect(ai.blocks[0]).toMatchObject({
      type: "paragraph",
      runs: [
        { text: "一" },
        { type: "footnote", id: "same_note", note: `引文 <甲> & "乙"` },
        { text: "二" },
        { type: "footnote", id: "same_note", note: `引文 <甲> & "乙"` },
      ],
    });
    const qingml = aiBlocksToQingml(ai.blocks);
    expect(qingml).toContain(
      `<footnote id="same_note">引文 &lt;甲> &amp; "乙"</footnote>`,
    );
    const reparsed = qingmlParse(qingml);
    expect(reparsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    const roundTripped = aiIrToPm({ blocks: reparsed.blocks });
    expect(roundTripped.content[0]?.type === "paragraph"
      ? roundTripped.content[0].content
      : []).toEqual(doc.content[0]?.type === "paragraph" ? doc.content[0].content : []);
  });

  it("脚注位于段首或段尾时不吞掉引用内侧的正文空格", () => {
    expect(qingmlParse(
      `<p><footnote id="a">甲</footnote> 后文</p>` +
      `<p>前文 <footnote id="b">乙</footnote></p>`,
    ).blocks).toMatchObject([
      {
        type: "paragraph",
        runs: [
          { type: "footnote", id: "a", note: "甲" },
          { text: " 后文" },
        ],
      },
      {
        type: "paragraph",
        runs: [
          { text: "前文 " },
          { type: "footnote", id: "b", note: "乙" },
        ],
      },
    ]);
  });

  it.each([
    {
      name: "缺闭合标签",
      source: "<p>正文<footnote id=\"a\">未闭合</p>",
      warning: "truncated-footnote",
    },
    {
      name: "嵌套标签",
      source: "<p>正文<footnote id=\"a\">来源 <b>一</b></footnote></p>",
      warning: "nested-footnote-content",
    },
    {
      name: "同 id 不同正文",
      source: "<p><footnote id=\"a\">一</footnote><footnote id=\"a\">二</footnote></p>",
      warning: "conflicting-footnote-id",
    },
  ])("$name 会 fail-closed 告警", ({ source, warning }) => {
    const result = qingmlParse(source);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: warning,
      severity: "bad-block",
    }));
  });

  it("非法 id、空 note、过长 note 由真实 AI-IR schema 拒绝", () => {
    const cases = [
      qingmlParse(`<p><footnote id="bad id">正文</footnote></p>`).blocks[0],
      qingmlParse(`<p><footnote id="empty"></footnote></p>`).blocks[0],
      qingmlParse(`<p><footnote id="long">${"字".repeat(4097)}</footnote></p>`).blocks[0],
    ];
    cases.forEach((block) => expect(aiBlockSchema.safeParse(block).success).toBe(false));
  });

  it("PM validator 拒绝同 id 不同 note", () => {
    expect(safeParsePmDoc({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p" },
        content: [
          { type: "footnoteReference", attrs: { id: "same", note: "一" } },
          { type: "footnoteReference", attrs: { id: "same", note: "二" } },
        ],
      }],
    }).success).toBe(false);
  });
});

describe("脚注 TipTap 真 schema 与真实编辑器 DOM", () => {
  it("作为 atom/selectable 往返，并按首见顺序装饰重复引用", () => {
    const extensions = createQingagentExtensions();
    const schema = getSchema(extensions);
    expect(schema.nodes.footnoteReference?.isInline).toBe(true);
    expect(schema.nodes.footnoteReference?.isAtom).toBe(true);
    expect(schema.nodes.footnoteReference?.spec.selectable).toBe(true);

    const input = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "p" },
        content: [
          { type: "text", text: "甲" },
          { type: "footnoteReference", attrs: { id: "a", note: "来源甲" } },
          { type: "text", text: "乙" },
          { type: "footnoteReference", attrs: { id: "a", note: "来源甲" } },
          { type: "footnoteReference", attrs: { id: "b", note: "来源乙" } },
        ],
      }],
    };
    expect(PMNode.fromJSON(schema, input).toJSON()).toMatchObject({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { blockId: "p" },
        content: input.content[0]!.content,
      }],
    });

    const host = document.createElement("div");
    document.body.append(host);
    const editor = new Editor({ element: host, extensions, content: input });
    try {
      const markers = [...host.querySelectorAll<HTMLElement>(
        "sup[data-pm-node='footnoteReference']",
      )];
      expect(markers).toHaveLength(3);
      expect(markers.map((marker) => marker.dataset.footnoteNumber)).toEqual(["1", "1", "2"]);
      expect(markers[0]?.getAttribute("tabindex")).toBe("0");
      expect(markers[0]?.getAttribute("aria-label")).toBe("脚注 1：来源甲");
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
