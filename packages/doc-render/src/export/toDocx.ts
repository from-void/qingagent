import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IRunOptions,
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
import { documentLeadsWithTitle, drawioFallbackMessage, isDrawioExportSourceNormalized, isPmDocDocument, isRenderableSvg, readLocalUploadBuffer, readLocalUploadText, sectionText, svgExceedsExportByteLimit, type ExportDocument, type ExportOptions } from "./shared.js";
import { withRenderedDiagrams } from "./mermaidServer.js";
import { rasterizeMathBatch, rasterizeSvgToPng } from "./rasterize.js";

// ——— 公式图片预渲染 ———

/** 用于在 toDocx 内传递预渲染好的公式图片(latex:displayMode → ImageRun) */
type MathImages = ReadonlyMap<string, ImageRun | null>;

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
 * 批量渲染公式为 ImageRun,失败则映射到 null(调用方降级为等宽文本)。
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
  const map = new Map<string, ImageRun | null>();
  for (let i = 0; i < formulas.length; i++) {
    const { latex, displayMode } = formulas[i]!;
    const raster = rasters[i];
    if (!raster) { map.set(mathKey(latex, displayMode), null); continue; }
    // 块级公式宽度上限 400px,行内公式高度上限 28px(避免撑开行距)
    let width: number;
    let height: number;
    if (displayMode) {
      width = Math.min(400, raster.width);
      height = Math.max(1, Math.round((raster.height * width) / raster.width));
    } else {
      const maxH = 28;
      height = Math.min(maxH, raster.height);
      width = Math.max(1, Math.round((raster.width * height) / raster.height));
    }
    map.set(mathKey(latex, displayMode), new ImageRun({
      type: "png",
      data: raster.data,
      transformation: { width, height },
      altText: { name: latex, title: "公式", description: latex },
    }));
  }
  return map;
}

/** LaTeX → docx ParagraphChild:先查预渲染 map,失败降级为等宽文本。 */
function latexToDocxRun(latex: string, displayMode: boolean, mathImages: MathImages): ParagraphChild {
  const img = mathImages.get(mathKey(latex, displayMode));
  // img===undefined:key 不在 map(不应发生),img===null:渲染失败
  if (img) return img;
  return new TextRun({ text: latex, font: "Courier New" });
}

const FONT = "Noto Sans CJK SC";
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
  // 先补渲染缺缓存的 Mermaid；drawio 只消费客户端持久化的安全 SVG 缓存。
  // DOCX 再把可用 SVG 栅格成 PNG 嵌入，缺失/失败则按 W4 设计回退源码。
  const prepared = await withRenderedDiagrams(document);
  // 批量预渲染文档中所有数学公式(单个 Chromium 上下文,避免逐公式开关上下文)。
  const mathImages = isPmDocDocument(prepared)
    ? await buildMathImages(collectMathFormulas(prepared))
    : new Map<string, ImageRun | null>();
  const numbering = createDocxNumberingRegistry();
  const sectionChildren = isPmDocDocument(prepared)
    ? await pmDocToDocx(prepared, mathImages, numbering)
    : (await Promise.all(prepared.map((section) =>
        sectionToDocx(
          section,
          numbering,
          section.kind === "diagram" && isDrawioExportSourceNormalized(section.data),
        ),
      ))).flat();
  const title = options.title?.trim();
  const children = [
    // 正文开头已是同名标题就不再加一遍(去重),避免两个标题
    ...(title && !documentLeadsWithTitle(prepared, title)
      ? [
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
          }),
        ]
      : []),
    ...sectionChildren,
  ];

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
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

async function pmDocToDocx(
  doc: PmDoc,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
): Promise<Array<Paragraph | Table>> {
  return (await Promise.all(doc.content.map((node) => pmBlockToDocx(node, 0, {}, mathImages, numbering)))).flat();
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

async function pmBlockToDocx(
  node: PmBlockNode,
  depth: number,
  opts: { inQuote?: boolean },
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
): Promise<Array<Paragraph | Table>> {
  const quoteDeco = opts.inQuote ? QUOTE_PARAGRAPH_DECORATION : {};
  switch (node.type) {
    case "columnList":
      return (
        await Promise.all(
          node.content.map((column) =>
            Promise.all(column.content.map((child) => pmBlockToDocx(child, depth, {}, mathImages, numbering))),
          ),
        )
      ).flat(2);
    case "diagram":
      // 图表块:有渲染好的 svg 就当图片嵌入(走 image 的 svg→png 路径),否则源码降级为 code 块。
      return sectionToDocx(
        { kind: "diagram", data: { lang: node.attrs.lang, source: node.attrs.source, svg: node.attrs.svg } },
        numbering,
        isDrawioExportSourceNormalized(node.attrs),
      );
    case "heading":
      return [
        new Paragraph({
          children: pmInlineToDocx(node.content ?? [], {bold: true}, mathImages),
          heading: headingLevelToDocx(node.attrs.level),
          alignment: alignmentToDocx(node.attrs.textAlign),
          ...quoteDeco,
        }),
      ];
    case "paragraph":
      return [
        new Paragraph({
          children: pmInlineToDocx(node.content ?? [], {}, mathImages),
          alignment: alignmentToDocx(node.attrs.textAlign),
          spacing: { after: 180 },
          ...quoteDeco,
        }),
      ];
    case "penNote":
      return [
        new Paragraph({
          children: pmInlineToDocx(node.content ?? [], { italics: true }, mathImages),
          spacing: { after: 180 },
        }),
      ];
    case "blockquote":
      // 把 inQuote 透传给子块,使引用内的段落/标题带上引用视觉装饰。
      return (await Promise.all(node.content.map((child) => pmBlockToDocx(child, depth, { inQuote: true }, mathImages, numbering)))).flat();
    case "bulletList":
      return (await Promise.all(node.content.map((item) => pmListItemToDocx(item.content, BULLET_NUMBERING, depth, mathImages, numbering)))).flat();
    case "orderedList": {
      const reference = numbering.referenceFor(node, node.attrs.listStyle, node.attrs.start);
      return (await Promise.all(node.content.map((item) => pmListItemToDocx(item.content, reference, depth, mathImages, numbering)))).flat();
    }
    case "horizontalRule":
      return [new Paragraph({ text: "————————", spacing: { after: 180 } })];
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
              children: await Promise.all(row.content.map((cell) => pmTableCellToDocx(cell, mathImages, numbering))),
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
                ...pmInlineToDocx(child.content ?? [], {}, mathImages),
              ],
              indent: { left: depth * 360 },
              spacing: { after: 120 },
            }));
          } else if (child.type === "taskList") {
            children.push(...await pmBlockToDocx(child, depth + 1, {}, mathImages, numbering));
          } else {
            children.push(...await pmBlockToDocx(child, depth, {}, mathImages, numbering));
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
            ...pmInlineToDocx(child.content ?? [], {}, mathImages),
          ],
          shading: { type: ShadingType.CLEAR, fill },
          spacing: { after: 120 },
        }),
      );
    }
    case "blockMath": {
      const run = latexToDocxRun(node.attrs.latex, true, mathImages);
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

async function pmListItemToDocx(
  content: readonly PmBlockNode[],
  reference: string,
  depth: number,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  for (const child of content) {
    if (child.type === "paragraph" || child.type === "heading" || child.type === "penNote") {
      children.push(new Paragraph({
        children: pmInlineToDocx(child.content ?? [], {}, mathImages),
        numbering: { reference, level: Math.min(depth, 5) },
        spacing: { after: 120 },
      }));
      continue;
    }
    if (child.type === "bulletList") {
      children.push(...await pmBlockToDocx(child, depth + 1, {}, mathImages, numbering));
      continue;
    }
    if (child.type === "orderedList") {
      children.push(...await pmBlockToDocx(child, depth + 1, {}, mathImages, numbering));
      continue;
    }
    children.push(...await pmBlockToDocx(child, depth, {}, mathImages, numbering));
  }
  return children;
}

async function pmTableCellToDocx(
  cell: PmTableCellNode,
  mathImages: MathImages,
  numbering: DocxNumberingRegistry,
): Promise<TableCell> {
  const children = (await Promise.all(cell.content.map((child) => pmBlockToDocx(child, 0, {}, mathImages, numbering)))).flat();
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
): ParagraphChild[] {
  return content.flatMap((node) => {
    if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (node.type === "inlineMath") return [latexToDocxRun(node.attrs.latex, false, mathImages)];
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
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
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

function imageSize(section: Extract<LegacySection, { kind: "image" }>): { width: number; height: number } {
  const naturalWidth = section.data.width ?? 800;
  const naturalHeight = section.data.height ?? 450;
  const width = Math.min(480, naturalWidth);
  const height = Math.max(1, Math.round((width * naturalHeight) / naturalWidth));
  return { width, height };
}

function dataImage(section: Extract<LegacySection, { kind: "image" }>): { buffer: Buffer; type: "png" | "jpg" | "gif" | "bmp" } | null {
  const match = section.data.src.match(/^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const type = match[1]!.toLowerCase() === "jpeg" ? "jpg" : match[1]!.toLowerCase();
  return { buffer: Buffer.from(match[2]!, "base64"), type: type as "png" | "jpg" | "gif" | "bmp" };
}

async function imageRun(section: Extract<LegacySection, { kind: "image" }>): Promise<ImageRun | null> {
  const size = imageSize(section);
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
    // 等比缩放到最大宽 480pt,保留长宽比(用 SVG 渲染后的真实像素比例)。
    const width = Math.min(480, raster.width);
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
          ...await sectionToDocx({ kind: "code", data: { body: section.data.source, language: section.data.lang } }, numbering),
        ];
      }
      if (isRenderableSvg(section.data.svg)) {
        const run = await imageRun({
          kind: "image",
          data: { src: `data:image/svg+xml,${encodeURIComponent(section.data.svg)}`, alt: "图表", caption: null, width: null, height: null },
        });
        if (run) return [new Paragraph({ children: [run], spacing: { after: 180 } })];
      }
      return [
        fallbackNotice(false),
        ...await sectionToDocx({ kind: "code", data: { body: section.data.source, language: section.data.lang } }, numbering),
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
      return [new Paragraph({ text: "─".repeat(30) })];
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
      const run = await imageRun(section);
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
