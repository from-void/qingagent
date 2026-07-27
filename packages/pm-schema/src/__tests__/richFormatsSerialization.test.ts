import { describe, expect, it } from "vitest";
import { PM_CALLOUT_TONES, PM_ORDERED_LIST_STYLES, type PmCalloutTone, type PmDoc } from "../index";
import { pmToMarkdown } from "../markdown/pmToMarkdown";
import { pmToLegacySections } from "../legacy/pmToLegacySections";
import { pmToPlainText } from "../pmToPlainText";
import { normalizePmDoc, safeParsePmDoc } from "../validators";

const INLINE_LATEX = String.raw`E=mc^2`;
const BLOCK_LATEX = String.raw`\int_0^1 x^2 dx = \frac{1}{3}`;

const CALLOUT_EMOJI: Record<PmCalloutTone, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  danger: "🚨",
  neutral: "💬",
  ochre: "📌",
  rose: "🌸",
  mauve: "💜",
  indigo: "🌙",
  teal: "🌊",
};

const richPmDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "heading",
      attrs: { blockId: "heading-rich", level: 2, textAlign: "center" },
      content: [{ type: "text", text: "富格式序列化验收" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "paragraph-inline-math" },
      content: [
        { type: "text", text: "行内公式 " },
        { type: "inlineMath", attrs: { latex: INLINE_LATEX } },
        { type: "text", text: String.raw` 与普通文本混排，含管道 A | B 和路径 C:\drafts\alpha。` },
      ],
    },
    {
      type: "taskList",
      attrs: { blockId: "task-list-rich" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "task-done", checked: true },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "task-done-p" },
              content: [{ type: "text", text: "已完成：发布导出方案" }],
            },
          ],
        },
        {
          type: "taskItem",
          attrs: { blockId: "task-open", checked: false },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "task-open-p" },
              content: [
                { type: "text", text: String.raw`待处理：校验 A | B、反斜杠 C:\drafts\alpha` },
                { type: "hardBreak" },
                { type: "text", text: "换行后的任务说明" },
              ],
            },
          ],
        },
      ],
    },
    ...PM_CALLOUT_TONES.map((tone, index) => ({
      type: "callout" as const,
      attrs: { blockId: `callout-${tone}`, tone, emoji: CALLOUT_EMOJI[tone] },
      content: [
        {
          type: "paragraph" as const,
          attrs: { blockId: `callout-${tone}-p1` },
          content: [
            { type: "text" as const, text: String.raw`${tone} 提示：第一行含管道 | 和反斜杠 C:\callout\path` },
            { type: "hardBreak" as const },
            { type: "text" as const, text: "第二行必须继续带引用前缀" },
          ],
        },
        {
          type: "paragraph" as const,
          attrs: { blockId: `callout-${tone}-p2` },
          content: [{ type: "text" as const, text: `补充段落 ${index + 1}` }],
        },
      ],
    })),
    {
      type: "blockMath",
      attrs: { blockId: "block-math-rich", latex: BLOCK_LATEX },
    },
  ],
};

describe("rich format serialization", () => {
  it("根文档 content 缺失或非数组时拒绝归一化为空文档", () => {
    const invalidDocs = [
      { type: "doc", attrs: { schemaVersion: 1 } },
      { type: "doc", attrs: { schemaVersion: 1 }, content: { type: "paragraph" } },
      { type: "doc", attrs: { schemaVersion: 1 }, content: "正文" },
    ];

    for (const value of invalidDocs) {
      const parsed = safeParsePmDoc(value);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual(["content"]);
      }
      expect(() => normalizePmDoc(value)).toThrow("Invalid PM doc");
    }

    expect(safeParsePmDoc({ type: "doc", attrs: { schemaVersion: 1 }, content: [] }).success).toBe(true);
  });

  it("Mermaid source 有无单个尾换行时导出同一字节，解散分区不制造空行", () => {
    const diagramMarkdown = (source: string) => pmToMarkdown({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "diagram",
        attrs: {
          blockId: "diagram-roundtrip",
          lang: "mermaid",
          source,
          svg: null,
        },
      }],
    });
    const source = "flowchart TD\n  A[开始]\n  %% trailing comment keep";

    expect(diagramMarkdown(source)).toBe(diagramMarkdown(`${source}\n`));
    expect(diagramMarkdown(source)).toBe(
      "```mermaid\nflowchart TD\n  A[开始]\n  %% trailing comment keep\n```",
    );
  });

  it("serializes taskList, callout, blockMath, and inlineMath to markdown", () => {
    const markdown = pmToMarkdown(richPmDoc);

    expect(markdown).toContain(`行内公式 $${INLINE_LATEX}$ 与普通文本混排`);
    expect(markdown).toContain("- [x] 已完成：发布导出方案");
    expect(markdown).toContain(String.raw`- [ ] 待处理：校验 A | B、反斜杠 C:\drafts\alpha`);
    expect(markdown).toContain(`$$\n${BLOCK_LATEX}\n$$`);

    for (const tone of PM_CALLOUT_TONES) {
      expect(markdown).toContain(String.raw`> ${CALLOUT_EMOJI[tone]} ${tone} 提示：第一行含管道 | 和反斜杠 C:\callout\path`);
      expect(markdown).toContain("> 第二行必须继续带引用前缀");
    }

    const taskBlock = markdown
      .split("\n\n")
      .find((block) => block.includes("已完成：发布导出方案"));
    expect(taskBlock?.split("\n")).toEqual([
      "- [x] 已完成：发布导出方案",
      String.raw`- [ ] 待处理：校验 A | B、反斜杠 C:\drafts\alpha`,
      "换行后的任务说明",
    ]);
  });

  it("projects new blocks to plain text and legacy sections", () => {
    const plainText = pmToPlainText(richPmDoc);
    expect(plainText).toContain("行内公式 E=mc^2 与普通文本混排");
    expect(plainText).toContain("[x] 已完成：发布导出方案");
    expect(plainText).toContain(String.raw`[ ] 待处理：校验 A | B、反斜杠 C:\drafts\alpha`);
    expect(plainText).toContain(BLOCK_LATEX);

    const legacySections = pmToLegacySections(richPmDoc);
    const taskList = legacySections.find((section) => section.kind === "list");
    expect(taskList).toMatchObject({
      kind: "list",
      data: {
        ordered: false,
        items: [
          "[x] 已完成：发布导出方案",
          String.raw`[ ] 待处理：校验 A | B、反斜杠 C:\drafts\alpha
换行后的任务说明`,
        ],
      },
    });

    const mathSection = legacySections.find((section) => section.kind === "code");
    expect(mathSection).toEqual({ kind: "code", data: { body: BLOCK_LATEX, language: "latex" } });
    expect(legacySections.filter((section) => section.kind === "quote")).toHaveLength(PM_CALLOUT_TONES.length);
  });

  it("uses the updateDoc PM schema to accept legal rich blocks and reject illegal variants with precise paths", () => {
    expect(safeParsePmDoc(richPmDoc).success).toBe(true);

    const cases: Array<{ name: string; value: unknown; path: Array<string | number> }> = [
      {
        name: "taskItem 缺 checked",
        value: docWith([
          {
            type: "taskList",
            attrs: { blockId: "task-list-invalid" },
            content: [
              {
                type: "taskItem",
                attrs: { blockId: "task-item-invalid" },
                content: [paragraph("task-item-invalid-p", "缺 checked")],
              },
            ],
          },
        ]),
        path: ["content", 0, "content", 0, "attrs", "checked"],
      },
      {
        name: "callout content 为空数组",
        value: docWith([
          {
            type: "callout",
            attrs: { blockId: "callout-empty", tone: "info", emoji: "ℹ️" },
            content: [],
          },
        ]),
        path: ["content", 0, "content"],
      },
      {
        name: "blockMath 缺 latex",
        value: docWith([{ type: "blockMath", attrs: { blockId: "block-math-invalid" } }]),
        path: ["content", 0, "attrs", "latex"],
      },
      {
        name: "inlineMath attrs 缺失",
        value: docWith([
          {
            type: "paragraph",
            attrs: { blockId: "paragraph-invalid-inline-math" },
            content: [{ type: "inlineMath" }],
          },
        ]),
        path: ["content", 0, "content", 0, "attrs"],
      },
    ];

    for (const item of cases) {
      const parsed = safeParsePmDoc(item.value);
      expect(parsed.success, item.name).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.path), item.name).toContainEqual(item.path);
      }
    }
  });

  it("keeps bytes stable through JSON persistence and normalizePmDoc round trips", () => {
    const expected = JSON.stringify(normalizePmDoc(richPmDoc));
    let current: unknown = richPmDoc;

    for (let index = 0; index < 5; index += 1) {
      current = normalizePmDoc(JSON.parse(JSON.stringify(current)));
      expect(JSON.stringify(current)).toBe(expected);
      expect(Buffer.from(JSON.stringify(current)).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it("orderedList listStyle 校验归一且 Markdown 明确降级为数字序号", () => {
    const doc = docWith([
      {
        type: "orderedList",
        attrs: { blockId: "ol-alpha", start: 3, listStyle: "lower-alpha" },
        content: [
          { type: "listItem", attrs: { blockId: "ol-alpha-1" }, content: [paragraph("ol-alpha-1-p", "甲")] },
          { type: "listItem", attrs: { blockId: "ol-alpha-2" }, content: [paragraph("ol-alpha-2-p", "乙")] },
        ],
      },
    ]) as PmDoc;

    expect(safeParsePmDoc(doc).success).toBe(true);
    expect(pmToMarkdown(doc)).toBe("3. 甲\n4. 乙");

    for (const listStyle of PM_ORDERED_LIST_STYLES) {
      const parsed = safeParsePmDoc(docWith([
        {
          type: "orderedList",
          attrs: { blockId: `ol-${listStyle}`, listStyle },
          content: [{ type: "listItem", attrs: { blockId: `li-${listStyle}` }, content: [paragraph(`p-${listStyle}`, listStyle)] }],
        },
      ]));
      expect(parsed.success, listStyle).toBe(true);
    }

    const normalized = normalizePmDoc(docWith([
      {
        type: "orderedList",
        attrs: { blockId: "ol-bad", listStyle: "circled" },
        content: [{ type: "listItem", attrs: { blockId: "li-bad" }, content: [paragraph("li-bad-p", "坏样式")] }],
      },
    ]));
    const list = normalized.content[0];
    expect(list?.type).toBe("orderedList");
    expect(list?.type === "orderedList" ? list.attrs.listStyle : null).toBe("decimal");
  });

  it("normalizePmDoc 丢弃上传中、失败及遗留的图片占位节点", () => {
    const normalized = normalizePmDoc(docWith([
      {
        type: "image",
        attrs: {
          blockId: "img-uploading",
          src: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201%201%22%3E%3C%2Fsvg%3E",
          alt: "占位图",
          uploading: true,
          progress: 30,
          error: true,
          preview: "local-preview",
        },
      },
      {
        type: "image",
        attrs: {
          blockId: "img-error",
          src: "data:image/svg+xml,%3Csvg%2F%3E",
          alt: "失败占位图",
          uploading: false,
          error: true,
        },
      },
      {
        type: "image",
        attrs: {
          blockId: "upload-image-legacy-placeholder",
          src: "data:image/svg+xml,%3Csvg%2F%3E",
          alt: "状态已被旧规范化移除的占位图",
        },
      },
      {
        type: "image",
        attrs: {
          blockId: "upload-image-complete",
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
          alt: "已上传图片",
          uploading: false,
          progress: 100,
          error: false,
        },
      },
    ]));

    expect(normalized.content).toHaveLength(1);
    const image = normalized.content[0];
    expect(image).toMatchObject({
      type: "image",
      attrs: {
        blockId: "upload-image-complete",
        src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
      },
    });
    expect(image?.type === "image" ? image.attrs : {}).not.toHaveProperty("uploading");
    expect(image?.type === "image" ? image.attrs : {}).not.toHaveProperty("progress");
    expect(image?.type === "image" ? image.attrs : {}).not.toHaveProperty("error");
  });
});

function docWith(content: unknown[]): unknown {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function paragraph(blockId: string, text: string): unknown {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}
