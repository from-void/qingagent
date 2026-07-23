import type { ReviewContext, SkillRef } from "@qingagent/contract-ts";
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "node:crypto";
import { getQingagentSessionWorkspace } from "../agents/qingagent.js";
import type { getQingagentSkills } from "../agents/qingagent.js";
import {
  createQingagentToolSearchProcessor,
  type QingagentToolSearchTools,
} from "../agents/toolSearch.js";
import { createGatedExecuteCommandTool } from "../workspace/gatedExecuteCommandTool.js";
import {
  createProtectedFolderSourceEditFileTool,
  createProtectedFolderSourceGrepTool,
  createProtectedFolderSourceReadFileTool,
  createProtectedFolderSourceSearchTool,
} from "../workspace/protectedFolderSourceTools.js";
import { createReadDocumentTool, createSearchDocumentsTool } from "../tools/folderDocuments.js";
import { readDisabledSet } from "../skills/enabledStore.js";
import { getAgentBrowserTools } from "@qingagent/doc-render/browser";
import { parseFileTool } from "../tools/parseFile.js";
import { fetchArticleTool } from "../tools/fetchArticle.js";
import { webSearchTool } from "../tools/webSearch.js";
import { generateSvgTool } from "../tools/generateSvg.js";
import { readImageTool } from "../tools/readImage.js";
import { runJsTool } from "../tools/runJs.js";
import { showQrTool } from "../tools/showQr.js";
import { wechatAuthStartTool, wechatAuthStatusTool } from "../tools/wechatAuth.js";
import { wechatSearchMpTool, wechatListArticlesTool } from "../tools/wechatSearch.js";
import { githubListReposTool } from "../tools/githubListRepos.js";
import { githubRepoTreeTool } from "../tools/githubRepoTree.js";
import { githubReadFileTool } from "../tools/githubReadFile.js";
import { githubSearchCodeTool } from "../tools/githubSearchCode.js";
import { githubAuthStartTool } from "../tools/githubAuthStart.js";
import { feishuAuthStartTool } from "../tools/feishuAuthStart.js";
import { lexiconListTool, lexiconManageTool, sensitiveScanTool } from "../tools/lexicon.js";
import { derivativeBriefTool, generateDerivativeTool, listDerivativesTool, updateDerivativeParamsTool } from "../tools/derivatives.js";
import { styleTemplateDeleteTool, styleTemplateGetTool, styleTemplateListTool, styleTemplateSaveTool } from "../tools/styleTemplates.js";
import { updateTodosTool } from "../tools/updateTodos.js";
import { getPyodideTools } from "../tools/runPython.js";
import { mastra } from "../mastra.js";
import { createUpdateWorkingMemoryTool } from "./workingMemory.js";
import type { SessionState, SuspensionToolName } from "./sessionState.js";
import { isQuestionnaireTool } from "../agent-run/questionnaireTools.js";
import { isRecord } from "../agent-run/redaction.js";
import { fillLocalSvgImageDimensions } from "../agent-run/imageDimensionFallback.js";
import { buildDraftDiff } from "../doc-engine/proposalDiff.js";
import {
  clonePmDoc,
  currentDraftMutationStats,
  currentPmDoc,
  ensureDraftCandidateDoc,
  replaceDraftCandidateDoc,
  validateCurrentTableSelectionScopes,
} from "../doc-engine/draftScratch.js";
import {
  collectReadableDraftRefs,
  isListItemRefNode,
  isPmBlockNode,
  summarizeReadDraftOutputText,
} from "../doc-engine/draftReadContext.js";
import {
  collectTopLevelTextBlocks,
  containsLiteralMatch,
  findAnnotationQuoteMatches,
  findLiteralMatches,
  findSafeRegexMatches,
  markTextRuns,
  replaceTextRuns,
} from "../doc-engine/textEditOps.js";
import { createWriteDraftTool } from "../tools/writeDraft.js";
import { editDraftInputSchema } from "../tools/draftMutationSchemas.js";
import {
  createAnnotationGroupsInputSchema,
  reviewOrigin,
  truncateAnnotationSummary,
  type AnnotationGroupInput,
} from "../tools/annotationGroups.js";
import { replaceAnnotationGroupsByOrigin } from "@qingagent/db";
import type { Material } from "../types/material.js";
import {
  applyBlockEdits,
  aiBlockToQingml,
  aiRunMarkToPmMark,
  aiRunMarkSchema,
  analyzeAiIrEditability,
  blockToAi,
  countDocVisibleChars,
  qingmlParseFragment,
  safeParsePmDoc,
  type AiRunMark,
  type BlockEdit,
  type FragmentAction,
  type PmDoc,
  type QingmlFragmentResult,
} from "@qingagent/pm-schema";

const logger = mastra.getLogger();

function annotationGroupSemanticErrors(source: AnnotationGroupInput, groupIndex: number): string[] {
  const prefix = `第 ${groupIndex + 1} 组`;
  const errors: string[] = [];
  if (source.origin === "source-check") {
    if (!source.judgment || !["口径漂移", "数字失真", "无据", "素材遗漏"].includes(source.judgment)) {
      errors.push(`${prefix} judgment 字段必填，必须是“口径漂移”“数字失真”“无据”或“素材遗漏”`);
    } else if (source.judgment !== "无据" && !source.materialQuote?.trim()) {
      errors.push(`${prefix} materialQuote 字段必填：${source.judgment}必须逐字引用素材全文`);
    } else if (source.judgment === "无据" && !source.checkedScope?.trim()) {
      errors.push(`${prefix} checkedScope 字段必填：无据必须说明已核查的素材范围`);
    }
  }
  if (source.origin === "consistency") {
    if (!source.judgment || !["时间线", "数字", "称谓与术语", "论断"].includes(source.judgment)) {
      errors.push(`${prefix} judgment 字段必填，必须是“时间线”“数字”“称谓与术语”或“论断”`);
    }
    if (!source.documentQuote?.trim()) {
      errors.push(`${prefix} documentQuote 字段必填，且必须逐字来自当前文档全文`);
    }
  }
  return errors;
}

// BB① 埋点用:按 turn(runId)累计 editDraft.execute 次数(模块级,跨同一 turn 内多次调用)。
const editDraftExecuteCounts = new Map<string, number>();

type QingmlFragmentKind = Extract<QingmlFragmentResult, { ok: true }>["kind"];
type ParsedQingmlFragment<K extends QingmlFragmentKind> = Extract<QingmlFragmentResult, { ok: true; kind: K }>;

function parseEditDraftQingmlFragment<K extends QingmlFragmentKind>(
  text: unknown,
  action: FragmentAction,
  expectedKind: K,
): { ok: true; fragment: ParsedQingmlFragment<K> } | { ok: false; error: string } {
  if (typeof text !== "string") {
    return { ok: false, error: `${action} 需要 QingML 片段字符串。` };
  }
  const parsed = qingmlParseFragment(text, action);
  if (!parsed.ok) {
    const badWarnings = parsed.warnings.filter((warning) => warning.severity === "bad-block");
    if (badWarnings.length > 0) {
      return {
        ok: false,
        error: `QingML bad-block: ${badWarnings.map((warning) => `${warning.kind}:${warning.detail}`).join("; ")}`,
      };
    }
    return { ok: false, error: parsed.error };
  }

  const badWarnings = parsed.warnings.filter((warning) => warning.severity === "bad-block");
  if (badWarnings.length > 0) {
    return {
      ok: false,
      error: `QingML bad-block: ${badWarnings.map((warning) => `${warning.kind}:${warning.detail}`).join("; ")}`,
    };
  }
  if (parsed.kind !== expectedKind) {
    return { ok: false, error: `${action} 期望 ${expectedKind} 片段,实际得到 ${parsed.kind}。` };
  }
  return { ok: true, fragment: parsed as ParsedQingmlFragment<K> };
}

const CAPABILITY_TOOLS = {
  derivatives: {
    derivative_brief: derivativeBriefTool,
    generate_derivative: generateDerivativeTool,
    list_derivatives: listDerivativesTool,
    update_derivative_params: updateDerivativeParamsTool,
  },
  "gzh-style": { style_template_list: styleTemplateListTool, style_template_get: styleTemplateGetTool, style_template_save: styleTemplateSaveTool, style_template_delete: styleTemplateDeleteTool },
  "browser-ops": {},
  "web-search": { webSearch: webSearchTool },
  "image-gen": { generateSvg: generateSvgTool },
  "image-reading": { readImage: readImageTool },
  "wechat-official-account": {
    wechat_auth_start: wechatAuthStartTool,
    wechat_auth_status: wechatAuthStatusTool,
    wechat_search_mp: wechatSearchMpTool,
    wechat_list_articles: wechatListArticlesTool,
  },
  "github-materials": {
    github_auth_start: githubAuthStartTool,
    github_list_repos: githubListReposTool,
    github_repo_tree: githubRepoTreeTool,
    github_read_file: githubReadFileTool,
    github_search_code: githubSearchCodeTool,
  },
  feishu: { feishu_auth_start: feishuAuthStartTool },
  "sensitive-review": {
    lexicon_list: lexiconListTool,
    sensitive_scan: sensitiveScanTool,
    lexicon_manage: lexiconManageTool,
  },
  "deai-review": { style_template_get: styleTemplateGetTool },
} as const;

// run_js 是系统提示长期承诺的通用精确计算工具。doc-calc 技能只负责点召/preload 与方法论说明,
// 停用技能不能让提示里推荐的底层计算工具消失。
const CORE_CALC_TOOLS = {
  run_js: runJsTool,
} as const;

const MATERIAL_TOOL_SEARCH_TOOLS = {
  parseFile: parseFileTool,
  fetchArticle: fetchArticleTool,
} as const;

const SELECTED_SKILL_TOOL_SEARCH_PRELOADS: Record<string, string[]> = {
  "web-search": ["webSearch"],
  "image-gen": ["generateSvg"],
  "image-reading": ["readImage"],
  "materials": ["parseFile", "fetchArticle"],
  "doc-calc": ["run_js"],
  "wechat-official-account": [
    "wechat_auth_status",
    "wechat_search_mp",
    "wechat_list_articles",
    "fetchArticle",
  ],
  "github-materials": ["github_auth_start", "github_list_repos", "github_repo_tree", "github_read_file", "github_search_code"],
  feishu: ["feishu_auth_start"],
  "sensitive-review": ["lexicon_list", "sensitive_scan", "lexicon_manage"],
  "deai-review": ["style_template_get"],
  "consistency-review": ["run_python"],
  "gzh-style": ["fetchArticle", "style_template_list", "style_template_get", "style_template_save", "style_template_delete"],
};

export function toSuspensionToolName(toolName: string): SuspensionToolName | null {
  if (isQuestionnaireTool(toolName)) return toolName;
  return null;
}

export function isExtractionFailureText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[Error]") || trimmed.startsWith("[Unsupported]");
}

/** Mastra 内建技能工具名(返回格式由框架定义,不走项目字段校验)。 */
const MASTRA_SKILL_TOOL_NAMES = new Set(["skill", "skill_search", "skill_read"]);

export function missingGenericToolResultFields(
  toolName: string,
  result: unknown,
): string[] {
  // Mastra 内建工具(workspace 沙箱文件/命令、skill 读取搜索)的返回格式由框架定义
  // (常为字符串或 {type:"text",value}),不走项目自定义字段校验——否则会被误判
  // "缺少必填字段"标失败,模型拿到假失败信号无法继续。放行,结果原样透传。
  // 精确白名单(不用 skill_ 前缀,避免未来项目工具命名成 skill_* 意外绕过校验)。
  if (toolName.startsWith("mastra_workspace_") || MASTRA_SKILL_TOOL_NAMES.has(toolName)) {
    return [];
  }
  if (!isRecord(result)) {
    return ["<object>"];
  }

  const missing: string[] = [];
  const requireString = (field: string) => {
    if (typeof result[field] !== "string") missing.push(field);
  };
  const requireNumber = (field: string) => {
    if (typeof result[field] !== "number" || !Number.isFinite(result[field] as number)) {
      missing.push(field);
    }
  };
  const requireBoolean = (field: string) => {
    if (typeof result[field] !== "boolean") missing.push(field);
  };
  const requireArray = (field: string) => {
    if (!Array.isArray(result[field])) missing.push(field);
  };
  const requireRecord = (field: string) => {
    if (!isRecord(result[field])) missing.push(field);
  };
  const requireNullableString = (field: string) => {
    const value = result[field];
    if (value !== null && typeof value !== "string") missing.push(field);
  };

  switch (toolName) {
    case "github_auth_start":
      requireString("user_code"); requireString("verification_uri"); requireString("expiresAt"); requireString("pendingId"); requireBoolean("reused");
      break;
    case "feishu_auth_start":
      requireString("mode"); requireString("connectorId"); requireString("expiresAt"); requireString("pendingId"); requireBoolean("reused");
      if (result.mode === "authorization") { requireString("verification_url"); requireString("user_code"); }
      else if (result.mode === "configuration") requireString("configuration_url");
      else missing.push("mode:authorization|configuration");
      break;
    case "github_list_repos":
      requireArray("repos"); requireNumber("count"); requireBoolean("anonymous"); requireRecord("rateLimit");
      break;
    case "github_repo_tree":
      requireArray("entries"); requireNumber("count"); requireBoolean("truncated"); requireBoolean("providerTruncated"); requireRecord("rateLimit");
      break;
    case "github_read_file":
      requireString("materialId"); requireString("title"); requireString("text"); requireString("sourceUrl"); requireRecord("rateLimit");
      break;
    case "github_search_code":
      requireBoolean("ok");
      if (result.ok === false) { requireString("reasonCode"); requireString("message"); }
      else if (result.selected === true) { requireBoolean("selected"); requireString("materialId"); requireString("title"); requireString("text"); requireString("sourceUrl"); requireRecord("rateLimit"); }
      else { requireNumber("count"); requireArray("hits"); requireRecord("rateLimit"); }
      break;
    case "storeMaterial":
      requireString("materialId");
      requireBoolean("stored");
      break;
    case "readMaterial":
      requireString("text");
      requireString("filename");
      requireNumber("wordCount");
      break;
    case "summarizeMaterial":
      requireBoolean("updated");
      break;
    case "parseFile":
      requireString("text");
      requireRecord("metadata");
      if (isRecord(result.metadata)) {
        const metadata = result.metadata;
        const pages = metadata.pages;
        if (pages !== null && (typeof pages !== "number" || !Number.isFinite(pages))) {
          missing.push("metadata.pages");
        }
        if (typeof metadata.wordCount !== "number" || !Number.isFinite(metadata.wordCount)) {
          missing.push("metadata.wordCount");
        }
        const title = metadata.title;
        if (title !== null && typeof title !== "string") missing.push("metadata.title");
      }
      break;
    case "fetchArticle":
      requireString("title");
      requireString("text");
      requireNumber("wordCount");
      requireArray("images");
      requireNullableString("screenshotSrc");
      requireNullableString("ogImageUrl");
      requireString("sourceUrl");
      requireString("materialId");
      requireString("via");
      break;
    case "webSearch":
      requireBoolean("ok");
      requireString("query");
      requireArray("items");
      break;
    case "wechat_auth_start":
      requireBoolean("ok");
      requireString("imageDataUri");
      requireNumber("expiresInSec");
      break;
    case "wechat_auth_status":
      requireBoolean("ok");
      requireString("state");
      requireString("mpName");
      requireString("message");
      break;
    case "wechat_search_mp":
      requireBoolean("ok");
      requireString("state");
      requireArray("accounts");
      requireNullableString("error");
      break;
    case "wechat_list_articles":
      requireBoolean("ok");
      requireString("state");
      requireArray("articles");
      requireNullableString("error");
      break;
    case "lexicon_list":
      requireBoolean("ok");
      requireArray("lexicons");
      break;
    case "sensitive_scan":
      requireBoolean("ok");
      requireArray("hits");
      requireNumber("totalCount");
      requireNumber("scannedChars");
      break;
    case "lexicon_manage":
      requireBoolean("ok");
      requireString("action");
      requireString("summary");
      break;
    case "derivative_brief":
      requireBoolean("ok");
      break;
    case "generate_derivative":
      requireBoolean("ok");
      break;
    case "list_derivatives":
      requireBoolean("ok"); requireArray("items"); break;
    case "update_derivative_params":
    case "style_template_get":
    case "style_template_save":
    case "style_template_delete":
      requireBoolean("ok"); break;
    case "style_template_list":
      requireBoolean("ok"); requireArray("templates"); break;
    case "readImage":
      requireBoolean("ok");
      requireString("text");
      requireNullableString("error");
      break;
    default:
      break;
  }

  return missing;
}

export type SelectedSkillInput = string | SkillRef;

function selectedSkillId(skill: SelectedSkillInput): string | null {
  if (typeof skill === "string") return skill;
  // Route validation only checks Array.isArray(skills), not element shape, so a
  // malformed payload (e.g. [null], [123]) can reach here. Guard before .id.
  if (!skill || typeof skill !== "object") return null;
  return typeof skill.id === "string" ? skill.id : null;
}

export async function resolveSelectedSkillNames(
  selectedSkills: SelectedSkillInput[],
  skills: Awaited<ReturnType<typeof getQingagentSkills>>,
): Promise<string[]> {
  const ids = Array.from(
    new Set(
      selectedSkills
        .map((skill) => selectedSkillId(skill))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const names: string[] = [];
  for (const id of ids) {
    if (await skills.has(id).catch(() => false)) {
      names.push(id);
    }
  }
  return names;
}

// 能力工具集:全部 CAPABILITY_TOOLS,仅剔除被显式禁用的(disabled)。
// 注意:用户勾选技能只做检索预加载/记录,不再注入尾部软提示,
// **不**再收窄工具集——所有未禁用的能力工具始终可调,模型自行决定用不用。
export async function buildCapabilityTools() {
  const disabled = await readDisabledSet();
  const activeNames = Object.keys(CAPABILITY_TOOLS).filter((name) => !disabled.has(name));
  const tools = Object.assign(
    {},
    ...activeNames.map((name) => CAPABILITY_TOOLS[name as keyof typeof CAPABILITY_TOOLS] ?? {}),
  );
  // 浏览器自主操作(browser_*):三级抓取的最后一级,登录/付费墙/交互翻页时升级。
  // 默认关闭(空对象),仅 QINGAGENT_AGENT_BROWSER=1 或配了持久 Chrome cdpUrl 时注入,
  // 避免平白给主 agent 增加十几个工具的上下文。与技能选择无关(随时可升级)。
  return Object.assign(
    tools,
    CORE_CALC_TOOLS,
    getPyodideTools(),
    // show_qr/updateTodos 始终可用、不走技能门控:前者是 UI 指令,后者是会话状态同步。
    { show_qr: showQrTool, updateTodos: updateTodosTool },
    disabled.has("browser-ops") ? {} : getAgentBrowserTools(),
  );
}

export interface CapabilityToolSearchBridge {
  alwaysTools: ToolsInput;
  searchableTools: QingagentToolSearchTools;
  preloadToolNames: string[];
  signature: string;
}

export async function buildCapabilityToolSearchBridge(
  selectedSkillNames: string[],
): Promise<CapabilityToolSearchBridge> {
  const disabled = await readDisabledSet();
  const activeNames = Object.keys(CAPABILITY_TOOLS).filter((name) => !disabled.has(name));
  const searchableTools = Object.assign(
    {},
    MATERIAL_TOOL_SEARCH_TOOLS,
    ...activeNames.map((name) => CAPABILITY_TOOLS[name as keyof typeof CAPABILITY_TOOLS] ?? {}),
    CORE_CALC_TOOLS,
    getPyodideTools(),
    disabled.has("browser-ops") ? {} : getAgentBrowserTools(),
  ) as QingagentToolSearchTools;
  const alwaysTools: ToolsInput = {
    show_qr: showQrTool,
    updateTodos: updateTodosTool,
  };
  const preloadToolNames = Array.from(
    new Set(
      selectedSkillNames
        .flatMap((name) => SELECTED_SKILL_TOOL_SEARCH_PRELOADS[name] ?? [])
        .filter((toolName) => Object.prototype.hasOwnProperty.call(searchableTools, toolName)),
    ),
  );
  return {
    alwaysTools,
    searchableTools,
    preloadToolNames,
    signature: toolSearchSignature(searchableTools),
  };
}

export function ensureSessionToolSearchProcessor(
  state: SessionState,
  bridge: Pick<CapabilityToolSearchBridge, "searchableTools" | "signature">,
) {
  if (!state._toolSearchProcessor) {
    state._toolSearchProcessor = createQingagentToolSearchProcessor(bridge.searchableTools);
    state._toolSearchToolSignature = bridge.signature;
    return state._toolSearchProcessor;
  }
  if (state._toolSearchToolSignature !== bridge.signature) {
    logger.warn("[toolSearch] searchable tool snapshot changed after session processor creation; keeping existing processor", {
      sessionId: state.sessionId,
      initialSignature: state._toolSearchToolSignature,
      currentSignature: bridge.signature,
    });
  }
  return state._toolSearchProcessor;
}

function toolSearchSignature(tools: QingagentToolSearchTools): string {
  return Object.keys(tools).sort().join("\n");
}

// downloadRemoteImage 来自 ../tools/imageInput.js;resolveFileIds/UPLOADS_BASE 来自
// ./uploadFileResolver.js(两分支各抽了一个模块,合并后都走 import,不再内联定义)。
export function buildAttachmentContext(
  files: Array<{ fileId: string; filename: string; filePath: string; mimeType: string }>,
  options: { toolSearchEnabled?: boolean } = {},
): string {
  if (files.length === 0) return "";
  // 图片走 readImage(图像识别),文档走 parseFile。两类分别给出明确指引。
  const images = files.filter((f) => f.mimeType.startsWith("image/"));
  const docs = files.filter((f) => !f.mimeType.startsWith("image/"));
  let out = "";
  if (docs.length > 0) {
    // CC 脱敏:web 部署不把 server 绝对路径(./uploads/<uuid>/<file>)暴露进模型上下文/转写,
    // 改用内部 fileId(parseFile 用安全 resolver 还原真实路径,限定在 ./uploads 根目录内);
    // desktop(本机单机)保留原 filePath。部署标志由桌面端在启动时设的 QINGAGENT_RUNTIME=desktop。
    const isDesktopRuntime = process.env.QINGAGENT_RUNTIME === "desktop";
    if (isDesktopRuntime) {
      const docList = docs
        .map((f) => `- filename: ${f.filename}\n  mimeType: ${f.mimeType}\n  filePath: ${f.filePath}`)
        .join("\n");
      out += documentAttachmentToolInstruction({
        docList,
        exampleField: "filePath",
        exampleValue: docs[0]!.filePath,
        toolSearchEnabled: options.toolSearchEnabled === true,
      });
    } else {
      const docList = docs
        .map((f) => `- filename: ${f.filename}\n  mimeType: ${f.mimeType}\n  fileId: ${f.fileId}`)
        .join("\n");
      out += documentAttachmentToolInstruction({
        docList,
        exampleField: "fileId",
        exampleValue: docs[0]!.fileId,
        toolSearchEnabled: options.toolSearchEnabled === true,
        fieldHint: "不要传服务器文件路径",
      });
    }
  }
  if (images.length > 0) {
    const imgList = images
      .map((f) => `- filename: ${f.filename}\n  mimeType: ${f.mimeType}\n  fileId: ${f.fileId}`)
      .join("\n");
    out += imageAttachmentToolInstruction({
      imgList,
      fileId: images[0]!.fileId,
      toolSearchEnabled: options.toolSearchEnabled === true,
    });
  }
  return out;
}

function documentAttachmentToolInstruction({
  docList,
  exampleField,
  exampleValue,
  toolSearchEnabled,
  fieldHint,
}: {
  docList: string;
  exampleField: "fileId" | "filePath";
  exampleValue: string;
  toolSearchEnabled: boolean;
  fieldHint?: string;
}): string {
  const hint = fieldHint ? `(${fieldHint})` : "";
  const load = toolSearchEnabled
    ? `请先调用 search_tools({ query: "parseFile" }) 加载 parseFile 工具；加载后立即使用 parseFile 解析这些文档。\n`
    : "请立即使用 parseFile 工具解析这些文档。\n";
  return (
    `[系统] 用户上传了以下文档，已保存到服务器：\n${docList}\n\n` +
    load +
    `调用时传入 ${exampleField} 参数${hint}，例如：\n` +
    `parseFile({ ${exampleField}: "${exampleValue}" })\n\n` +
    `解析完成后，用 storeMaterial 存储结果，然后基于素材内容向用户提问。\n\n`
  );
}

function imageAttachmentToolInstruction({
  imgList,
  fileId,
  toolSearchEnabled,
}: {
  imgList: string;
  fileId: string;
  toolSearchEnabled: boolean;
}): string {
  const load = toolSearchEnabled
    ? `若用户要识别/描述/提取图片内容,请先调用 search_tools({ query: "readImage" }) 加载 readImage 工具；加载后使用 readImage。\n`
    : "若用户要识别/描述/提取图片内容,请使用 readImage 工具。\n";
  return (
    `[系统] 用户上传了以下图片，已保存到服务器：\n${imgList}\n\n` +
    load +
    `image 参数传图片的 fileId(不要传 filePath),例如：\n` +
    `readImage({ image: "${fileId}", prompt: "<本次识别指令>" })\n\n` +
    `readImage 返回的 text 即识别结果,基于它继续回答或写作。\n\n`
  );
}

// ---------------------------------------------------------------------------
// Per-session dynamic tools (closures over state.materials)
// ---------------------------------------------------------------------------

export function createSessionScopedTools(
  stateOrMaterials: SessionState | Map<string, Material>,
) {
  const state = stateOrMaterials instanceof Map ? null : stateOrMaterials;
  const materials = stateOrMaterials instanceof Map ? stateOrMaterials : stateOrMaterials.materials;
  const readMaterial = createTool({
    id: "readMaterial",
    description:
      "读取已存储的素材内容。可以读取全文或摘要。",
    inputSchema: z.object({
      materialId: z.string().describe("素材 ID"),
      mode: z
        .enum(["full", "summary"])
        .describe("读取模式：full=全文, summary=摘要"),
    }),
    outputSchema: z.object({
      text: z.string().describe("素材文本内容或摘要"),
      filename: z.string().describe("原始文件名"),
      wordCount: z.number().describe("字数"),
    }),
    execute: async (input) => {
      const mat = materials.get(input.materialId);
      if (!mat) {
        return {
          text: `[Error] Material not found: ${input.materialId}`,
          filename: "",
          wordCount: 0,
        };
      }
      const text = input.mode === "summary"
        ? (mat.summary ?? "(No summary)")
        : mat.visionSummary
          ? `【图像识别摘要】${mat.visionSummary}\n\n${mat.text}`
          : mat.text;
      return { text, filename: mat.filename, wordCount: mat.metadata.wordCount };
    },
  });
  const createAnnotationGroups = createTool({
    id: "create_annotation_groups",
    description: "把审查发现的问题按组创建批注。一个问题一组，可关联多个正文精确锚点；这是批注的唯一生产入口。同一内置审查类型每轮复用固定 origin，角色/自定义审查分别使用『角色审查:<模板名>』『自定义审查:<模板名>』，新一轮只替换同 origin 的旧批注。",
    inputSchema: createAnnotationGroupsInputSchema,
    outputSchema: z.object({ ok: z.boolean(), groupCount: z.number(), anchorCount: z.number(), errors: z.array(z.string()) }),
    execute: async (input, context) => {
      if (input._parseFailure) {
        logger.warn("[review] create_annotation_groups 参数 JSON 无法安全修复", {
          groupIndex: input._parseFailure.groupIndex,
          field: input._parseFailure.field,
          error: input._parseFailure.message,
        });
        return { ok: false, groupCount: 0, anchorCount: 0, errors: [input._parseFailure.message] };
      }
      if (!state?.doc) return { ok: false, groupCount: 0, anchorCount: 0, errors: ["当前没有可批注文档"] };
      const blocks = collectTopLevelTextBlocks(state.doc);
      const documentText = blocks.map((block) => block.text).join("\n");
      const materialTexts = [...materials.values()].map((material) => material.text);
      const errors: string[] = [];
      const currentReviewContext = context?.requestContext?.get("reviewContext") as ReviewContext | null | undefined;
      const forcedOrigin = reviewOrigin(currentReviewContext);
      const groups = input.groups.flatMap((modelSource, groupIndex) => {
        const normalizedModelSource = {
          ...modelSource,
          summary: truncateAnnotationSummary(modelSource.summary),
        };
        const source = forcedOrigin
          ? { ...normalizedModelSource, origin: forcedOrigin }
          : normalizedModelSource;
        if (forcedOrigin && modelSource.origin !== forcedOrigin) {
          logger.warn("[review] 覆写模型填写的批注 origin", {
            reviewType: currentReviewContext?.type,
            templateName: currentReviewContext?.templateName,
            groupIndex: groupIndex + 1,
            modelOrigin: modelSource.origin,
            forcedOrigin,
          });
        }
        const semanticErrors = annotationGroupSemanticErrors(source, groupIndex);
        if (semanticErrors.length > 0) {
          errors.push(...semanticErrors);
          return [];
        }
        if (
          source.origin === "source-check"
          && source.judgment !== "无据"
          && !materialTexts.some((text) => containsLiteralMatch(text, source.materialQuote ?? ""))
        ) {
          errors.push(`第 ${groupIndex + 1} 组 materialQuote 字段无效：素材中未找到所引原句「${source.materialQuote ?? ""}」`);
          return [];
        }
        if (
          source.origin === "consistency"
          && !containsLiteralMatch(documentText, source.documentQuote ?? "")
        ) {
          errors.push(`第 ${groupIndex + 1} 组 documentQuote 字段无效：当前文档中未找到冲突对端原句「${source.documentQuote ?? ""}」`);
          return [];
        }
        const anchors = source.anchors.flatMap((spec, anchorIndex) => {
          const matches = findAnnotationQuoteMatches(blocks, spec.find, spec.all === true);
          if (matches.length === 0) errors.push(`第 ${groupIndex + 1} 组 anchors.${anchorIndex}.find 字段无效：当前文档中未找到精确文本「${spec.find}」`);
          return matches.map((match) => ({
            blockId: match.blockId,
            pmFrom: match.pmFrom,
            pmTo: match.pmTo,
            quote: match.matchText,
            textHash: crypto.createHash("sha256").update(match.matchText).digest("hex").slice(0, 24),
          }));
        });
        if (anchors.length === 0) return [];
        const evidence = source.origin === "source-check"
          ? source.judgment === "无据"
            ? `已核查范围：${source.checkedScope}`
            : `素材原句：${source.materialQuote}`
          : source.origin === "consistency"
            ? `文内冲突原句：${source.documentQuote}`
            : null;
        return [{
          id: `annotation-${crypto.randomUUID()}`,
          summary: source.summary,
          note: evidence ? `${source.note}\n${evidence}` : source.note,
          origin: source.origin,
          suggestion: source.suggestion,
          severity: source.severity,
          status: "reviewing" as const,
          anchors,
        }];
      });
      if (groups.length) {
        const replacedOrigins = new Set(groups.map((group) => group.origin));
        await replaceAnnotationGroupsByOrigin(state.docId, state.docVersion, groups);
        state.annotationGroups = [
          ...state.annotationGroups.filter((group) => !replacedOrigins.has(group.origin)),
          ...groups,
        ];
        const turnOrigins = (state._annotationOriginsReplacedThisTurn ??= new Set());
        replacedOrigins.forEach((origin) => turnOrigins.add(origin));
      }
      return { ok: groups.length > 0, groupCount: groups.length, anchorCount: groups.reduce((n, g) => n + g.anchors.length, 0), errors };
    },
  });

  const summarizeMaterial = createTool({
    id: "summarizeMaterial",
    description:
      "生成或更新素材的摘要。可以指定分析角度，每次调用会覆盖之前的摘要。",
    inputSchema: z.object({
      materialId: z.string().describe("素材 ID"),
      summary: z.string().describe("新的摘要内容"),
      angle: z.string().nullable().describe("分析角度（可选）"),
    }),
    outputSchema: z.object({
      updated: z.boolean().describe("是否更新成功"),
    }),
    execute: async (input) => {
      const mat = materials.get(input.materialId);
      if (!mat) return { updated: false };
      mat.summary = input.summary;
      mat.updatedAt = new Date().toISOString();
      return { updated: true };
    },
  });

  const readDraftAiIr = createTool({
    id: "readDraft",
    description:
      "按块 ref 读取当前候选草稿。默认只返回 qingml 片段,不要把 text 当编辑蓝本。",
    inputSchema: z.object({
      mode: z.enum(["full", "range", "outline"]).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      query: z.string().optional(),
      isRegex: z.boolean().optional(),
      includeText: z.boolean().optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      blocks: z.array(z.object({
        ref: z.string(),
        type: z.string(),
        level: z.number().optional(),
        qingml: z.string().optional(),
        text: z.string().optional(),
        editability: z.object({
          replaceBlockAllowed: z.boolean(),
          lossyReasons: z.array(z.string()),
        }).optional(),
        sectionFrom: z.string().optional(),
        sectionTo: z.string().optional(),
      })).optional(),
      blockCount: z.number().optional(),
      wordCount: z.number().optional(),
      docVersion: z.number().optional(),
      error: z.string().optional(),
    }),
    execute: async (input) => {
      if (!state) return { ok: false, error: "readDraft is unavailable outside a session" };
      const doc = state.docDraftCandidateDoc ?? currentPmDoc(state);
      // 与本次读取到的文档快照绑定；若读取期间用户又提交了新版本，保留旧版本号，
      // 下一次模型调用仍会看到更新信号，不会把旧快照误标成最新。
      const docVersion = state.docVersion;
      const mode = input.mode ?? "full";
      const refEntries = collectReadableDraftRefs(doc);
      const topEntries = refEntries.filter((entry) => entry.path.length === 1);
      const refs = topEntries.map((entry) => entry.ref);
      const textByRef = new Map(
        refEntries.map((entry) => [
          entry.ref,
          summarizeReadDraftOutputText(doc, entry.node),
        ]),
      );

      let selected = topEntries;
      if (mode === "range") {
        if (!input.from || !input.to) return { ok: false, error: "range mode requires from and to" };
        const topFromIndex = refs.indexOf(input.from);
        const topToIndex = refs.indexOf(input.to);
        if (topFromIndex >= 0 && topToIndex >= 0) {
          const start = Math.min(topFromIndex, topToIndex);
          const end = Math.max(topFromIndex, topToIndex);
          selected = selected.filter((item) => item.topIndex >= start && item.topIndex <= end);
        } else {
          const fromIndex = refEntries.findIndex((entry) => entry.ref === input.from);
          const toIndex = refEntries.findIndex((entry) => entry.ref === input.to);
          if (fromIndex < 0 || toIndex < 0) return { ok: false, error: "range ref not found" };
          const start = Math.min(fromIndex, toIndex);
          const end = Math.max(fromIndex, toIndex);
          selected = refEntries.filter((_, index) => index >= start && index <= end);
        }
      } else if (mode === "outline") {
        selected = selected.filter((item) => item.node.type === "heading");
      }

      if (input.query) {
        if (input.isRegex) {
          const matches = await findSafeRegexMatches(
            collectTopLevelTextBlocks(doc),
            input.query,
            true,
          );
          const matchedRefs = new Set(matches.map((match) => match.block.topBlockId));
          selected = selected.filter((item) => matchedRefs.has(item.ref));
        } else {
          selected = selected.filter((item) => (textByRef.get(item.ref) ?? "").includes(input.query!));
        }
      }

      const includeText =
        input.includeText === true ||
        mode === "outline" ||
        Boolean(input.query) ||
        selected.some((entry) => isListItemRefNode(entry.node));
      const blocks = selected.map((entry) => {
        const topBlock = entry.path.length === 1 && isPmBlockNode(entry.node) ? entry.node : null;
        const editability = topBlock
          ? analyzeAiIrEditability(topBlock)
          : { replaceBlockAllowed: false, lossyReasons: ["listItem text-only ref"] };
        const out: {
          ref: string;
          type: string;
          level?: number;
          qingml?: string;
          text?: string;
          editability: { replaceBlockAllowed: boolean; lossyReasons: string[] };
          sectionFrom?: string;
          sectionTo?: string;
        } = {
          ref: entry.ref,
          type: entry.node.type,
          editability,
        };
        if (topBlock) out.qingml = aiBlockToQingml(blockToAi(topBlock));
        if (topBlock?.type === "heading") out.level = topBlock.attrs.level;
        if (includeText) out.text = textByRef.get(entry.ref) ?? "";
        if (mode === "outline" && topBlock?.type === "heading") {
          out.sectionFrom = entry.ref;
          let sectionEnd = entry.topIndex;
          for (let i = entry.topIndex + 1; i < doc.content.length; i += 1) {
            const candidate = doc.content[i]!;
            if (candidate.type === "heading" && candidate.attrs.level <= topBlock.attrs.level) break;
            sectionEnd = i;
          }
          out.sectionTo = doc.content[sectionEnd]?.attrs.blockId ?? entry.ref;
        }
        return out;
      });

      state.modelKnownDocVersion = docVersion;
      return {
        ok: true,
        blocks,
        blockCount: doc.content.length,
        wordCount: countDocVisibleChars(doc),
        docVersion,
      };
    },
  });

  // BB① 埋点:按 turn(runId)统计 editDraft.execute 次数,便于复现"同一轮内多次单插入叠加到
  // 累积候选→重复 heading"(R8-K2)。仅日志,不改逻辑。带上界防无界增长。
  const bumpEditDraftExecuteCount = (runId: string): number => {
    const next = (editDraftExecuteCounts.get(runId) ?? 0) + 1;
    editDraftExecuteCounts.set(runId, next);
    if (editDraftExecuteCounts.size > 256) {
      const oldest = editDraftExecuteCounts.keys().next().value;
      if (oldest !== undefined) editDraftExecuteCounts.delete(oldest);
    }
    return next;
  };

  const editDraft = createTool({
    id: "editDraft",
    description:
      "对候选草稿执行原子编辑,支持 ops: replaceBlock/insertBlock/deleteBlock/replaceListItem/insertListItem/deleteListItem/insertTableRow/insertTableColumn/deleteTableRow/deleteTableColumn/replaceText/markText。\n" +
      "逐行拆分或改写诗词、歌词、剧本时,原文每个空行必须在原位产出一个空 <p></p>,不得吞并、挪走或合并相邻段落;诗词、歌词和剧本不得改用 <pre> 代码块承载。\n" +
      "把已有正文整理/重构成嵌套列表、或改成章>条>款层级时,先 readDraft 取目标块,再用 replaceBlock 把这些块重写成带层级的嵌套列表,尽量逐字保留原文,只动用户指定的范围。" +
      "多级列表统一用 QingML 嵌套标签表达:父 <li>/<task> 内放子 <ul>/<ol>/<tasks>,子列表的 <li>/<task> 才是下一层。3 级及以上也继续使用同一套嵌套 QingML,不要改成扁平中间格式,不要用 1.1/①/缩进文本假装层级。\n" +
      "只替换、插入或删除列表中的整行时,优先用行级 op: replaceListItem {ref,item} 保留目标行 ref; insertListItem {parentRef,at,ref?,item}; deleteListItem {ref}。item 是一个 <li>/<task> QingML 片段或裸行内片段;子层级放在该 <li>/<task> 内的子列表标签里,不要把 1.1/① 写成正文假装层级。taskList 行未传 checked 时 replaceListItem 保留原勾选状态。\n" +
      "表格单元格统一放块标签：简单形状 <td><p>文字</p></td>；多块形状 <td><p>结论</p><ul><li>依据</li></ul></td>，也支持 <ol>/<tasks>/<callout>。replaceBlock 重发表格时，必须逐块保留 readDraft 返回的 cell 内容，原有 colspan/rowspan 属性照抄；列宽由系统自动保留，不要改、清空或编造。cell/row 无稳定 ref，只能使用 table ref + 当前 0-based index。插删行列穿过合并区时系统按逻辑网格自动调整，只需按当前 readDraft 结构给 0-based 索引。\n" +
      "只给已有表格加/删行列时,优先用表格增量 op,不要 replaceBlock 重写整表: insertTableRow {ref,at,rowIndex?,cells}; insertTableColumn {ref,at,columnIndex?,cells}; deleteTableRow {ref,rowIndex}; deleteTableColumn {ref,columnIndex}。cells 是 <tr> 或 <td>/<th> QingML 片段。ref 指向 table 块本身;表格 cell/row 无稳定 id,rowIndex/columnIndex 一律是当前表的 0-based 索引;insert 的 at 只能是 before/after/end,before/after 必须传对应 rowIndex/columnIndex,end 不需要索引。同一次 editDraft 调用内多个表格 op 按声明顺序依次应用,后续 op 的索引以前序 op 应用后的当前表为准。跨轮引用索引不可靠,改表前先 readDraft 确认当前表结构。删除表头行、在表头行前插入数据行、索引越界、删除到 0 行/0 列会失败并返回可自纠错误;删除唯一数据行后只剩表头是合法的。新增列在表头行对应的新 cell 自动作为表头单元格。\n" +
      "block/blocks/item/cells 必须是 QingML 片段字符串(即 readDraft 返回里的 qingml 片段或按同规格改写后的片段),不要带 ref/editability/text 外壳。QingML 行内样式用 <b>/<i>/<a href=\"...\">/<mark color=\"...\">/<color val=\"...\"> 等标签表达。\n" +
      'markText 的 mark 参数仍是 JSON 标记对象:加链接用 {"type":"link","href":"https://…"},加粗用 {"type":"bold"}。\n' +
      "给已有正文里的某段文字加超链接:优先用 markText(find 命中该文字,mark:{\"type\":\"link\",\"href\":\"https://…\"},op:\"add\"),不必重写整块。",
    inputSchema: editDraftInputSchema,
    outputSchema: z.object({
      ok: z.boolean(),
      applied: z.array(z.string()),
      changed: z.boolean().optional(),
      hunkCount: z.number().optional(),
      blockCount: z.number().optional(),
      skippedDuplicateInserts: z.number().optional(),
      warning: z.string().optional(),
      error: z.string().optional(),
      failedOpIndex: z.number().optional(),
    }),
    execute: async (input, context) => {
      if (!state) return { ok: false, applied: [], error: "editDraft is unavailable outside a session" };
      // BB① 埋点:记录入口快照,便于复现"同一轮多次 editDraft.execute 把单插入叠加成重复 heading"。
      const turnRunId =
        (context?.requestContext?.get("runId") as string | null | undefined) ?? state.runId ?? "no-run";
      const editDraftToolCallId =
        (context as { agent?: { toolCallId?: string | null } } | undefined)?.agent?.toolCallId ?? null;
      const editDraftExecuteSeq = bumpEditDraftExecuteCount(turnRunId);
      let candidateDoc: PmDoc;
      try {
        candidateDoc = ensureDraftCandidateDoc(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 只把已知可由刷新自愈的重复标识转成模型可行动结果；其余初始化异常维持原抛错语义。
        if (!/重复 blockId/.test(message)) throw error;
        return {
          ok: false,
          applied: [],
          error: addDuplicateBlockIdRecoveryGuidance(message),
        };
      }
      const candidateBlocksBefore = candidateDoc.content.length;
      logger.info("[editDraft.execute] enter", {
        sessionId: state.sessionId,
        runId: turnRunId,
        toolCallId: editDraftToolCallId,
        executeSeqInTurn: editDraftExecuteSeq,
        candidateBlocksBefore,
        opsCount: input.ops.length,
        opsSummary: input.ops.map((op) => op.action),
      });
      let workingDoc = clonePmDoc(candidateDoc);
      const applied: string[] = [];
      let skippedDuplicateInserts = 0;

      for (let i = 0; i < input.ops.length; i += 1) {
        const op = input.ops[i]!;
        try {
          let blockEdit: BlockEdit | null = null;
          if (op.action === "replaceBlock") {
            const target = workingDoc.content.find((block) => block.attrs.blockId === op.ref);
            if (!target) return { ok: false, applied: [], error: `块 ${op.ref} 不存在,请先 readDraft`, failedOpIndex: i };
            const editability = analyzeAiIrEditability(target);
            if (!editability.replaceBlockAllowed) {
              return {
                ok: false,
                applied: [],
                error: `replaceBlock 拒绝有损块: ${editability.lossyReasons.join(", ")}`,
                failedOpIndex: i,
              };
            }
            const parsed = parseEditDraftQingmlFragment(op.block, "replaceBlock", "blocks");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            if (parsed.fragment.blocks.length !== 1) {
              return { ok: false, applied: [], error: "replaceBlock 期望单个 QingML block", failedOpIndex: i };
            }
            blockEdit = { action: "replaceBlock", ref: op.ref, block: parsed.fragment.blocks[0] };
          } else if (op.action === "insertBlock") {
            const parsed = parseEditDraftQingmlFragment(op.blocks, "insertBlock", "blocks");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            blockEdit = { action: "insertBlock", position: op.position, ref: op.ref, blocks: parsed.fragment.blocks };
          } else if (op.action === "deleteBlock") {
            blockEdit = { action: "deleteBlock", ref: op.ref };
          } else if (op.action === "replaceListItem") {
            const parsed = parseEditDraftQingmlFragment(op.item, "replaceListItem", "listItem");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            blockEdit = { action: "replaceListItem", ref: op.ref, item: parsed.fragment.item };
          } else if (op.action === "insertListItem") {
            const parsed = parseEditDraftQingmlFragment(op.item, "insertListItem", "listItem");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            blockEdit = {
              action: "insertListItem",
              parentRef: op.parentRef,
              at: op.at,
              ref: op.ref,
              item: parsed.fragment.item,
            };
          } else if (op.action === "deleteListItem") {
            blockEdit = { action: "deleteListItem", ref: op.ref };
          } else if (op.action === "insertTableRow") {
            const parsed = parseEditDraftQingmlFragment(op.cells, "insertTableRow", "row");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            blockEdit = {
              action: "insertTableRow",
              ref: op.ref,
              at: op.at,
              rowIndex: op.rowIndex,
              cells: parsed.fragment.cells,
            };
          } else if (op.action === "insertTableColumn") {
            const parsed = parseEditDraftQingmlFragment(op.cells, "insertTableColumn", "column");
            if (!parsed.ok) return { ok: false, applied: [], error: parsed.error, failedOpIndex: i };
            blockEdit = {
              action: "insertTableColumn",
              ref: op.ref,
              at: op.at,
              columnIndex: op.columnIndex,
              cells: parsed.fragment.cells,
            };
          } else if (op.action === "deleteTableRow") {
            blockEdit = { action: "deleteTableRow", ref: op.ref, rowIndex: op.rowIndex };
          } else if (op.action === "deleteTableColumn") {
            blockEdit = { action: "deleteTableColumn", ref: op.ref, columnIndex: op.columnIndex };
          } else {
            const textBlocks = collectTopLevelTextBlocks(workingDoc, op.withinRef);
            const matches = op.isRegex
              ? await findSafeRegexMatches(textBlocks, op.find, op.all === true)
              : findLiteralMatches(textBlocks, op.find, op.all === true);
            if (matches.length === 0) {
              return {
                ok: false,
                applied: [],
                error: "文本未命中或未唯一命中,请先 readDraft 后缩小 withinRef 或设置 all:true",
                failedOpIndex: i,
              };
            }
            if (op.action === "replaceText") {
              workingDoc = replaceTextRuns(workingDoc, matches, op.replace, op.isRegex === true);
            } else {
              const parsedMark = aiRunMarkSchema.safeParse(op.mark);
              if (!parsedMark.success) {
                return { ok: false, applied: [], error: parsedMark.error.message, failedOpIndex: i };
              }
              workingDoc = markTextRuns(
                workingDoc,
                matches,
                aiRunMarkToPmMark(parsedMark.data as AiRunMark),
                op.op,
              );
            }
            applied.push(...new Set(matches.map((match) => match.block.topBlockId)));
          }

          if (blockEdit) {
            await fillLocalSvgImageDimensions([blockEdit]);
            const blockResult = applyBlockEdits(workingDoc, [blockEdit]);
            if (!blockResult.ok || !blockResult.doc) {
              return {
                ok: false,
                applied: [],
                error: addDuplicateBlockIdRecoveryGuidance(blockResult.error),
                failedOpIndex: i,
              };
            }
            workingDoc = blockResult.doc;
            applied.push(...blockResult.applied);
            skippedDuplicateInserts += blockResult.skippedDuplicateInserts;
          }
        } catch (error) {
          return {
            ok: false,
            applied: [],
            error: error instanceof Error ? error.message : String(error),
            failedOpIndex: i,
          };
        }
      }

      if (skippedDuplicateInserts > 0) {
        logger.warn("[editDraft.execute] skipped duplicate insertBlock op(s)", {
          sessionId: state.sessionId,
          runId: turnRunId,
          toolCallId: editDraftToolCallId,
          skippedDuplicateInserts,
        });
      }

      const parsedDoc = safeParsePmDoc(workingDoc);
      if (!parsedDoc.success) {
        return { ok: false, applied: [], error: parsedDoc.error.message };
      }
      const scopeValidation = validateCurrentTableSelectionScopes(state, candidateDoc, workingDoc);
      if (!scopeValidation.ok) {
        const failedOpIndex = input.ops.findIndex((op) =>
          ("ref" in op && op.ref === scopeValidation.tableRef) ||
          ("withinRef" in op && op.withinRef === scopeValidation.tableRef),
        );
        return {
          ok: false,
          applied: [],
          error: scopeValidation.error,
          ...(failedOpIndex >= 0 ? { failedOpIndex } : {}),
        };
      }
      const candidate = replaceDraftCandidateDoc(state, workingDoc);
      context?.requestContext?.set("legacySections", candidate);
      context?.requestContext?.set("doc", state.docDraftCandidateDoc ?? workingDoc);
      const stats = currentDraftMutationStats(state);
      // BB① 埋点:出口块数(before→after),配合 executeSeqInTurn 可锁定重复叠加来源。
      logger.info("[editDraft.execute] applied", {
        sessionId: state.sessionId,
        runId: turnRunId,
        toolCallId: editDraftToolCallId,
        executeSeqInTurn: editDraftExecuteSeq,
        candidateBlocksBefore,
        candidateBlocksAfter: state.docDraftCandidateDoc?.content.length ?? workingDoc.content.length,
        appliedCount: applied.length,
      });
      const warning = skippedDuplicateInserts > 0
        ? `${skippedDuplicateInserts} 处插入与相邻内容重复被跳过;若确需重复内容,请用 replaceBlock 或换插入位置`
        : undefined;
      return {
        ok: true,
        applied,
        changed: stats.changed,
        hunkCount: stats.hunkCount,
        blockCount: state.docDraftCandidateDoc?.content.length ?? workingDoc.content.length,
        ...(skippedDuplicateInserts > 0 ? { skippedDuplicateInserts, warning } : {}),
      };
    },
  });

  const readDiff = createTool({
    id: "readDiff",
    description:
      "读取当前候选草稿相对基线的累计差异,包含文本、块和 markChange。",
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      changes: z.array(z.object({
        kind: z.enum(["replace", "insert", "delete", "markChange"]),
        ref: z.string().optional(),
        before: z.string().optional(),
        after: z.string().optional(),
      })),
      stats: z.object({
        blocksChanged: z.number(),
        marksChanged: z.number(),
        wordsAdded: z.number(),
        wordsRemoved: z.number(),
        totalWords: z.number(),
      }),
    }),
    execute: async () => {
      if (!state) {
        return {
          ok: false,
          changes: [],
          stats: { blocksChanged: 0, marksChanged: 0, wordsAdded: 0, wordsRemoved: 0, totalWords: 0 },
        };
      }
      const baseDoc = state.docDraftBaseDoc ?? currentPmDoc(state);
      const draftDoc = state.docDraftCandidateDoc ?? currentPmDoc(state);
      const hunks = buildDraftDiff(baseDoc, draftDoc, {
        baseVersion: state.docDraftBaseVersion ?? state.docVersion,
      });
      const changes = hunks.map((hunk) => ({
        kind: hunk.op === "markAdd" || hunk.op === "markRemove" ? "markChange" as const : hunk.op,
        ref: hunk.anchor.blockId,
        before: hunk.beforeText,
        after: hunk.afterText,
      }));
      const marksChanged = hunks.filter((hunk) => hunk.op === "markAdd" || hunk.op === "markRemove").length;
      const blocksChanged = hunks.length - marksChanged;
      const wordsAdded = hunks.reduce((sum, hunk) => sum + Math.max(0, (hunk.afterText ?? "").length - (hunk.beforeText ?? "").length), 0);
      const wordsRemoved = hunks.reduce((sum, hunk) => sum + Math.max(0, (hunk.beforeText ?? "").length - (hunk.afterText ?? "").length), 0);
      return {
        ok: true,
        changes,
        stats: {
          blocksChanged,
          marksChanged,
          wordsAdded,
          wordsRemoved,
          totalWords: countDocVisibleChars(draftDoc),
        },
      };
    },
  });

  const hasTableSelectionScope = state?._currentChips?.some(
    (chip) => chip.kind.kind === "selection" && chip.tableSelection !== undefined,
  ) ?? false;
  // 表格选区轮只能走带后置范围审计的 editDraft，整篇 writeDraft 会绕过物理行列边界。
  const writeDraft = state && !hasTableSelectionScope
    ? createWriteDraftTool({ state, replaceDraftCandidateDoc })
    : null;
  const executeCommand = state
    ? createGatedExecuteCommandTool({
        sessionId: state.sessionId,
        state,
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
      })
    : null;
  // 文件夹资料库 agent 工具:仅当会话连了文件夹源时注入(读文档/检索 + 受保护的工作区文件操作)。
  const hasFolderSources = state ? state.folderSources.size > 0 : false;
  const readDocument = state && hasFolderSources
    ? createReadDocumentTool({
        sessionId: state.sessionId,
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
        getSources: () => state.folderSources.values(),
      })
    : null;
  const searchDocuments = state && hasFolderSources
    ? createSearchDocumentsTool({
        sessionId: state.sessionId,
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
        getSources: () => state.folderSources.values(),
      })
    : null;
  const workspaceReadFile = state && hasFolderSources
    ? createProtectedFolderSourceReadFileTool({
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
      })
    : null;
  const workspaceEditFile = state && hasFolderSources
    ? createProtectedFolderSourceEditFileTool({
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
      })
    : null;
  const workspaceGrep = state && hasFolderSources
    ? createProtectedFolderSourceGrepTool({
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
      })
    : null;
  const workspaceSearch = state && hasFolderSources
    ? createProtectedFolderSourceSearchTool({
        getWorkspace: () => getQingagentSessionWorkspace(state.sessionId),
      })
    : null;
  const updateWorkingMemory = state ? createUpdateWorkingMemoryTool(state) : null;

  return {
    readMaterial,
    summarizeMaterial,
    readDraft: readDraftAiIr,
    readDraftAiIr,
    editDraft,
    createAnnotationGroups,
    readDiff,
    executeCommand,
    readDocument,
    searchDocuments,
    workspaceReadFile,
    workspaceEditFile,
    workspaceGrep,
    workspaceSearch,
    updateWorkingMemory,
    ...(writeDraft ? { writeDraft } : {}),
  };
}

function addDuplicateBlockIdRecoveryGuidance(error: string | undefined): string | undefined {
  if (!error || !/重复 blockId/.test(error)) return error;
  return `${error}；文档标识发生冲突，请提示用户刷新文档以触发自动修复后再试。`;
}
