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
  | { type: "highlight"; color: PmThemeColor };

export type AiRun = {
  text: string;
  marks?: Array<AiRunMark>;
};

export type AiBlock =
  | { type: "paragraph"; runs: Array<AiRun>; textAlign?: "left" | "center" | "right" | "justify" }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Array<AiRun>; textAlign?: "left" | "center" | "right" | "justify" }
  | { type: "blockquote"; runs: Array<AiRun> }
  | { type: "codeBlock"; language?: string | null; text: string }
  | { type: "bulletList"; items: Array<Array<AiRun>> }
  | { type: "orderedList"; items: Array<Array<AiRun>> }
  | { type: "horizontalRule" }
  | { type: "table"; rows: Array<{ cells: Array<{ runs: Array<AiRun>; header?: boolean }> }> }
  | { type: "image"; src: string; alt?: string | null; caption?: string | null; width?: number | null; height?: number | null; align?: "left" | "center" | "right" | null }
  | { type: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  | { type: "penNote"; runs: Array<AiRun> };

export type AiDocument = {
  title?: string | null;
  blocks: Array<AiBlock>;
};
