import { readDisabledSet } from "./enabledStore.js";
import type { RequestContext } from "@mastra/core/request-context";
import { formatSkillActivation, type Workspace } from "@mastra/core/workspace";
import { activateSkill } from "./writeInject.js";
import { injectExternalSkillPositioningNotice } from "./externalSkillNotice.js";

export const SKILL_DISABLED_TOOL_RESULT_CODE = "SKILL_DISABLED";

const TOOL_SKILL_OWNERS: Record<string, readonly string[]> = {
  derivative_brief: ["derivatives"],
  generate_derivative: ["derivatives"],
  list_derivatives: ["derivatives"],
  update_derivative_params: ["derivatives"],
  style_template_list: ["derivative-writing"],
  style_template_get: ["derivative-writing", "review"],
  style_template_save: ["derivative-writing"],
  style_template_delete: ["derivative-writing"],
  // fetchArticle 虽被公众号相关技能复用,但本质仍是联网抓取；联网搜关闭时必须一并关停。
  webSearch: ["web-search"],
  fetchArticle: ["web-search"],
  generateSvg: ["image-gen"],
  prepareImageEditSource: ["image-gen"],
  editSvgWithCodexFallback: ["image-gen"],
  importGeneratedImage: ["image-gen"],
  readImage: ["image-reading"],
  wechat_auth_start: ["wechat-official-account"],
  wechat_auth_status: ["wechat-official-account"],
  wechat_search_mp: ["wechat-official-account"],
  wechat_list_articles: ["wechat-official-account"],
  github_auth_start: ["github-materials"],
  github_list_repos: ["github-materials"],
  github_repo_tree: ["github-materials"],
  github_read_file: ["github-materials"],
  github_search_code: ["github-materials"],
  feishu_auth_start: ["feishu"],
  lexicon_list: ["review"],
  sensitive_scan: ["review"],
  lexicon_manage: ["review"],
};

const SKILL_LABELS: Record<string, string> = {
  derivatives: "衍生稿",
  "derivative-writing": "衍生稿撰写",
  "browser-ops": "浏览器操作",
  "web-search": "联网搜",
  "image-gen": "画配图",
  "image-reading": "看图片",
  "wechat-official-account": "抓公众号",
  "github-materials": "GitHub 读取",
  feishu: "连飞书",
  review: "文档审查",
  "diagram-viz": "图表可视化",
};

export interface SkillDisabledToolResult {
  ok: false;
  blocked: true;
  code: typeof SKILL_DISABLED_TOOL_RESULT_CODE;
  skillName: string;
  toolName: string;
  message: string;
  error: string;
  [key: string]: unknown;
}

function ownersForTool(toolName: string): readonly string[] {
  if (toolName.startsWith("browser_")) return ["browser-ops"];
  return TOOL_SKILL_OWNERS[toolName] ?? [];
}

/**
 * 同一工具可能被多个技能复用；只有所有 owner 都停用时才拦截。
 * fetchArticle 是例外：它只以 web-search 作为联网隐私门，见上方映射。
 */
export function disabledSkillForTool(
  toolName: string,
  disabledSkills: ReadonlySet<string>,
): string | null {
  const owners = ownersForTool(toolName);
  if (owners.length === 0 || !owners.every((owner) => disabledSkills.has(owner))) {
    return null;
  }
  return owners.find((owner) => disabledSkills.has(owner)) ?? null;
}

export function filterDisabledSkillTools<T extends Record<string, unknown>>(
  tools: T,
  disabledSkills: ReadonlySet<string>,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([toolName]) => disabledSkillForTool(toolName, disabledSkills) === null,
    ),
  ) as Partial<T>;
}

function blockedMessage(skillName: string, toolName: string): string {
  const label = SKILL_LABELS[skillName] ?? skillName;
  return `“${label}”技能已停用，无法执行 ${toolName}。如需联网或使用该能力，请先在设置中启用“${label}”；否则我只能基于当前已有信息继续。`;
}

export function buildSkillDisabledToolResult(
  skillName: string,
  toolName: string,
  input: unknown,
): SkillDisabledToolResult {
  const message = blockedMessage(skillName, toolName);
  const base: SkillDisabledToolResult = {
    ok: false,
    blocked: true,
    code: SKILL_DISABLED_TOOL_RESULT_CODE,
    skillName,
    toolName,
    message,
    error: message,
  };
  if (toolName === "webSearch") {
    const query =
      input && typeof input === "object" && typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
    return { ...base, query, note: message, items: [] };
  }
  if (toolName === "fetchArticle") {
    const sourceUrl =
      input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string"
        ? (input as { url: string }).url
        : "";
    return {
      ...base,
      title: "",
      text: `[Error] ${message}`,
      wordCount: 0,
      images: [],
      screenshotSrc: null,
      ogImageUrl: null,
      sourceUrl,
      materialId: "",
      via: "static",
    };
  }
  return base;
}

export function isSkillDisabledToolResult(value: unknown): value is SkillDisabledToolResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false &&
      (value as { blocked?: unknown }).blocked === true &&
      (value as { code?: unknown }).code === SKILL_DISABLED_TOOL_RESULT_CODE &&
      typeof (value as { message?: unknown }).message === "string",
  );
}

/**
 * Mastra Agent 级 dispatch 门：覆盖静态工具、toolsets、ToolSearch 与 workspace 等来源。
 * schema 期过滤是主防线；这里防旧快照/历史工具或模型硬调，执行体不会获得控制权。
 */
export async function beforeSkillToolCall({
  toolName,
  input,
  context,
}: {
  toolName: string;
  input: unknown;
  context?: unknown;
}): Promise<{
  proceed: false;
  output: SkillDisabledToolResult | string;
} | undefined> {
  const disabledSkills = await readDisabledSet();
  const requestedSkillName =
    toolName === "skill" &&
    input &&
    typeof input === "object" &&
    typeof (input as { name?: unknown }).name === "string"
      ? (input as { name: string }).name.trim()
      : null;
  if (requestedSkillName && disabledSkills.has(requestedSkillName)) {
    return {
      proceed: false,
      output: buildSkillDisabledToolResult(requestedSkillName, toolName, input),
    };
  }
  const skillName = disabledSkillForTool(toolName, disabledSkills);
  if (skillName) {
    return {
      proceed: false,
      output: buildSkillDisabledToolResult(skillName, toolName, input),
    };
  }
  if (requestedSkillName) {
    const executionContext =
      context && typeof context === "object"
        ? context as {
            requestContext?: RequestContext;
            workspace?: Workspace;
          }
        : undefined;
    const requestContext = executionContext?.requestContext;
    const userText = requestContext?.get("userText");
    activateSkill(
      requestContext,
      requestedSkillName,
      typeof userText === "string" ? userText : "",
    );
    const skills = executionContext?.workspace?.skills;
    if (skills) {
      await skills.maybeRefresh();
      const skill = await skills.get(requestedSkillName);
      if (skill) {
        const activation = formatSkillActivation(skill);
        const content = injectExternalSkillPositioningNotice(
          skill.path,
          activation,
        );
        if (content !== activation) {
          return { proceed: false, output: content };
        }
      }
    }
  }
  return undefined;
}
