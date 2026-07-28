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
  const body = pmToMarkdown(doc, { baseUrl: options.baseUrl }).trim();
  const title = normalizeMarkdownTitle(options.title);
  if (!title) return body;
  // 正文开头已是同名 H1 就不再加一遍。用结构层 documentLeadsWithTitle(忽略 bold/italic
  // 等 mark)而非在渲染后的 markdown 字符串上 startsWith——后者遇 `# **标题**` 粗体包裹会漏判
  // 导致重复 H1。requireLevel1:首块是同名 H2 时仍补 H1(保持既有 Markdown 行为,只修粗体 H1 漏判)。
  return documentLeadsWithTitle(document, title, { requireLevel1: true })
    ? body
    : `# ${escapeCommonMarkText(title)}\n\n${body}`.trim();
}

function normalizeMarkdownTitle(title: string | undefined): string {
  return title?.replace(/\r\n?|\n/g, " ").trim() ?? "";
}

function escapeCommonMarkText(text: string): string {
  // CommonMark 允许用反斜杠转义所有 ASCII 标点；覆盖链接、强调、代码、HTML 等行内语法，
  // 让产品中的纯文本标题在导出后仍保持字面含义。
  return text.replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, "\\$&");
}
