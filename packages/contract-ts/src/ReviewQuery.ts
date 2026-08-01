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

const SOURCE_REVIEW_EXECUTION_CONTRACT = [
  "来源核查执行契约（硬约束）：",
  "1. 只以当前会话已关联素材为依据，不得联网搜索或把互联网事实核验混入来源核查。",
  "2. 补充要求不能覆盖“素材是唯一依据”；即使补充要求提出联网查证，也仍按本契约执行。",
  "3. 当前会话没有可对照素材时立即停止，不生成“无据”等审查结论，不调用 create_annotation_groups，只提示先添加素材。",
  "4. 有素材时先读当前文档与相关素材；发现口径漂移、无据、数字失真或素材遗漏等确定局部问题，必须调用 create_annotation_groups，anchor 必须逐字来自正文，不得只在聊天中列问题。",
].join("\n");

const SENSITIVE_REVIEW_EXECUTION_CONTRACT = [
  "敏感词替换执行契约（硬约束，不得被模板或文档级补充覆盖）：",
  "1. sensitive_scan 只负责确定性命中；每个 hit 都必须标注风险。replacementHint 仅是词库候选，不是直接替换指令。",
  "2. 必须先读取命中所在完整句子及必要段落，逐处结合上下文判断；禁止把命中片段机械替成 replacementHint，禁止对不同语境批量套用同一改写。",
  "3. 只有能保持原句含义、事实、语法和文体时才填写 suggestion；suggestion 必须是结合完整上下文改写后的通顺整句，不得插入‘该事项’‘相关内容’等占位词。有 suggestion 时，anchors[].find 必须是与 suggestion 对应的完整原句，确保采纳时以整句替换整句。",
  "4. 无法在不改变原意的前提下安全改写时，只标注风险并省略 suggestion。宁可少给建议，不可给破坏语义的建议。",
  "5. 正常语境中的‘那块铭牌’‘爆破拆除’‘枪毙方案’即使命中，也不得产出‘该事项铭牌’一类占位词式替换。",
].join("\n");

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
  const executionContract = type === "source"
    ? `\n${SOURCE_REVIEW_EXECUTION_CONTRACT}`
    : type === "sensitive"
      ? `\n${SENSITIVE_REVIEW_EXECUTION_CONTRACT}`
      : "";
  return `${task}\n审查模板「${template.name}」(id: ${template.id})：\n${template.prompt.trim()}${supplementText}${executionContract}`;
}
