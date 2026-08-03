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

/** `lark-cli skills list` 随包分发的官方技能；精确列名，避免误伤未知第三方技能。 */
const LARK_CLI_BUNDLED_SKILL_METADATA: Readonly<Record<string, LocalizedSkillMetadata>> = {
  "lark-approval": { displayName: "飞书审批", summary: "查询、处理和发起审批" },
  "lark-apps": { displayName: "妙搭应用开发", summary: "创建、部署和监控妙搭应用" },
  "lark-attendance": { displayName: "飞书考勤", summary: "查询个人考勤打卡记录" },
  "lark-base": { displayName: "飞书多维表格", summary: "管理多维表格、字段、记录与视图" },
  "lark-calendar": { displayName: "飞书日历", summary: "管理日程、参会人与会议室" },
  "lark-contact": { displayName: "飞书通讯录", summary: "查询成员身份与联系方式" },
  "lark-doc": { displayName: "飞书云文档", summary: "读取、创建和编辑云文档" },
  "lark-drive": { displayName: "飞书云空间", summary: "管理云空间文件与文件夹" },
  "lark-event": { displayName: "飞书事件订阅", summary: "监听和消费飞书实时事件" },
  "lark-im": { displayName: "飞书即时通讯", summary: "收发消息并管理群聊" },
  "lark-mail": { displayName: "飞书邮箱", summary: "收发、搜索和管理邮件" },
  "lark-markdown": { displayName: "飞书 Markdown", summary: "创建、编辑和比较 Markdown 文件" },
  "lark-minutes": { displayName: "飞书妙记", summary: "查询和编辑妙记内容" },
  "lark-note": { displayName: "飞书会议纪要", summary: "按纪要编号查询会议记录" },
  "lark-okr": { displayName: "飞书 OKR", summary: "管理目标、关键结果与进展" },
  "lark-openapi-explorer": { displayName: "飞书开放接口", summary: "查找和调用飞书原生接口" },
  "lark-shared": { displayName: "飞书连接与授权", summary: "管理飞书登录、身份与权限" },
  "lark-sheets": { displayName: "飞书电子表格", summary: "创建、编辑和分析电子表格" },
  "lark-skill-maker": { displayName: "飞书技能创建", summary: "将飞书操作封装为可复用技能" },
  "lark-slides": { displayName: "飞书幻灯片", summary: "创建和编辑演示文稿" },
  "lark-task": { displayName: "飞书任务", summary: "管理任务、清单与协作成员" },
  "lark-vc": { displayName: "飞书视频会议", summary: "查询历史会议、纪要与参会人" },
  "lark-vc-agent": { displayName: "飞书会中助手", summary: "加入会议并处理会中互动" },
  "lark-whiteboard": { displayName: "飞书画板", summary: "查看、导出和编辑画板" },
  "lark-wiki": { displayName: "飞书知识库", summary: "管理知识空间、成员与文档节点" },
  "lark-workflow-meeting-summary": { displayName: "飞书会议纪要汇总", summary: "汇总会议纪要并生成报告" },
  "lark-workflow-standup-report": { displayName: "飞书日程待办摘要", summary: "汇总指定日期的日程与待办" },
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

  const larkCliBundled = LARK_CLI_BUNDLED_SKILL_METADATA[skill.name];
  if (larkCliBundled) return larkCliBundled;

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
