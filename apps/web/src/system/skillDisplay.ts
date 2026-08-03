export interface SkillDisplaySource {
  name: string;
  displayName?: string;
  label: string;
  summary: string;
  description: string;
  icon: string;
  placeholder?: string;
  enabled: boolean;
  userInvocable: boolean;
  source?: string;
}

export interface SkillDisplay {
  id: string;
  label: string;
  description: string;
  fullDescription: string;
  placeholder: string;
  icon: string;
}

interface LocalizedSkillMetadata {
  displayName: string;
  summary: string;
}

const CODEX_BUILTIN_SKILL_METADATA: Readonly<Record<string, LocalizedSkillMetadata>> = {
  imagegen: { displayName: "图片生成", summary: "生成或编辑图片" },
  "openai-docs": { displayName: "OpenAI 开发文档", summary: "查询 OpenAI 产品与 API 官方文档" },
  "plugin-creator": { displayName: "插件创建", summary: "创建和维护 Codex 插件" },
  "skill-creator": { displayName: "技能创建", summary: "创建和维护 Codex 技能" },
  "skill-installer": { displayName: "技能安装", summary: "安装 Codex 技能" },
  Excel: { displayName: "电子表格", summary: "创建、编辑和分析电子表格" },
  PowerPoint: { displayName: "幻灯片", summary: "创建、编辑和导出演示文稿" },
  figma: { displayName: "Figma 设计", summary: "读取 Figma 设计与资源" },
  "figma-implement-design": { displayName: "Figma 设计实现", summary: "将 Figma 设计还原为产品代码" },
  "frontend-skill": { displayName: "前端界面设计", summary: "创建视觉完整的网页与应用界面" },
  pdf: { displayName: "PDF 文档", summary: "读取、创建和检查 PDF 文档" },
  playwright: { displayName: "浏览器自动化", summary: "自动操作浏览器并检查页面" },
  "playwright-interactive": { displayName: "交互式浏览器调试", summary: "持续操作浏览器并调试界面" },
  screenshot: { displayName: "屏幕截图", summary: "截取屏幕、窗口或指定区域" },
  "vercel-deploy": { displayName: "Vercel 部署", summary: "将应用或网站部署到 Vercel" },
};

const HAN_RE = /[\u3400-\u9fff]/u;

/**
 * 所有技能 UI 共用的零模型展示策略。
 * manifest 中文字段优先；Codex 随产品提供的技能走静态中文表；未知外部技能不展示英文长摘要。
 */
export function resolveSkillDisplayMetadata(skill: SkillDisplaySource): LocalizedSkillMetadata {
  const codexBuiltin = skill.source === "external-codex"
    ? CODEX_BUILTIN_SKILL_METADATA[skill.name]
    : undefined;
  if (codexBuiltin) return codexBuiltin;

  const declaredDisplayName = skill.displayName?.trim() || skill.label.trim() || skill.name;
  const declaredSummary = skill.summary.trim();
  const isThirdParty = skill.source === "installed" || skill.source?.startsWith("external-");
  return {
    displayName: declaredDisplayName,
    summary: isThirdParty && !HAN_RE.test(declaredSummary) ? "第三方技能" : declaredSummary,
  };
}

export function skillToMenuAction(skill: SkillDisplaySource): SkillDisplay {
  const localized = resolveSkillDisplayMetadata(skill);
  const isThirdParty = skill.source === "installed" || skill.source?.startsWith("external-");
  const fullDescription = HAN_RE.test(skill.description) || !isThirdParty
    ? skill.description
    : localized.summary;
  const declaredPlaceholder = skill.placeholder?.trim();
  const placeholder = declaredPlaceholder && (!isThirdParty || HAN_RE.test(declaredPlaceholder))
    ? declaredPlaceholder
    : localized.summary;
  return {
    id: skill.name,
    label: localized.displayName,
    description: localized.summary,
    fullDescription,
    placeholder,
    icon: skill.icon,
  };
}

export function invocableSkillActionsFromApi(skills: readonly SkillDisplaySource[]): SkillDisplay[] {
  return skills
    .filter((skill) => skill.enabled && skill.userInvocable)
    .map((skill) => skillToMenuAction(skill));
}
