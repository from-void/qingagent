import type { PmDoc } from "@qingagent/pm-schema";
import {
  isPmDocDocument,
  pmDocToPlainExportText,
  sectionText,
  type ExportDocument,
  type ExportOptions,
} from "./shared.js";
import { collectExportFootnotes } from "./footnotes.js";

export function toTxt(document: ExportDocument, _options: ExportOptions = {}): string {
  if (isPmDocDocument(document)) {
    const footnotes = collectExportFootnotes(document);
    const body = pmDocToPlainExportText(replaceFootnotesWithTextRefs(document, footnotes.numberById));
    if (footnotes.definitions.length === 0) return body;
    const definitions = footnotes.definitions
      .map(({ number, note }) => `[${number}] ${note}`)
      .join("\n");
    return `${body}\n\n脚注\n${definitions}`;
  }
  return document
    .map(sectionText)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function replaceFootnotesWithTextRefs(
  doc: PmDoc,
  numberById: ReadonlyMap<string, number>,
): PmDoc {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.type === "footnoteReference") {
      const attrs = node.attrs as { id?: unknown } | undefined;
      return {
        type: "text",
        text: `[${numberById.get(String(attrs?.id ?? "")) ?? 0}]`,
      };
    }
    return {
      ...node,
      ...(Array.isArray(node.content) ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc) as PmDoc;
}
