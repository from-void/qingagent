import type { PmBlockNode, PmDoc, PmNode } from "./types";
import { pmToPlainText } from "./pmToPlainText";

// 这些块即使没有正文文字，现有 Markdown / HTML / DOCX 导出器也会独立输出
// 媒体、结构或视觉元素。与导出器的 PmBlockNode switch 保持同步，不把普通文本
// 容器列进来，避免空段落、空标题等编辑器占位绕过空稿闸。
const EXPORTABLE_NON_TEXT_BLOCK_TYPES: ReadonlySet<PmBlockNode["type"]> = new Set([
  "horizontalRule",
  "table",
  "image",
  "diagram",
  "fileAttachment",
]);

/** 正文可见字符数:NFC 归一化、去全部空白后按码点计数(含中英文、数字、标点)。
 *  全产品统一字数口径的唯一实现——core 的 lengthSpec 与前端字数显示都引用这里,
 *  不要用 String.length(代理对会数错)。 */
export function countVisibleChars(text: string): number {
  const normalized = text.normalize("NFC").replace(/\s+/gu, "");
  return Array.from(normalized).length;
}

/** 不含标点口径:只数 Unicode 字母与数字。 */
export function countCharsNoPunct(text: string): number {
  const normalized = text.normalize("NFC").replace(/\s+/gu, "");
  return Array.from(normalized).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
}

/** 对整篇 PmDoc 按可见字符口径计数(经 pmToPlainText 提取正文)。
 *  全产品「文档字数」的唯一口径:跳过图片 / 图表 / 附件等媒体节点——只算文章文字,
 *  图片里的描述(alt/caption)、图表源码不计入。左侧工具卡与右下角落款都引用本函数,
 *  确保两边数字一致。 */
export function countDocVisibleChars(doc: PmDoc): number {
  return countVisibleChars(pmToPlainText(doc, {
    skipMedia: true,
    skipTaskMarkers: true,
    skipFootnotes: true,
  }));
}

/** 导出空稿闸口径：正文有可见字，或文档含导出器支持的非文本承载块。 */
export function hasExportableDocContent(doc: PmDoc): boolean {
  return countDocVisibleChars(doc) > 0 || containsExportableNonTextBlock(doc);
}

function containsExportableNonTextBlock(node: PmDoc | PmNode): boolean {
  if (
    node.type !== "doc" &&
    EXPORTABLE_NON_TEXT_BLOCK_TYPES.has(node.type as PmBlockNode["type"])
  ) {
    return true;
  }
  if (!("content" in node) || !Array.isArray(node.content)) return false;
  return node.content.some((child) => containsExportableNonTextBlock(child));
}
