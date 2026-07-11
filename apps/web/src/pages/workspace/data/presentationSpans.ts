import { viewDocSpanText } from "./protocol";
import type { ViewBlock } from "./protocol";

type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

const intlWithSegmenter = Intl as typeof Intl & { Segmenter?: SegmenterCtor };

export function splitGraphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (typeof intlWithSegmenter.Segmenter === "function") {
    const segmenter = new intlWithSegmenter.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function visibleReviewSections(sections: readonly ViewBlock[]): ViewBlock[] {
  return sections.filter((section) => section.blockPatch?.op !== "delete");
}

export interface TableCellEntry {
  rowIndex: number;
  cellIndex: number;
  text: string;
}

/** 表头在前、正文在后，坐标始终是 PM table 的物理 child index。 */
export function tableCellEntries(section: ViewBlock): TableCellEntry[] {
  if (section.kind !== "table") return [];
  const rows = section.head.length > 0 ? [section.head, ...section.rows] : section.rows;
  return rows.flatMap((row, rowIndex) =>
    row.map((text, cellIndex) => ({ rowIndex, cellIndex, text })),
  );
}

export function sectionText(section: ViewBlock): string {
  if (section.blockPatch?.op === "delete") return "";
  switch (section.kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "quote":
      return section.spans ? section.spans.map(viewDocSpanText).join("") : section.text;
    case "penNote":
      return section.spans ? section.spans.map(viewDocSpanText).join("") : section.text;
    case "p":
      return section.spans.map(viewDocSpanText).join("");
    case "list":
      return section.items.join("\n");
    case "hr":
      return "";
    case "table":
      return [
        section.head.join("\t"),
        ...section.rows.map((row) => row.join("\t")),
      ].join("\n");
    case "code":
      return section.body;
    case "diagram":
      return section.source;
    case "image":
      return section.caption ?? "";
    case "fileAttachment":
      return section.filename;
    case "taskList":
    case "callout":
    case "columnList":
      return section.text;
    case "math":
      return section.latex;
  }
}
