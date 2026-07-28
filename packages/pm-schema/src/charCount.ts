import type { PmDoc } from "./types";
import { pmToPlainText } from "./pmToPlainText";

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
  return countVisibleChars(pmToPlainText(doc, { skipMedia: true, skipTaskMarkers: true }));
}
