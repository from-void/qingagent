import type { PmThemeColor } from "./PmMark";

export type AiRunMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "strikeThrough" }
  | { type: "code" }
  | { type: "link"; href: string; title?: string | null }
  | { type: "textColor"; color: PmThemeColor }
  | { type: "highlight"; color: PmThemeColor }
  | { type: "math" };

export type AiRun = {
  text: string;
  marks?: Array<AiRunMark>;
};

export type AiListItem = {
  runs: Array<AiRun>;
  children?: Array<AiBlock>;
};

export type AiTaskListItem = {
  checked?: boolean;
  runs: Array<AiRun>;
  children?: Array<AiBlock>;
};

export type AiTableCell = {
  blocks: Array<AiBlock>;
  header?: boolean;
  backgroundColor?: string;
  colspan?: number;
  rowspan?: number;
};

export type AiTableRow = {
  cells: Array<AiTableCell>;
  header?: boolean;
};

export type AiColumn = {
  widthRatio?: number | null;
  blocks: Array<AiBlock>;
};

export type AiBlock =
  | { type: "paragraph"; runs: Array<AiRun>; textAlign?: "left" | "center" | "right" | "justify" }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null; runs: Array<AiRun>; textAlign?: "left" | "center" | "right" | "justify" }
  | { type: "blockquote"; runs: Array<AiRun> }
  | { type: "codeBlock"; language?: string | null; text: string }
  | { type: "bulletList"; items: Array<AiListItem> }
  | { type: "orderedList"; items: Array<AiListItem>; start?: number | null; listStyle?: "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman" | null }
  | { type: "horizontalRule" }
  | { type: "table"; rows: Array<AiTableRow> }
  | { type: "image"; src: string; alt?: string | null; title?: string | null; caption?: string | null; width?: number | null; height?: number | null; align?: "left" | "center" | "right" | null }
  | { type: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  | { type: "penNote"; runs: Array<AiRun> }
  | { type: "taskList"; items: Array<AiTaskListItem> }
  | {
      type: "callout";
      emoji?: string | null;
      tone?: "info" | "success" | "warning" | "danger" | "neutral" | "ochre" | "rose" | "mauve" | "indigo" | "teal" | null;
      runs: Array<AiRun>;
    }
  | { type: "columnList"; columns: Array<AiColumn> }
  | { type: "blockMath"; latex: string }
  | { type: "diagram"; lang: string; source: string; svg?: string | null };

export type AiDocument = {
  title?: string | null;
  blocks: Array<AiBlock>;
};
