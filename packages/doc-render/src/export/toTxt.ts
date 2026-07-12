import { isPmDocDocument, pmDocToPlainExportText, sectionText, type ExportDocument } from "./shared.js";

export function toTxt(document: ExportDocument): string {
  if (isPmDocDocument(document)) return pmDocToPlainExportText(document);
  return document
    .map(sectionText)
    .filter((text) => text.length > 0)
    .join("\n\n");
}
