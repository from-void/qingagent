import type { ReviewTemplateItem, ReviewType } from "./ReviewTemplates";

const REVIEW_TITLES: Record<ReviewType, string> = {
  sensitive: "敏感词审查",
  deai: "去AI味",
  source: "来源核查",
  consistency: "一致性审查",
  privacy: "隐私泄露审查",
  format: "格式规范审查",
  role: "角色审查",
  custom: "自定义审查",
};

/**
 * Web 菜单与 external review/run 共用的审查指令装配。
 * 此处文案是模型输入契约，调用侧不得再拼接或改写。
 */
export function assembleReviewQuery(
  type: ReviewType,
  template: Pick<ReviewTemplateItem, "id" | "name" | "prompt">,
  supplement: string,
  lexicons: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  const task = type === "sensitive"
    ? `对当前文档做敏感词审查。启用词库：${lexicons.map((item) => `「${item.name}」(id: ${item.id})`).join("、") || "无"}。`
    : type === "deai"
      ? "对当前文档做去AI味审查。"
      : `对当前文档做${REVIEW_TITLES[type]}。`;
  const supplementText = supplement.trim()
    ? `\n文档级补充要求（只适用于当前文档）：${supplement.trim()}`
    : "";
  return `${task}\n审查模板「${template.name}」(id: ${template.id})：\n${template.prompt.trim()}${supplementText}`;
}
