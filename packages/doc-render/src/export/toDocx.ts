import {
  AlignmentType,
  BorderStyle,
  Column,
  ColumnBreak,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableBorders,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IRunOptions,
  type ISectionOptions,
  type ParagraphChild,
} from "docx";
import type { LegacySection } from "@qingagent/contract-ts";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark, PmOrderedListStyle, PmTableCellNode, PmThemeColor } from "@qingagent/pm-schema";
import {
  PM_THEME_HIGHLIGHT_COLOR_VALUES,
  PM_THEME_TEXT_COLOR_VALUES,
  decodeSvgDataUrl,
  isAllowedThemeColor,
} from "@qingagent/pm-schema";
import {
  createExportDegradationReporter,
  documentLeadsWithTitle,
  drawioFallbackMessage,
  isDrawioExportSourceNormalized,
  isPmDocDocument,
  isRenderableSvg,
  readLocalUploadBuffer,
  readLocalUploadText,
  sectionText,
  svgExceedsExportByteLimit,
  type ExportDocument,
  type ExportOptions,
} from "./shared.js";
import { withRenderedDiagrams } from "./mermaidServer.js";
import { rasterizeMathBatch, rasterizeSvgToPng, type MathRasterResult } from "./rasterize.js";
import { collectExportFootnotes } from "./footnotes.js";

// ——— 公式图片预渲染 ———

/** 用于在 toDocx 内传递预渲染好的公式位图；ImageRun 要等拿到当前栏宽后再创建。 */
type MathImages = ReadonlyMap<string, MathRasterResult | null>;
type ReportExportDegradation = ReturnType<typeof createExportDegradationReporter>;
const INLINE_MATH_MIN_READABLE_HEIGHT_PX = 16;
const BLOCK_MATH_MIN_READABLE_HEIGHT_PX = 32;

function mathKey(latex: string, displayMode: boolean): string {
  return `${displayMode ? "D" : "I"}:${latex}`;
}

/** 递归扫描 PmDoc,收集所有唯一数学公式(去重) */
function collectMathFormulas(doc: PmDoc): Array<{ latex: string; displayMode: boolean }> {
  const found = new Map<string, { latex: string; displayMode: boolean }>();
  function visit(node: Record<string, unknown>): void {
    const type = node.type as string | undefined;
    if (type === "blockMath") {
      const latex = (node.attrs as Record<string, unknown> | undefined)?.latex;
      if (typeof latex === "string") found.set(mathKey(latex, true), { latex, displayMode: true });
    } else if (type === "inlineMath") {
      const latex = (node.attrs as Record<string, unknown> | undefined)?.latex;
      if (typeof latex === "string") found.set(mathKey(latex, false), { latex, displayMode: false });
    }
    const content = node.content;
    if (Array.isArray(content)) {
      for (const child of content) {
        if (child && typeof child === "object") visit(child as Record<string, unknown>);
      }
    }
  }
  visit(doc as unknown as Record<string, unknown>);
  return [...found.values()];
}

/**
 * 批量预渲染公式位图,失败则映射到 null(调用方降级为等宽文本)。
 * 超过 150 个唯一公式时跳过 Chromium 渲染、全部降级为文本:
 * 防止极端文档(如压力测试)占满浏览器池导致导出超时。
 * 正常技术/学术文档 < 100 个唯一公式,不受此限制。
 */
async function buildMathImages(formulas: Array<{ latex: string; displayMode: boolean }>): Promise<MathImages> {
  if (formulas.length === 0) return new Map();
  // 公式数过多时全部降级为等宽文本(map key 存在但值为 null → latexToDocxRun 走文本分支)
  if (formulas.length > 150) {
    return new Map(formulas.map(({ latex, displayMode }) => [mathKey(latex, displayMode), null]));
  }
  const rasters = await rasterizeMathBatch(formulas);
  const map = new Map<string, MathRasterResult | null>();
  for (let i = 0; i < formulas.length; i++) {
    const { latex, displayMode } = formulas[i]!;
    const raster = rasters[i];
    if (!raster) { map.set(mathKey(latex, displayMode), null); continue; }
    map.set(mathKey(latex, displayMode), raster);
  }
  return map;
}

/** LaTeX → docx ParagraphChild:先查预渲染 map,失败降级为等宽文本。 */
function latexToDocxRun(
  latex: string,
  displayMode: boolean,
  mathImages: MathImages,
  availableWidthTwips: number,
): ParagraphChild {
  const raster = mathImages.get(mathKey(latex, displayMode));
  // raster===undefined:key 不在 map(不应发生),raster===null:渲染失败
  if (raster) {
    const maxWidth = Math.min(displayMode ? 400 : Number.POSITIVE_INFINITY, twipsToPixels(availableWidthTwips));
    const initialHeight = displayMode ? raster.height : Math.min(28, raster.height);
    const initialWidth = raster.width * initialHeight / raster.height;
    const scale = Math.min(1, maxWidth / initialWidth);
    const width = Math.max(1, initialWidth * scale);
    // DOCX 的行内图片无法像文本一样重排公式。宽度仍严格服从当前栏预算；但等比缩放
    // 会把长公式压成几像素高的糊条，因此高度只等比缩到可读下限，之后仅继续压缩宽度。
    // 下限不超过图片原始目标高度，避免反向放大小公式。
    const minReadableHeight = displayMode
      ? BLOCK_MATH_MIN_READABLE_HEIGHT_PX
      : INLINE_MATH_MIN_READABLE_HEIGHT_PX;
    const height = Math.max(
      1,
      Math.min(initialHeight, Math.max(minReadableHeight, initialHeight * scale)),
    );
    return new ImageRun({
      type: "png",
      data: raster.data,
      transformation: { width, height },
      altText: { name: latex, title: "公式", description: latex },
    });
  }
  return new TextRun({ text: latex, font: "Courier New" });
}

const FONT = "Noto Sans CJK SC";
const DOCX_PAGE_WIDTH_TWIPS = 11_906;
const DOCX_HORIZONTAL_MARGIN_TWIPS = 1_440;
const DOCX_COLUMN_GAP_TWIPS = 720;
const DOCX_TWIPS_PER_PIXEL = 15;
const DOCX_CONTENT_WIDTH_TWIPS = DOCX_PAGE_WIDTH_TWIPS - DOCX_HORIZONTAL_MARGIN_TWIPS * 2;
const BULLET_NUMBERING = "qingagent-bullet-list";
const ORDERED_NUMBERING_BY_STYLE: Record<PmOrderedListStyle, string> = {
  decimal: "qingagent-ordered-list-decimal",
  "lower-alpha": "qingagent-ordered-list-lower-alpha",
  "upper-alpha": "qingagent-ordered-list-upper-alpha",
  "lower-roman": "qingagent-ordered-list-lower-roman",
  "upper-roman": "qingagent-ordered-list-upper-roman",
};

type DocxNumberingConfig = {
  reference: string;
  levels: ReturnType<typeof numberingLevels>;
};

type DocxNumberingRegistry = {
  config: DocxNumberingConfig[];
  referenceFor: (
    owner: object,
    listStyle: string | null | undefined,
    start: number | null | undefined,
  ) => string;
};

function createDocxNumberingRegistry(): DocxNumberingRegistry {
  const config: DocxNumberingConfig[] = [
    { reference: BULLET_NUMBERING, levels: numberingLevels("bullet") },
  ];
  const references = new WeakMap<object, string>();
  let nextReference = 1;

  return {
    config,
    referenceFor(owner, listStyle, start) {
      const existing = references.get(owner);
      if (existing) return existing;
      const style = normalizeOrderedListStyle(listStyle);
      const reference = `${ORDERED_NUMBERING_BY_STYLE[style]}-${nextReference++}`;
      references.set(owner, reference);
      config.push({
        reference,
        levels: numberingLevels("ordered", style, normalizeOrderedListStart(start)),
      });
      return reference;
    },
  };
}

export async function toDocx(
  document: ExportDocument,
  options: ExportOptions = {},
): Promise<Buffer> {
  const reportDegradation = createExportDegradationReporter(options.onDegradation);
  // 先补渲染缺缓存的 Mermaid；drawio 只消费客户端持久化的安全 SVG 缓存。
  // DOCX 再把可用 SVG 栅格成 PNG 嵌入，缺失/失败则按 W4 设计回退源码。
  const prepared = await withRenderedDiagrams(document);
  const footnotes = isPmDocDocument(prepared)
    ? collectExportFootnotes(prepared)
    : { definitions: [], numberById: new Map<string, number>() };
  // 批量预渲染文档中所有数学公式(单个 Chromium 上下文,避免逐公式开关上下文)。
  const mathImages = isPmDocDocument(prepared)
    ? await buildMathImages(collectMathFormulas(prepared))
    : new Map<string, MathRasterResult | null>();
  const numbering = createDocxNumberingRegistry();
  const title = options.title?.trim();
  const titleChildren = [
    // 正文开头已是同名标题就不再加一遍(去重),避免两个标题
    ...(title && !documentLeadsWithTitle(prepared, title)
      ? [
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
          }),
        ]
      : []),
  ];
  const sections: readonly ISectionOptions[] = isPmDocDocument(prepared)
    ? await pmDocToDocxSections(
        prepared,
        titleChildren,
        mathImages,
        numbering,
        footnotes.numberById,
        reportDegradation,
      )
    : [{
        children: [
          ...titleChildren,
          ...(await Promise.all(prepared.map((section) =>
            sectionToDocx(
              section,
              numbering,
              section.kind === "diagram" && isDrawioExportSourceNormalized(section.data),
              DOCX_CONTENT_WIDTH_TWIPS,
              reportDegradation,
            ),
          ))).flat(),
        ],
      }];

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 24 } },
        heading1: { run: { font: FONT, bold: true, size: 36 } },
        heading2: { run: { font: FONT, bold: true, size: 30 } },
        heading3: { run: { font: FONT, bold: true, size: 27 } },
        heading4: { run: { font: FONT, bold: true, size: 25 } },
        heading5: { run: { font: FONT, bold: true, size: 23 } },
        heading6: { run: { font: FONT, bold: true, size: 22 } },
        title: { run: { font: FONT, bold: true, size: 42 } },
      },
    },
    numbering: {
      config: numbering.config,
    },
    ...(footnotes.definitions.length > 0
      ? {
          footnotes: Object.fromEntries(footnotes.definitions.map(({ number, note }) => [
            String(number),
            {
              children: [
                new Paragraph({
                  children: [new TextRun({ text: note, font: FONT })],
                }),
              ],
            },
          ])),
        }
      : {}),
    sections,
  });

  return Packer.toBuffer(doc);
}

/**
 * 把顶层 PM 流切成 Word 连续分节。
 *
 * columnList 使用节属性 w:cols；逻辑栏之间插入 w:br type=column，避免 Word
 * 按内容高度自动重排到相邻栏。分栏前后的普通内容显式回到单栏节，防止布局外溢。
 */
async function pmDocToDocxSections(
  doc: PmDoc,
  leadingChildren: Array<Paragraph | Table>,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
  footnoteNumbers: ReadonlyMap<string, number>,
  reportDegradation: ReportExportDegradation,
): Promise<ISectionOptions[]> {
  const hasColumns = doc.content.some((node) => node.type === "columnList");
  if (!hasColumns) {
    return [{
      children: [
        ...leadingChildren,
        ...(await Promise.all(doc.content.map((node) =>
          pmBlockToDocx(
            node,
            0,
            { availableWidthTwips: DOCX_CONTENT_WIDTH_TWIPS },
            mathImages,
            numbering,
            footnoteNumbers,
            reportDegradation,
          ),
        ))).flat(),
      ],
    }];
  }

  const sections: ISectionOptions[] = [];
  let singleColumnChildren = [...leadingChildren];
  const flushSingleColumn = (): void => {
    if (singleColumnChildren.length === 0) return;
    sections.push({
      properties: {
        type: SectionType.CONTINUOUS,
        column: { count: 1 },
      },
      children: singleColumnChildren,
    });
    singleColumnChildren = [];
  };

  for (const node of doc.content) {
    if (node.type !== "columnList") {
      singleColumnChildren.push(...await pmBlockToDocx(
        node,
        0,
        { availableWidthTwips: DOCX_CONTENT_WIDTH_TWIPS },
        mathImages,
        numbering,
        footnoteNumbers,
        reportDegradation,
      ));
      continue;
    }

    flushSingleColumn();
    const columnLayout = docxColumns(node.content.map((column) => column.attrs.widthRatio));
    const columnChildren: Array<Paragraph | Table> = [];
    for (const [index, column] of node.content.entries()) {
      if (index > 0) {
        columnChildren.push(new Paragraph({ children: [new ColumnBreak()] }));
      }
      for (const child of column.content) {
        columnChildren.push(...await pmBlockToDocx(
          child,
          0,
          { availableWidthTwips: columnLayout.widths[index] ?? DOCX_CONTENT_WIDTH_TWIPS },
          mathImages,
          numbering,
          footnoteNumbers,
          reportDegradation,
        ));
      }
    }
    sections.push({
      properties: {
        type: SectionType.CONTINUOUS,
        column: columnLayout.properties,
      },
      children: columnChildren,
    });
  }

  flushSingleColumn();
  return sections;
}

/** 按 PM widthRatio 计算 A4 正文区内的 Word 自定义列宽，所有值均为 twip。 */
function docxColumns(widthRatios: readonly (number | null | undefined)[]) {
  const count = Math.max(1, widthRatios.length);
  const gap = Math.min(
    DOCX_COLUMN_GAP_TWIPS,
    Math.max(0, Math.floor((DOCX_PAGE_WIDTH_TWIPS - DOCX_HORIZONTAL_MARGIN_TWIPS * 2) / (count * 4))),
  );
  const availableWidth = DOCX_PAGE_WIDTH_TWIPS
    - DOCX_HORIZONTAL_MARGIN_TWIPS * 2
    - gap * (count - 1);
  const weights = normalizedColumnWeights(widthRatios);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || count;
  let allocatedWidth = 0;
  const widths = weights.map((weight, index) => {
    const width = index === count - 1
      ? Math.max(1, availableWidth - allocatedWidth)
      : Math.max(1, Math.round(availableWidth * weight / weightTotal));
    allocatedWidth += width;
    return width;
  });
  const children = widths.map((width, index) =>
    new Column({
      width,
      ...(index < count - 1 ? { space: gap } : {}),
    }),
  );

  return {
    properties: {
      count,
      equalWidth: false,
      children,
    },
    widths,
  };
}

function normalizedColumnWeights(
  widthRatios: readonly (number | null | undefined)[],
): number[] {
  return widthRatios.map((ratio) =>
    typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
  );
}

// 引用块视觉装饰:左缩进 + 左侧竖边框 + 浅暖底纹(与 callout/codeBlock 同色系),
// 让 docx 里 blockquote 真带上 pPr 装饰而非退化成普通段落(回归 export-docx-blockquote-lost)。
const QUOTE_PARAGRAPH_DECORATION = {
  indent: { left: 360 },
  border: {
    left: { style: BorderStyle.SINGLE, size: 18, space: 12, color: "C8C2B6" },
  },
  shading: { type: ShadingType.CLEAR, fill: "F5F2EC", color: "auto" },
} as const;

/** Word 原生水平线：空段落的底边框（w:pBdr/w:bottom），不写入可编辑字符。 */
function horizontalRuleParagraph(): Paragraph {
  return new Paragraph({
    border: {
      bottom: {
        style: BorderStyle.SINGLE,
        size: 6,
        space: 1,
        color: "C8C2B6",
      },
    },
    spacing: { before: 80, after: 180 },
  });
}

type DocxBlockOptions = {
  availableWidthTwips: number;
  inQuote?: boolean;
};

async function pmBlockToDocx(
  node: PmBlockNode,
  depth: number,
  opts: DocxBlockOptions,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
  footnoteNumbers: ReadonlyMap<string, number>,
  reportDegradation: ReportExportDegradation,
): Promise<Array<Paragraph | Table>> {
  const quoteDeco = opts.inQuote ? QUOTE_PARAGRAPH_DECORATION : {};
  switch (node.type) {
    case "columnList":
      reportDegradation("docx-columns-flattened");
      // 顶层 columnList 在 pmDocToDocxSections 中转换为 w:cols。若合法 PM 把分栏
      // 嵌进表格单元格等容器，sectPr 不能位于容器内部；改用无边框 Word 表格保持
      // 真正并排且让每栏继续容纳列表/表格/图片，绝不退回纵向拍平。
      return [await nestedColumnListToDocx(
        node,
        depth,
        opts,
        mathImages,
        numbering,
        footnoteNumbers,
        reportDegradation,
      )];
    case "diagram":
      // 图表块:有渲染好的 svg 就当图片嵌入(走 image 的 svg→png 路径),否则源码降级为 code 块。
      return sectionToDocx(
        { kind: "diagram", data: { lang: node.attrs.lang, source: node.attrs.source, svg: node.attrs.svg } },
        numbering,
        isDrawioExportSourceNormalized(node.attrs),
        opts.availableWidthTwips,
        reportDegradation,
      );
    case "heading":
      return [
        new Paragraph({
          children: pmInlineToDocx(
            node.content ?? [],
            {bold: true},
            mathImages,
            footnoteNumbers,
            opts.availableWidthTwips,
          ),
          heading: headingLevelToDocx(node.attrs.level),
          alignment: alignmentToDocx(node.attrs.textAlign),
          ...quoteDeco,
        }),
      ];
    case "paragraph":
      return [
        new Paragraph({
          children: pmInlineToDocx(node.content ?? [], {}, mathImages, footnoteNumbers, opts.availableWidthTwips),
          alignment: alignmentToDocx(node.attrs.textAlign),
          spacing: { after: 180 },
          ...quoteDeco,
        }),
      ];
    case "penNote":
      return [
        new Paragraph({
          children: pmInlineToDocx(
            node.content ?? [],
            { italics: true },
            mathImages,
            footnoteNumbers,
            opts.availableWidthTwips,
          ),
          spacing: { after: 180 },
        }),
      ];
    case "blockquote":
      // 把 inQuote 透传给子块,使引用内的段落/标题带上引用视觉装饰。
      return (await Promise.all(node.content.map((child) =>
        pmBlockToDocx(child, depth, { ...opts, inQuote: true }, mathImages, numbering, footnoteNumbers, reportDegradation),
      ))).flat();
    case "bulletList":
      return (await Promise.all(node.content.map((item) =>
        pmListItemToDocx(item.content, BULLET_NUMBERING, depth, opts, mathImages, numbering, footnoteNumbers, reportDegradation),
      ))).flat();
    case "orderedList": {
      const reference = numbering.referenceFor(node, node.attrs.listStyle, node.attrs.start);
      return (await Promise.all(node.content.map((item) =>
        pmListItemToDocx(item.content, reference, depth, opts, mathImages, numbering, footnoteNumbers, reportDegradation),
      ))).flat();
    }
    case "horizontalRule":
      return [horizontalRuleParagraph()];
    case "codeBlock":
      return [
        new Paragraph({
          children: [new TextRun({ text: pmInlineText(node.content ?? []), font: "Courier New", size: 20 })],
          shading: { type: ShadingType.CLEAR, fill: "F2F0EB" },
          spacing: { after: 180 },
        }),
      ];
    case "table":
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: await Promise.all(node.content.map(async (row) =>
            new TableRow({
              // 表格当前由 Word 按 100% 宽度自动布局，并未输出固定 tblGrid；PM colwidth
              // 又是可选提示。这里只能把当前栏宽作为单元格内容的可靠上界，不能先猜
              // 等分宽度去缩图片，否则图片预算会与 Word 最终算出的单元格宽度脱节。
              children: await Promise.all(row.content.map((cell) =>
                pmTableCellToDocx(cell, opts, mathImages, numbering, footnoteNumbers, reportDegradation),
              )),
            }),
          )),
        }),
      ];
    case "image":
      return sectionToDocx(
        {
          kind: "image",
          data: {
            src: node.attrs.src,
            alt: node.attrs.alt ?? "",
            caption: node.attrs.caption ?? null,
            width: node.attrs.width ?? null,
            height: node.attrs.height ?? null,
          },
        },
        numbering,
        false,
        opts.availableWidthTwips,
        reportDegradation,
      );
    case "fileAttachment":
      return [
        new Paragraph({
          children: [new TextRun({ text: `附件：${node.attrs.filename}`, font: FONT })],
          spacing: { after: 180 },
        }),
      ];
    case "taskList": {
      const children: Array<Paragraph | Table> = [];
      for (const item of node.content) {
        for (const child of item.content) {
          if (child.type === "paragraph") {
            children.push(new Paragraph({
              children: [
                new TextRun({ text: item.attrs.checked ? "☑ " : "☐ ", font: FONT }),
                ...pmInlineToDocx(
                  child.content ?? [],
                  {},
                  mathImages,
                  footnoteNumbers,
                  opts.availableWidthTwips,
                ),
              ],
              indent: { left: depth * 360 },
              spacing: { after: 120 },
            }));
          } else if (child.type === "taskList") {
            children.push(...await pmBlockToDocx(child, depth + 1, opts, mathImages, numbering, footnoteNumbers, reportDegradation));
          } else {
            children.push(...await pmBlockToDocx(child, depth, opts, mathImages, numbering, footnoteNumbers, reportDegradation));
          }
        }
      }
      return children;
    }
    case "callout": {
      const fill = calloutFill(node.attrs.tone);
      return node.content.map((child, index) =>
        new Paragraph({
          children: [
            ...(index === 0 ? [new TextRun({ text: `${node.attrs.emoji ?? "💡"} `, font: FONT })] : []),
            ...pmInlineToDocx(child.content ?? [], {}, mathImages, footnoteNumbers, opts.availableWidthTwips),
          ],
          shading: { type: ShadingType.CLEAR, fill },
          spacing: { after: 120 },
        }),
      );
    }
    case "blockMath": {
      const run = latexToDocxRun(node.attrs.latex, true, mathImages, opts.availableWidthTwips);
      return [
        new Paragraph({
          children: [run],
          alignment: AlignmentType.CENTER,
          spacing: { after: 180 },
        }),
      ];
    }
  }
}

async function nestedColumnListToDocx(
  node: Extract<PmBlockNode, { type: "columnList" }>,
  depth: number,
  opts: DocxBlockOptions,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
  footnoteNumbers: ReadonlyMap<string, number>,
  reportDegradation: ReportExportDegradation,
): Promise<Table> {
  const weights = normalizedColumnWeights(node.content.map((column) => column.attrs.widthRatio));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || Math.max(1, weights.length);
  const cells = await Promise.all(node.content.map(async (column, index) => {
    const availableWidthTwips = Math.max(1, opts.availableWidthTwips * weights[index]! / weightTotal);
    const children = (await Promise.all(column.content.map((child) =>
      pmBlockToDocx(
        child,
        depth,
        { ...opts, availableWidthTwips },
        mathImages,
        numbering,
        footnoteNumbers,
        reportDegradation,
      ),
    ))).flat();
    return new TableCell({
      width: { size: weights[index]! / weightTotal * 100, type: WidthType.PERCENTAGE },
      children: children.length > 0 ? children : [new Paragraph("")],
    });
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TableBorders.NONE,
    rows: [new TableRow({ children: cells })],
  });
}

async function pmListItemToDocx(
  content: readonly PmBlockNode[],
  reference: string,
  depth: number,
  opts: DocxBlockOptions,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
  footnoteNumbers: ReadonlyMap<string, number>,
  reportDegradation: ReportExportDegradation,
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  for (const child of content) {
    if (child.type === "paragraph" || child.type === "heading" || child.type === "penNote") {
      children.push(new Paragraph({
        children: pmInlineToDocx(
          child.content ?? [],
          {},
          mathImages,
          footnoteNumbers,
          opts.availableWidthTwips,
        ),
        numbering: { reference, level: Math.min(depth, 5) },
        spacing: { after: 120 },
      }));
      continue;
    }
    if (child.type === "bulletList") {
      children.push(...await pmBlockToDocx(child, depth + 1, opts, mathImages, numbering, footnoteNumbers, reportDegradation));
      continue;
    }
    if (child.type === "orderedList") {
      children.push(...await pmBlockToDocx(child, depth + 1, opts, mathImages, numbering, footnoteNumbers, reportDegradation));
      continue;
    }
    children.push(...await pmBlockToDocx(child, depth, opts, mathImages, numbering, footnoteNumbers, reportDegradation));
  }
  return children;
}

async function pmTableCellToDocx(
  cell: PmTableCellNode,
  opts: DocxBlockOptions,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
  footnoteNumbers: ReadonlyMap<string, number>,
  reportDegradation: ReportExportDegradation,
): Promise<TableCell> {
  const children = (await Promise.all(cell.content.map((child) =>
    pmBlockToDocx(child, 0, opts, mathImages, numbering, footnoteNumbers, reportDegradation),
  ))).flat();
  const colspan = normalizeTableSpan(cell.attrs?.colspan);
  const rowspan = normalizeTableSpan(cell.attrs?.rowspan);
  // 单元格背景色:此前 docx 导出丢失(回归 table-cell-color)。docx TableCell 原生支持 shading,
  // fill 为 6 位 hex 无 #。
  const bg = cell.attrs?.backgroundColor;
  const shading =
    bg && isAllowedThemeColor(bg)
      ? { shading: { type: ShadingType.CLEAR, fill: PM_THEME_HIGHLIGHT_COLOR_VALUES[bg as PmThemeColor].slice(1) } }
      : {};
  return new TableCell({
    children: children.length > 0 ? children : [new Paragraph("")],
    ...(colspan > 1 ? { columnSpan: colspan } : {}),
    // docx 的 rowSpan 会在建表时按逻辑列插入 vMerge continuation，
    // 同时继承 columnSpan，避免后续行的真实单元格向左错位。
    ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
    ...shading,
  });
}

function normalizeTableSpan(value: number | null | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : 1;
}

/**
 * 把 PM 行内节点序列转成 docx ParagraphChild 数组(同步)。
 * inlineMath 节点从预渲染的 mathImages map 查图片;图片不存在(Chromium 不可用)时降级为等宽文本。
 */
export function pmInlineToDocx(
  content: readonly PmInlineNode[] = [],
  base: Partial<DocxTextStyle> = {},
  mathImages: MathImages = new Map(),
  footnoteNumbers: ReadonlyMap<string, number> = new Map(),
  availableWidthTwips = DOCX_CONTENT_WIDTH_TWIPS,
): ParagraphChild[] {
  return content.flatMap((node) => {
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (node.type === "inlineMath") {
      return [latexToDocxRun(node.attrs.latex, false, mathImages, availableWidthTwips)];
    }
    if (node.type === "footnoteReference") {
      return [new FootnoteReferenceRun(footnoteNumbers.get(node.attrs.id) ?? 0)];
    }
    return [pmTextNodeToDocx(node.text, node.marks ?? [], base)];
  });
}

// latexToDocxMath(假 OMML)已删:blockMath/inlineMath 走 KaTeX→PNG 图片管线(mathImages)
function numberingLevels(
  kind: "bullet" | "ordered",
  listStyle: PmOrderedListStyle = "decimal",
  start = 1,
) {
  const bulletText = ["•", "◦", "▪", "•", "◦", "▪"];
  return Array.from({ length: 6 }, (_, level) => ({
    level,
    format: kind === "bullet" ? LevelFormat.BULLET : orderedListLevelFormat(listStyle),
    text: kind === "bullet" ? bulletText[level] : `%${level + 1}.`,
    ...(kind === "ordered" ? { start } : {}),
    style: {
      paragraph: {
        indent: { left: 360 * (level + 1), hanging: 260 },
      },
    },
  }));
}

function normalizeOrderedListStyle(value: string | null | undefined): PmOrderedListStyle {
  return value && value in ORDERED_NUMBERING_BY_STYLE ? (value as PmOrderedListStyle) : "decimal";
}

function normalizeOrderedListStart(value: number | null | undefined): number {
  // OOXML 的 w:start 使用有符号 ST_DecimalNumber，0 与负整数都可原样表达。
  return typeof value === "number" && Number.isInteger(value) ? value : 1;
}

function orderedListLevelFormat(style: PmOrderedListStyle): (typeof LevelFormat)[keyof typeof LevelFormat] {
  switch (style) {
    case "lower-alpha":
      return LevelFormat.LOWER_LETTER;
    case "upper-alpha":
      return LevelFormat.UPPER_LETTER;
    case "lower-roman":
      return LevelFormat.LOWER_ROMAN;
    case "upper-roman":
      return LevelFormat.UPPER_ROMAN;
    case "decimal":
    default:
      return LevelFormat.DECIMAL;
  }
}

type DocxTextStyle = {
  bold: boolean;
  italics: boolean;
};
type PmHighlightColor = Extract<PmMark, { type: "highlight" }>["attrs"]["color"];

function pmTextNodeToDocx(text: string, marks: readonly PmMark[], base: Partial<DocxTextStyle>): ParagraphChild {
  const link = marks.find((mark) => mark.type === "link");
  const options = marks.reduce<Record<string, unknown>>(
    (acc, mark) => {
      switch (mark.type) {
        case "bold":
          acc.bold = true;
          break;
        case "italic":
          acc.italics = true;
          break;
        case "underline":
          acc.underline = { type: UnderlineType.SINGLE };
          break;
        case "strike":
          acc.strike = true;
          break;
        case "code":
          acc.font = "Courier New";
          acc.shading = { type: ShadingType.CLEAR, fill: "F1F5F9" };
          break;
        case "highlight":
          acc.highlight = highlightToDocx(mark.attrs.color);
          acc.shading = { type: ShadingType.CLEAR, fill: highlightFill(mark.attrs.color) };
          break;
        case "textColor":
          // 文字色:此前 docx 导出丢失(回归 table-cell-color/文字色)。color 为 6 位 hex 无 #。
          if (isAllowedThemeColor(mark.attrs.color)) {
            acc.color = PM_THEME_TEXT_COLOR_VALUES[mark.attrs.color as PmThemeColor].slice(1);
          }
          break;
        case "link":
          acc.color = "2563EB";
          acc.underline = { type: UnderlineType.SINGLE };
          break;
      }
      return acc;
    },
    { text, font: FONT, ...base },
  );

  const run = new TextRun(options as IRunOptions);
  if (link?.type === "link" && /^https?:\/\//i.test(link.attrs.href)) {
    return new ExternalHyperlink({ link: link.attrs.href, children: [run] });
  }
  return run;
}

function headingLevelToDocx(level: 1 | 2 | 3 | 4 | 5 | 6): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    case 6:
      return HeadingLevel.HEADING_6;
  }
}

function alignmentToDocx(align: string | null | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (align) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    case "left":
    default:
      return undefined;
  }
}

function highlightToDocx(color: PmHighlightColor) {
  switch (color) {
    case "green":
      return HighlightColor.GREEN;
    case "blue":
      return HighlightColor.CYAN;
    case "pink":
    case "purple":
      return HighlightColor.MAGENTA;
    case "yellow":
    default:
      return HighlightColor.YELLOW;
  }
}

// Callout 10 主题在白底 DOCX 上的浅色填充(对应前端暖墨配色的去饱和版)。
function calloutFill(tone: string | null | undefined): string {
  switch (tone) {
    case "success": return "E6EFE2";
    case "warning": return "F5ECD6";
    case "ochre": return "F2E8D8";
    case "danger": return "F5E3DE";
    case "rose": return "F3E5E7";
    case "mauve": return "EFE6F0";
    case "indigo": return "E6E7F1";
    case "info": return "E8EEF6";
    case "teal": return "E2EEEB";
    case "neutral":
    default:
      return "EFEBE4";
  }
}

function highlightFill(color: PmHighlightColor): string {
  switch (color) {
    case "green":
      return "D4EDD4";
    case "blue":
      return "CFE0F5";
    case "pink":
      return "F5D0CF";
    case "purple":
      return "E7D7FF";
    case "yellow":
    default:
      return "FFF3A3";
  }
}

function pmInlineText(content: readonly { type: string; text?: string }[]): string {
  return content.map((node) => (node.type === "hardBreak" ? "\n" : node.text ?? "")).join("");
}

function twipsToPixels(twips: number): number {
  return Math.max(1, twips / DOCX_TWIPS_PER_PIXEL);
}

function imageSize(
  section: Extract<LegacySection, { kind: "image" }>,
  availableWidthTwips: number,
): { width: number; height: number } {
  const naturalWidth = section.data.width ?? 800;
  const naturalHeight = section.data.height ?? 450;
  const width = Math.min(480, twipsToPixels(availableWidthTwips), naturalWidth);
  const height = Math.max(1, Math.round((width * naturalHeight) / naturalWidth));
  return { width, height };
}

function dataImage(section: Extract<LegacySection, { kind: "image" }>): { buffer: Buffer; type: "png" | "jpg" | "gif" | "bmp" } | null {
  const match = section.data.src.match(/^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const type = match[1]!.toLowerCase() === "jpeg" ? "jpg" : match[1]!.toLowerCase();
  return { buffer: Buffer.from(match[2]!, "base64"), type: type as "png" | "jpg" | "gif" | "bmp" };
}

async function imageRun(
  section: Extract<LegacySection, { kind: "image" }>,
  availableWidthTwips = DOCX_CONTENT_WIDTH_TWIPS,
  reportDegradation?: ReportExportDegradation,
): Promise<ImageRun | null> {
  const size = imageSize(section, availableWidthTwips);
  const data = dataImage(section);
  if (data) {
    return new ImageRun({
      type: data.type,
      data: data.buffer,
      transformation: size,
      altText: { name: section.data.alt, title: section.data.alt, description: section.data.caption ?? section.data.alt },
    });
  }

  const src = section.data.src;
  // svg 只从 data:image/svg+xml 或本地 .svg 取;绝不把栅格图当文本读成 svg。
  // DOCX 不能可靠渲染 SVG,用 headless Chromium 把 SVG 栅格成 PNG 再嵌入(比 sharp 更稳、字体一致)。
  const isSvgSrc = /^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#].*)?$/i.test(src);
  if (isSvgSrc) {
    const svg = /^data:image\/svg\+xml/i.test(src)
      ? src
      : readLocalUploadText(src);
    if (!svg) return null;
    const raster = await rasterizeSvgToPng(svg);
    if (!raster) return null;
    reportDegradation?.("svg-rasterized");
    // 等比缩放到整页上限或当前栏宽,保留 SVG 栅格后的真实像素比例。
    const width = Math.min(480, twipsToPixels(availableWidthTwips), raster.width);
    const height = Math.max(1, Math.round((raster.height * width) / raster.width));
    return new ImageRun({
      type: "png",
      data: raster.data,
      transformation: { width, height },
      altText: { name: section.data.alt, title: section.data.alt, description: section.data.caption ?? section.data.alt },
    });
  }

  // 本地上传的栅格图:按扩展名读 buffer 直接内嵌(docx 支持 png/jpg/gif/bmp)。
  const ext = src.match(/\.(png|jpe?g|gif|bmp)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  const buffer = ext ? readLocalUploadBuffer(src) : null;
  if (buffer && ext) {
    return new ImageRun({
      type: (ext === "jpeg" ? "jpg" : ext) as "png" | "jpg" | "gif" | "bmp",
      data: buffer,
      transformation: size,
      altText: { name: section.data.alt, title: section.data.alt, description: section.data.caption ?? section.data.alt },
    });
  }
  return null;
}

async function sectionToDocx(
  section: LegacySection,
  numbering: DocxNumberingRegistry,
  sourceNormalized = false,
  availableWidthTwips = DOCX_CONTENT_WIDTH_TWIPS,
  reportDegradation?: ReportExportDegradation,
): Promise<Array<Paragraph | Table>> {
  switch (section.kind) {
    case "diagram": {
      const typeLabel = section.data.lang === "drawio" ? "draw.io" : "Mermaid";
      const viewerAction = section.data.lang === "drawio" ? "draw.io 查看" : "Mermaid 编辑器查看";
      const fallbackNotice = (oversized: boolean) => new Paragraph({
        children: [new TextRun({
          text: section.data.lang === "drawio"
            ? drawioFallbackMessage(oversized, sourceNormalized)
            : oversized
              ? `${typeLabel} 图表过大，以下为源码（可复制到 ${viewerAction}）`
              : `${typeLabel} 图表源码（未能生成预览，可复制到 ${viewerAction}）`,
          font: FONT,
          size: 18,
          color: "666666",
        })],
        shading: { type: ShadingType.CLEAR, fill: "F2F0EB" },
        spacing: { after: 80 },
      });
      // svg 看起来合法且不超大才走图片(sharp svg→png);失败/无 svg 一律回退源码代码块,
      // 绝不丢 Mermaid 源码(原先 sharp 失败会落到 [图: 图表] 占位,源码尽失)。
      if (section.data.svg && svgExceedsExportByteLimit(section.data.svg)) {
        return [
          fallbackNotice(true),
          ...await sectionToDocx(
            { kind: "code", data: { body: section.data.source, language: section.data.lang } },
            numbering,
            false,
            availableWidthTwips,
            reportDegradation,
          ),
        ];
      }
      if (isRenderableSvg(section.data.svg)) {
        const run = await imageRun(
          {
            kind: "image",
            data: { src: `data:image/svg+xml,${encodeURIComponent(section.data.svg)}`, alt: "图表", caption: null, width: null, height: null },
          },
          availableWidthTwips,
          reportDegradation,
        );
        if (run) return [new Paragraph({ children: [run], spacing: { after: 180 } })];
      }
      return [
        fallbackNotice(false),
        ...await sectionToDocx(
          { kind: "code", data: { body: section.data.source, language: section.data.lang } },
          numbering,
          false,
          availableWidthTwips,
          reportDegradation,
        ),
      ];
    }
    case "quote":
      return [
        new Paragraph({
          text: section.data.text,
          indent: { left: 360 },
          spacing: { before: 80, after: 80 },
        }),
      ];
    case "hr":
      return [horizontalRuleParagraph()];
    case "list": {
      const reference = section.data.ordered
        ? numbering.referenceFor(section, "decimal", 1)
        : BULLET_NUMBERING;
      return section.data.items.map(
        (it) =>
          new Paragraph({
            children: [new TextRun({ text: it, font: FONT })],
            numbering: {
              reference,
              level: 0,
            },
          }),
      );
    }
    case "h1":
      return [
        new Paragraph({
          text: sectionText(section),
          heading: HeadingLevel.HEADING_1,
        }),
      ];
    case "h2":
      return [
        new Paragraph({
          text: sectionText(section),
          heading: HeadingLevel.HEADING_2,
        }),
      ];
    case "p":
    case "penNote":
      return sectionText(section)
        .split(/\n{2,}/)
        .filter(Boolean)
        .map(
          (text) =>
            new Paragraph({
              children: [new TextRun({ text, font: FONT })],
              spacing: { after: 180 },
            }),
        );
    case "code":
      return [
        new Paragraph({
          children: [new TextRun({ text: section.data.body.trim(), font: FONT })],
          spacing: { after: 180 },
        }),
      ];
    case "table":
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: section.data.head.map(
                (cell) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: cell, bold: true, font: FONT })],
                      }),
                    ],
                  }),
              ),
            }),
            ...section.data.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [new TextRun({ text: cell, font: FONT })],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
      ];
    case "image": {
      const rawSvg = /^data:image\/svg\+xml/i.test(section.data.src)
        ? decodeSvgDataUrl(section.data.src)
        : /\.svg(?:[?#].*)?$/i.test(section.data.src)
          ? readLocalUploadText(section.data.src)
          : null;
      if (rawSvg && svgExceedsExportByteLimit(rawSvg)) {
        return [
          new Paragraph({
            children: [new TextRun({ text: `[图过大未导出：${section.data.alt}]`, font: FONT })],
            spacing: { after: 180 },
          }),
        ];
      }
      const run = await imageRun(section, availableWidthTwips, reportDegradation);
      const caption = section.data.caption ?? section.data.alt;
      if (!run) {
        return [
          new Paragraph({
            children: [new TextRun({ text: `[图片：${section.data.alt}]`, font: FONT })],
            spacing: { after: 180 },
          }),
        ];
      }
      return [
        new Paragraph({ children: [run], spacing: { after: caption ? 60 : 180 } }),
        ...(caption
          ? [
              new Paragraph({
                children: [new TextRun({ text: caption, font: FONT, italics: true })],
                spacing: { after: 180 },
              }),
            ]
          : []),
      ];
    }
  }
}
