import { legacySectionsToPm, pmToMarkdown } from "@qingagent/pm-schema";
import {
  documentLeadsWithTitle,
  isPmDocDocument,
  type ExportDocument,
  type ExportOptions,
} from "./shared.js";

export function toMarkdown(
  document: ExportDocument,
  options: ExportOptions = {},
): string {
  const doc = isPmDocDocument(document)
    ? document
    : legacySectionsToPm(document as never);
  const body = pmToMarkdown(doc).trim();
  const title = options.title?.trim();
  if (!title) return body;
  // 正文开头已是同名 H1 就不再加一遍。用结构层 documentLeadsWithTitle(忽略 bold/italic
  // 等 mark)而非在渲染后的 markdown 字符串上 startsWith——后者遇 `# **标题**` 粗体包裹会漏判
  // 导致重复 H1。requireLevel1:首块是同名 H2 时仍补 H1(保持既有 Markdown 行为,只修粗体 H1 漏判)。
  return documentLeadsWithTitle(document, title, { requireLevel1: true })
    ? body
    : `# ${title}\n\n${body}`.trim();
}
