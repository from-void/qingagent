import { NEW_SESSION_SUGGESTIONS } from "./suggestions";

// 右侧 card-swap 的 4 张模板卡数据。
// 回填文案(fill)直接复用 NEW_SESSION_SUGGESTIONS 的原文(单一真相),
// 此处只补 cc-b 版面需要的副标题 / 用途说明 / 线性图标。

export type TemplateIconId = "brush" | "target" | "link" | "doc";

export interface TemplateEntry {
  /** 模板标题(同 suggestions.title)。 */
  name: string;
  /** 副标题(四字短语)。 */
  sub: string;
  /** hover 说明:这个模板干嘛的。 */
  use: string;
  /** 点击回填到左侧输入框的文案(复用 suggestions.text)。 */
  fill: string;
  icon: TemplateIconId;
}

const META: { sub: string; use: string; icon: TemplateIconId }[] = [
  { sub: "自由写作", use: "给一个题目，写成一篇文章。", icon: "brush" },
  { sub: "查资料再写", use: "先查最新资料，再写成稿。", icon: "target" },
  { sub: "析文提风", use: "分析网址内容与文体,提炼风格。", icon: "link" },
  { sub: "浓缩重写", use: "把文档提炼浓缩,重写成文。", icon: "doc" },
];

export const NEW_SESSION_TEMPLATES: TemplateEntry[] = NEW_SESSION_SUGGESTIONS.map((s, i) => ({
  name: s.title,
  fill: s.text,
  sub: META[i]?.sub ?? "",
  use: META[i]?.use ?? "",
  icon: META[i]?.icon ?? "brush",
}));
