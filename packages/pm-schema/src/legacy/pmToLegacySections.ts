import { pmToPlainText } from "../pmToPlainText";
import type { PmBlockNode, PmDoc, PmTableCellNode, PmTableNode } from "../types";
import type { LegacyLegacySection } from "./legacySectionsToPm";

export function pmToLegacySections(doc: PmDoc): LegacyLegacySection[] {
  return doc.content.map(blockToLegacy).flat();
}

function blockToLegacy(node: PmBlockNode): LegacyLegacySection | LegacyLegacySection[] {
  switch (node.type) {
    case "heading":
      if (node.attrs.level === 1) return { kind: "h1", data: { text: inlineText(node.content ?? []) } };
      if (node.attrs.level === 2) {
        return { kind: "h2", data: { text: inlineText(node.content ?? []), anchor: node.attrs.anchor ?? null } };
      }
      return { kind: "p", data: { text: inlineText(node.content ?? []) } };
    case "paragraph":
      return { kind: "p", data: { text: inlineText(node.content ?? []) } };
    case "blockquote":
      return { kind: "quote", data: { text: node.content.map((child) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [child] })).join("\n") } };
    case "horizontalRule":
      return { kind: "hr", data: {} };
    case "bulletList":
    case "orderedList":
      return {
        kind: "list",
        data: {
          ordered: node.type === "orderedList",
          items: node.content.map((item) => item.content.map((child) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [child] })).join("\n")),
        },
      };
    case "table":
      return tableToLegacy(node);
    case "codeBlock":
      return { kind: "code", data: { body: inlineText(node.content ?? []), language: node.attrs.language ?? null } };
    case "penNote":
      return { kind: "penNote", data: { text: inlineText(node.content ?? []) } };
    case "image":
      return {
        kind: "image",
        data: {
          src: node.attrs.src,
          alt: node.attrs.alt ?? "",
	          caption: node.attrs.caption ?? null,
	          width: node.attrs.width ?? null,
	          height: node.attrs.height ?? null,
	          align: node.attrs.align ?? "center",
	        },
	      };
    case "fileAttachment":
      return { kind: "p", data: { text: `附件：${node.attrs.filename}` } };
    case "taskList":
      // legacy 视图无待办语义,降级为 checkbox 记号列表。
      return {
        kind: "list",
        data: {
          ordered: false,
          items: node.content.map(
            (item) =>
              `${item.attrs.checked ? "[x]" : "[ ]"} ${item.content
                .map((child) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [child] }))
                .join("\n")}`,
          ),
        },
      };
    case "callout":
      return {
        kind: "quote",
        data: {
          text: node.content
            .map((child) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [child] }))
            .join("\n"),
        },
      };
    case "columnList":
      // legacy 无分栏概念 → 拍平:各栏内的块按顺序展开成独立 section(布局有损,内容不丢)。
      return node.content.flatMap((col) => col.content.flatMap(blockToLegacy));
    case "blockMath":
      return { kind: "code", data: { body: node.attrs.latex, language: "latex" } };
    case "diagram":
      return { kind: "diagram", data: { lang: node.attrs.lang, source: node.attrs.source, svg: node.attrs.svg ?? null } };
  }
}

function inlineText(content: readonly { type: string; text?: string }[]): string {
  return content.map((node) => (node.type === "hardBreak" ? "\n" : node.text ?? "")).join("");
}

function tableToLegacy(node: PmTableNode): LegacyLegacySection {
  const [firstRow, ...restRows] = node.content;
  const firstIsHeader = firstRow?.content.every((cell) => cell.type === "tableHeader") ?? false;
  const head = firstIsHeader && firstRow ? firstRow.content.map(cellText) : [];
  const rows = (firstIsHeader ? restRows : node.content).map((row) => row.content.map(cellText));
  return { kind: "table", data: { head, rows } };
}

function cellText(cell: PmTableCellNode): string {
  return cell.content.map((node) => pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [node] })).join("\n");
}
