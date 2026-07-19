import { describe, expect, it } from "vitest";
import { countCharsNoPunct, countDocVisibleChars, countVisibleChars } from "../charCount";
import { pmToPlainText } from "../pmToPlainText";
import type { PmDoc } from "../types";

describe("countVisibleChars", () => {
  it("中文含标点、不含空白", () => {
    expect(countVisibleChars("你好，世界！")).toBe(6);
    expect(countVisibleChars("你 好\n世\t界")).toBe(4);
  });

  it("空串与纯空白为 0", () => {
    expect(countVisibleChars("")).toBe(0);
    expect(countVisibleChars("  \n\t　")).toBe(0);
  });

  it("按码点计数:emoji/扩展平面不按 UTF-16 双计", () => {
    expect(countVisibleChars("a𝄞b")).toBe(3);
    expect(countVisibleChars("😀")).toBe(1);
  });

  it("NFC 归一化:组合字符折叠后计 1", () => {
    expect(countVisibleChars("é")).toBe(1); // é
  });

  it("中英混排", () => {
    expect(countVisibleChars("中文 and English, 123.")).toBe(17);
  });
});

describe("countCharsNoPunct", () => {
  it("只数 Unicode 字母与数字", () => {
    expect(countCharsNoPunct("你好，世界！abc 123…")).toBe(10);
  });

  it("覆盖日文、韩文、重音拉丁与全角数字", () => {
    expect(countCharsNoPunct("日本語")).toBe(3);
    expect(countCharsNoPunct("한국어")).toBe(3);
    expect(countCharsNoPunct("café")).toBe(4);
    expect(countCharsNoPunct("１２３")).toBe(3);
    expect(countCharsNoPunct("日本語，한국어 café １２３！")).toBe(13);
  });
});

describe("countDocVisibleChars", () => {
  const doc: PmDoc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
      { type: "paragraph", content: [{ type: "text", text: "正文，hello。" }] },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "格一" }] }] },
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "格二" }] }] },
            ],
          },
        ],
      },
    ],
  } as unknown as PmDoc;

  it("整篇文档:块间分隔(换行/制表)不计入字数", () => {
    // 标题2 + 正文9(正文，hello。) + 表格4
    expect(countDocVisibleChars(doc)).toBe(2 + 9 + 4);
  });

  it("空文档为 0", () => {
    expect(countDocVisibleChars({ type: "doc", content: [] } as unknown as PmDoc)).toBe(0);
  });

  it("图片/图表/附件等媒体节点不计入字数(只算文章文字)", () => {
    const withMedia: PmDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "正文四字" }] },
        { type: "image", attrs: { src: "/x.svg", alt: "一段很长的配图描述文字", caption: "图注也算字" } },
        { type: "diagram", attrs: { source: "graph TD; A-->B", engine: "mermaid" } },
        { type: "fileAttachment", attrs: { filename: "报告.pdf", src: "/f.pdf" } },
      ],
    } as unknown as PmDoc;
    // 只算"正文四字"=4;图片 alt/caption、图表源码、附件名都不计入
    expect(countDocVisibleChars(withMedia)).toBe(4);
  });

  it("嵌套在列表/表格里的图片也不计入字数(skipMedia 透传到容器节点)", () => {
    const nested: PmDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "项一" }] },
                { type: "image", attrs: { src: "/a.svg", alt: "列表里的配图描述很长一段" } },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: {},
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "格" }] },
                    { type: "image", attrs: { src: "/b.svg", alt: "表格里的图描述也不该算" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as PmDoc;
    // 只算"项一"(2)+"格"(1)=3;嵌套的两张图 alt 都不计入
    expect(countDocVisibleChars(nested)).toBe(3);
  });
});

describe("pmToPlainText 媒体口径", () => {
  const withImage: PmDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      { type: "image", attrs: { src: "/x.svg", alt: "配图描述文字" } },
      { type: "diagram", attrs: { source: "graph TD; A-->B", engine: "mermaid" } },
    ],
  } as unknown as PmDoc;

  it("默认(搜索 / AI / 导出口径)保留图片 alt 与图表源码,可被检索命中", () => {
    const text = pmToPlainText(withImage);
    expect(text).toContain("配图描述文字");
    expect(text).toContain("graph TD");
  });

  it("skipMedia 口径(字数)剔除图片与图表文本,只留正文", () => {
    const text = pmToPlainText(withImage, { skipMedia: true });
    expect(text).toContain("正文");
    expect(text).not.toContain("配图描述文字");
    expect(text).not.toContain("graph TD");
  });
});
