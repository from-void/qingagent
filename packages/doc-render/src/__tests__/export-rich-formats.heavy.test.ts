import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { PmCalloutTone, PmDoc } from "@qingagent/pm-schema";
import { PM_CALLOUT_TONES } from "@qingagent/pm-schema";
import { toDocx, toHtml, toMarkdown, toPdf } from "../export/index.js";
import { hasChromium } from "./browserTestGate.js";

const INLINE_LATEX = String.raw`E=mc^2`;
const BLOCK_LATEX = String.raw`\int_0^1 x^2 dx = \frac{1}{3}`;
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const DOCX_EMUS_PER_TWIP = 635;
const DOCX_EMUS_PER_PIXEL = 9_525;

function largeGifDataUrl(width: number, height: number): string {
  // 合法 GIF89a：逻辑画布使用测试尺寸，图像数据保持单色，避免把大二进制 fixture 写进仓库。
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  gif.writeUInt16LE(width, 6);
  gif.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${gif.toString("base64")}`;
}

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
      content: [{ type: "text", text: "富格式导出验收" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "paragraph-inline-math" },
      content: [
        { type: "text", text: "行内公式 " },
        { type: "inlineMath", attrs: { latex: INLINE_LATEX } },
        { type: "text", text: " 与普通文本混排。" },
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
              content: [{ type: "text", text: "已完成：导出 DOCX/PDF" }],
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
              content: [{ type: "text", text: String.raw`待处理：校验 A | B 与路径 C:\drafts\alpha` }],
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
          content: [{ type: "text" as const, text: `${tone} 提示：第一行含管道 | 和反斜杠 \\` }],
        },
        {
          type: "paragraph" as const,
          attrs: { blockId: `callout-${tone}-p2` },
          content: [{ type: "text" as const, text: `第二行内容 ${index + 1}` }],
        },
      ],
    })),
    {
      type: "blockMath",
      attrs: { blockId: "block-math-rich", latex: BLOCK_LATEX },
    },
  ],
};

const columnPmDoc: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "before-columns" },
      content: [{ type: "text", text: "分栏前正文" }],
    },
    {
      type: "columnList",
      attrs: { blockId: "columns-export" },
      content: [
        {
          type: "column",
          attrs: { blockId: "column-left", widthRatio: 0.35 },
          content: [
            {
              type: "heading",
              attrs: { blockId: "column-left-heading", level: 2 },
              content: [{ type: "text", text: "左栏标题" }],
            },
            {
              type: "paragraph",
              attrs: { blockId: "column-left-p" },
              content: [{ type: "text", text: "左栏正文" }],
            },
            {
              type: "bulletList",
              attrs: { blockId: "column-left-list" },
              content: [
                {
                  type: "listItem",
                  attrs: { blockId: "column-left-list-item" },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { blockId: "column-left-list-p" },
                      content: [{ type: "text", text: "左栏列表项" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "column",
          attrs: { blockId: "column-right", widthRatio: 0.65 },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "column-right-p" },
              content: [{ type: "text", text: "右栏正文" }],
            },
            {
              type: "table",
              attrs: { blockId: "column-right-table" },
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      content: [
                        {
                          type: "paragraph",
                          attrs: { blockId: "column-right-table-p" },
                          content: [{ type: "text", text: "右栏表格" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "image",
              attrs: {
                blockId: "column-right-image",
                src: `data:image/png;base64,${PNG_1X1}`,
                alt: "右栏图片",
                width: 24,
                height: 24,
              },
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { blockId: "after-columns" },
      content: [{ type: "text", text: "分栏后正文" }],
    },
  ],
};

describe("rich PM export formats", () => {
  it("exports DOCX with task checkboxes, callouts, block math, and inline math", async () => {
    const docx = await toDocx(richPmDoc, { title: "富格式导出" });

    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(docx.length).toBeGreaterThan(1000);

    const mammoth = await import("mammoth");
    const raw = await mammoth.extractRawText({ buffer: docx });
    const paragraphs = raw.value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(paragraphs.join("\n")).toContain("行内公式");
    expect(paragraphs.join("\n")).toContain("与普通文本混排。");
    expect(paragraphs).toContain("☑ 已完成：导出 DOCX/PDF");
    expect(paragraphs).toContain(String.raw`☐ 待处理：校验 A | B 与路径 C:\drafts\alpha`);
    expect(paragraphs.findIndex((line) => line.startsWith("☑ "))).toBeLessThan(
      paragraphs.findIndex((line) => line.startsWith("☐ ")),
    );
    // 公式应以 PNG 图片嵌入(有 Chromium 时)或等宽文本降级,但绝不残留破损的裸 LaTeX OMML。
    // docx 里裸 LaTeX 字符串(如 \int_0^1)出现在 w:t 里说明是旧的假 OMML 路径,应不存在。
    const documentXml = await docxXml(docx, "word/document.xml");
    expect(documentXml).not.toContain(`<m:t>${BLOCK_LATEX}</m:t>`);
    expect(documentXml).not.toContain(`<m:t>${INLINE_LATEX}</m:t>`);
  });

  it.skipIf(!hasChromium)("exports blockMath and inlineMath as PNG images (not raw LaTeX)", async () => {
    const docx = await toDocx(richPmDoc, { title: "公式图片导出" });
    const zip = await JSZip.loadAsync(docx);
    // 有 Chromium:公式应渲染成 PNG 图片嵌入 word/media/
    const media = Object.keys(zip.files).filter((f) => /^word\/media\/.+\.png$/i.test(f));
    expect(media.length, "公式未生成 PNG 图片嵌入").toBeGreaterThanOrEqual(2);
    // 原始 LaTeX 源码不应裸露在 document.xml 里(旧 MathRun 路径的特征)
    const documentXml = await docxXml(docx, "word/document.xml");
    expect(documentXml).not.toContain(`<m:t>${BLOCK_LATEX}</m:t>`);
    expect(documentXml).not.toContain(`<m:t>${INLINE_LATEX}</m:t>`);
    // 嵌入图片应有 drawing 元素
    expect(documentXml).toContain("<w:drawing>");
  });

  it("R3-16 exports nested DOCX lists with native numbering and keeps nested text", async () => {
    const nested: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "orderedList",
          attrs: { blockId: "ol", start: 1 },
          content: [
            {
              type: "listItem",
              attrs: { blockId: "li-1" },
              content: [
                { type: "paragraph", attrs: { blockId: "li-1-p" }, content: [{ type: "text", text: "第一层" }] },
                {
                  type: "bulletList",
                  attrs: { blockId: "ul-nested" },
                  content: [
                    {
                      type: "listItem",
                      attrs: { blockId: "li-1-1" },
                      content: [{ type: "paragraph", attrs: { blockId: "li-1-1-p" }, content: [{ type: "text", text: "第二层不丢" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const docx = await toDocx(nested, { title: "列表" });
    const documentXml = await docxXml(docx, "word/document.xml");
    const numberingXml = await docxXml(docx, "word/numbering.xml");

    expect(documentXml).toContain("第一层");
    expect(documentXml).toContain("第二层不丢");
    expect(documentXml.match(/<w:numPr>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(numberingXml).toContain('<w:numFmt w:val="decimal"');
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"');
  });

  it("用连续分节与列分页符原生导出 DOCX 分栏，且保留栏内复杂块", async () => {
    const docx = await toDocx(columnPmDoc, { title: "分栏导出" });

    expect(docx.subarray(0, 2).toString("utf8")).toBe("PK");

    const documentXml = await docxXml(docx, "word/document.xml");
    const zip = await JSZip.loadAsync(docx);
    const media = Object.keys(zip.files).filter((path) => /^word\/media\/.+\.png$/i.test(path));

    // columnList 必须成为 Word 原生分栏节，并用显式列分页符固定各逻辑栏的起点；
    // 前后正文则恢复单栏，避免后续内容继续流进分栏。
    expect(documentXml).toMatch(/<w:cols\b[^>]*\bw:num="2"[^>]*>/);
    expect(documentXml).toContain('<w:br w:type="column"/>');
    expect(documentXml.match(/<w:type w:val="continuous"\/>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(documentXml.match(/<w:cols\b[^>]*\bw:num="1"[^>]*>/g)?.length ?? 0).toBeGreaterThanOrEqual(1);

    // 非等宽 35/65 分栏应写出自定义列宽；栏内列表、表格、图片仍保留原生节点。
    const multiColumnXml = documentXml.match(/<w:cols\b[^>]*\bw:num="2"[^>]*>[\s\S]*?<\/w:cols>/)?.[0] ?? "";
    expect(multiColumnXml.match(/<w:col\b/g)?.length ?? 0).toBe(2);
    expect(new Set([...multiColumnXml.matchAll(/\bw:w="(\d+)"/g)].map((match) => match[1])).size).toBe(2);
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("右栏表格");
    expect(documentXml).toContain("<w:drawing>");
    expect(media.length).toBeGreaterThanOrEqual(1);

    const mammoth = await import("mammoth");
    const raw = await mammoth.extractRawText({ buffer: docx });
    const text = raw.value;

    expect(text).toContain("左栏标题");
    expect(text).toContain("左栏正文");
    expect(text).toContain("右栏正文");
    expect(text).toContain("左栏列表项");
    expect(text).toContain("右栏表格");
    expect(text.indexOf("左栏标题")).toBeLessThan(text.indexOf("左栏正文"));
    expect(text.indexOf("左栏正文")).toBeLessThan(text.indexOf("右栏正文"));
    expect(text.indexOf("分栏前正文")).toBeLessThan(text.indexOf("左栏标题"));
    expect(text.indexOf("右栏正文")).toBeLessThan(text.indexOf("分栏后正文"));
  });

  it("按当前栏宽限制大图，且不缩小分栏外图片", async () => {
    const largeImage = largeGifDataUrl(1200, 675);
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "image",
          attrs: {
            blockId: "full-width-image",
            src: largeImage,
            alt: "分栏外大图",
            width: 1200,
            height: 675,
          },
        },
        {
          type: "columnList",
          attrs: { blockId: "equal-columns" },
          content: [
            {
              type: "column",
              attrs: { blockId: "left-column", widthRatio: 0.5 },
              content: [
                {
                  type: "image",
                  attrs: {
                    blockId: "column-large-image",
                    src: largeImage,
                    alt: "栏内大图",
                    width: 1200,
                    height: 675,
                  },
                },
              ],
            },
            {
              type: "column",
              attrs: { blockId: "right-column", widthRatio: 0.5 },
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "right-column-text" },
                  content: [{ type: "text", text: "右栏" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          attrs: { blockId: "after-large-image-columns" },
          content: [{ type: "text", text: "分栏后" }],
        },
      ],
    };

    const documentXml = await docxXml(await toDocx(doc), "word/document.xml");
    const drawingWidths = [...documentXml.matchAll(/<wp:extent\b[^>]*\bcx="(\d+)"/g)]
      .map((match) => Number(match[1]));
    const equalColumnWidthTwips = (11_906 - 1_440 * 2 - 720) / 2;

    expect(drawingWidths).toHaveLength(2);
    expect(drawingWidths[0]).toBe(480 * DOCX_EMUS_PER_PIXEL);
    expect(drawingWidths[1]).toBeLessThanOrEqual(equalColumnWidthTwips * DOCX_EMUS_PER_TWIP);
  });

  it("用段落底边框原生导出 PM 水平线，不写入可编辑的线条字符", async () => {
    const pmHorizontalRule: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "paragraph", attrs: { blockId: "before-hr" }, content: [{ type: "text", text: "线上" }] },
        { type: "horizontalRule", attrs: { blockId: "hr" } },
        { type: "paragraph", attrs: { blockId: "after-hr" }, content: [{ type: "text", text: "线下" }] },
      ],
    };
    const documentXml = await docxXml(await toDocx(pmHorizontalRule), "word/document.xml");
    expect(documentXml).toContain("<w:pBdr>");
    expect(documentXml).toContain("<w:bottom");
    expect(documentXml).not.toMatch(/<w:t(?:\s[^>]*)?>[—─]+<\/w:t>/);
  });

  it("R3-04 exports structured Markdown", () => {
    const markdown = toMarkdown(richPmDoc, { title: "富格式导出" });

    expect(markdown).toContain("# 富格式导出");
    expect(markdown).toContain("## 富格式导出验收");
    expect(markdown).toContain("- [x] 已完成：导出 DOCX/PDF");
    expect(markdown).toContain(`$$\n${BLOCK_LATEX}\n$$`);
  });

  // 回归：正文首标题被加粗包裹(`# **标题**`)时,旧的 body.startsWith(`# ${title}`) 去重判定
  // 漏判→顶部重复出现两个 H1。改用 documentLeadsWithTitle(忽略 mark)后只应有一个 H1。
  it("does not duplicate H1 when body leads with a bold-wrapped title", () => {
    const boldTitleDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "bold-title-h1", level: 1 },
          content: [{ type: "text", marks: [{ type: "bold" }], text: "AI 驱动的研究" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "bold-title-p" },
          content: [{ type: "text", text: "正文第一段。" }],
        },
      ],
    };
    const markdown = toMarkdown(boldTitleDoc, { title: "AI 驱动的研究" });
    expect((markdown.match(/^# /gm) ?? []).length).toBe(1);
  });

  // 反向：正文首标题与 title 不同时,仍补一个文档标题 H1。
  it("still prepends a title H1 when the body does not lead with it", () => {
    const noTitleDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "no-title-p" },
          content: [{ type: "text", text: "正文。" }],
        },
      ],
    };
    const md = toMarkdown(noTitleDoc, { title: "整本书" });
    expect(md.startsWith("# 整本书")).toBe(true);
  });

  // 边界（代码评审提出）：首块是与 title 同名的 H2 时,Markdown 仍应补一个 H1 文档标题,
  // 不能因 H2 同名就跳过(requireLevel1 守住此口径,避免去重判定误伤 H2)。
  it("still prepends an H1 title when the body leads with a same-named H2", () => {
    const h2LeadDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "h2-lead", level: 2 },
          content: [{ type: "text", text: "总览" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "h2-lead-p" },
          content: [{ type: "text", text: "正文。" }],
        },
      ],
    };
    const md = toMarkdown(h2LeadDoc, { title: "总览" });
    expect(md.startsWith("# 总览")).toBe(true);
    expect(md).toContain("## 总览");
  });

  // 回归 export-docx-blockquote-lost:blockquote 在 docx 里此前拍平成普通段落(pPr 无装饰),
  // 修复后引用块内段落应带左缩进 + 左竖边框 + 底纹(pBdr/ind/shd)。
  it("exports DOCX blockquote with quote decoration (border/indent/shading)", async () => {
    const quoteDoc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "blockquote",
          attrs: { blockId: "bq-1" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "bq-1-p" },
              content: [{ type: "text", text: "这是一段引用块史料摘录。" }],
            },
          ],
        },
      ],
    };
    const docx = await toDocx(quoteDoc, { title: "引用导出" });
    const documentXml = await docxXml(docx, "word/document.xml");
    expect(documentXml).toMatch(/<w:pBdr>[\s\S]*?<w:left/);
    expect(documentXml).toContain("<w:ind ");
    expect(documentXml).toMatch(/<w:shd[^>]*w:fill="F5F2EC"/);
  });

  // 回归 table-cell-color:单元格背景色 + 文字色此前导出全丢。html 应带 data-bg-color/
  // data-text-color + 内联 style;docx 应带 cell shading + run color。
  const colorDoc: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "table",
        attrs: { blockId: "color-table" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { backgroundColor: "red" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { blockId: "color-cell-p" },
                    content: [
                      { type: "text", marks: [{ type: "textColor", attrs: { color: "blue" } }], text: "蓝字" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("exports table cell backgroundColor and textColor to HTML", () => {
    const html = toHtml(colorDoc, { title: "颜色导出" });
    expect(html).toContain('data-bg-color="red"');
    expect(html).toMatch(/<t[dh][^>]*style="background-color:#[0-9a-fA-F]{6}"/);
    expect(html).toContain('data-text-color="blue"');
    expect(html).toMatch(/<span data-text-color="blue" style="color:#[0-9a-fA-F]{6}"/);
  });

  it("exports table cell backgroundColor and textColor to DOCX", async () => {
    const docx = await toDocx(colorDoc, { title: "颜色导出" });
    const documentXml = await docxXml(docx, "word/document.xml");
    // cell shading(背景) + run color(文字色,6 位 hex 无 #)
    expect(documentXml).toMatch(/<w:tcPr>[\s\S]*?<w:shd[^>]*w:fill="[0-9A-Fa-f]{6}"/);
    expect(documentXml).toMatch(/<w:color w:val="[0-9A-Fa-f]{6}"/);
  });

  // PDF 已改为 HTML→Chromium 渲染:富格式的布局语义在 toHtml(纯函数,无浏览器)这一层固化,
  // 这里对 HTML 结构做断言;真实 PDF 字节由下方 chromium 门控烟测覆盖。
  it("serializes rich PM doc to faithful HTML (callouts/math/tasks)", () => {
    const html = toHtml(richPmDoc, { title: "富格式导出" });

    // 每个色调一个 callout:带 tone class + emoji + 文本
    const calloutCount = html.match(/class="pm-callout pm-callout--/g)?.length ?? 0;
    expect(calloutCount).toBe(PM_CALLOUT_TONES.length);
    for (const tone of PM_CALLOUT_TONES) {
      expect(html).toContain(`pm-callout--${tone}`);
      expect(html).toContain(CALLOUT_EMOJI[tone]);
      expect(html).toContain(`${tone} 提示`);
    }

    // 块公式 / 行内公式:经 KaTeX 渲染成数学排版(不再是 LaTeX 源码),并内嵌自包含字体
    expect(html).toContain('<div class="block-math">');
    expect(html).toContain('<span class="inline-math">');
    expect(html).toContain('class="katex"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toContain(BLOCK_LATEX);

    // 任务清单:勾选态 + 文本
    expect(html).toContain('class="pm-task-list"');
    expect(html).toContain("已完成：导出 DOCX/PDF");
    expect(html).toContain("is-checked");
  });

  it("serializes columnList to faithful HTML preserving order and width ratio", () => {
    const html = toHtml(columnPmDoc, { title: "分栏导出" });

    expect(html).toContain("pm-column-list");
    expect(html).toContain("flex-grow:0.35");
    expect(html).toContain("flex-grow:0.65");
    expect(html).toContain("左栏标题");
    expect(html).toContain("左栏正文");
    expect(html).toContain("右栏正文");
    expect(html.indexOf("左栏标题")).toBeLessThan(html.indexOf("左栏正文"));
    expect(html.indexOf("左栏正文")).toBeLessThan(html.indexOf("右栏正文"));
  });

  it.skipIf(!hasChromium)("DOCX 把图表渲染成内嵌 PNG(不再是源码)且标题不重复", async () => {
    const TITLE = "图表导出报告";
    const docWithTitleAndDiagram: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        { type: "heading", attrs: { blockId: "h", level: 1 }, content: [{ type: "text", text: TITLE }] },
        { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "正文" }] },
        { type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart LR\n A-->B-->C", svg: null } },
      ],
    } as unknown as PmDoc;

    const docx = await toDocx(docWithTitleAndDiagram, { title: TITLE });
    const zip = await JSZip.loadAsync(docx);
    // 图表 → 内嵌 PNG 媒体
    const media = Object.keys(zip.files).filter((f) => /^word\/media\/.+\.png$/i.test(f));
    expect(media.length).toBeGreaterThanOrEqual(1);
    // 不残留 mermaid 源码;标题只出现一次(首块 H1 即标题,不再额外加一遍)
    const mammoth = await import("mammoth");
    const text = (await mammoth.extractRawText({ buffer: docx })).value;
    expect(text).not.toContain("flowchart LR");
    expect((text.match(new RegExp(TITLE, "g")) ?? []).length).toBe(1);
  });

  it.skipIf(!hasChromium)("renders rich + column PM docs to real PDFs", async () => {
    const richPdf = await toPdf(richPmDoc, { title: "富格式导出" });
    expect(richPdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(richPdf.length).toBeGreaterThan(1000);

    const columnPdf = await toPdf(columnPmDoc, { title: "分栏导出" });
    expect(columnPdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});

async function docxXml(buffer: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  if (!file) throw new Error(`missing ${path}`);
  return file.async("string");
}
