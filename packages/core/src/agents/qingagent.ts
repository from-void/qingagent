import { Agent, type ToolsInput } from "@mastra/core/agent";
import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { askUserTool } from "../tools/askUser.js";
import { parseFileTool } from "../tools/parseFile.js";
import { storeMaterialTool } from "../tools/storeMaterial.js";
import { fetchArticleTool } from "../tools/fetchArticle.js";
import { buildSystemPrompt } from "../prompts/system.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { isArchivedBuiltinSkillName } from "../skills/archived.js";
import { getSessionWorkspace } from "../workspace/sessionWorkspace.js";
import { getSessionFolderSources } from "../folderSources/runtime.js";
import { readDisabledSet } from "../skills/enabledStore.js";
import {
  createRepairingQingagentModel,
  wrapToolCallRepairingModel,
  qingagentModelConfig,
} from "../llm/repairingModel.js";
import type { RepairableLanguageModel, RepairingModelRouterLanguageModel } from "../llm/repairingModel.js";
import {
  todoAwarenessSourceFromRequestContext,
  wrapModelWithTodoAwareness,
} from "../llm/todoAwarenessPrompt.js";
import {
  omObservationsSourceFromRequestContext,
  wrapModelWithOmObservations,
} from "../llm/omObservationsPrompt.js";
import {
  anthropicBaseUrl,
  resolveBaseUrl,
  resolveDeepseekAuth,
  resolveDeepseekRouterModelId,
  resolveModelId,
  resolveProtocol,
} from "../llm/modelConfig.js";
import {
  buildQingagentInputProcessors,
  buildQingagentOutputProcessors,
} from "./processors.js";
import { isQingagentToolSearchEnabled } from "./toolSearch.js";
// 主 Agent 走 Mastra agent.stream(),需 v2/v3 spec model;Mastra 不内置 anthropic provider,
// 故 anthropic 用 AI SDK v5 版(@ai-sdk/anthropic@3,v3 spec)直接交给 Mastra。
// (工具内层走 ai v4 streamText 仍用 v1 版,见 modelConfig.createDeepseekProvider)
import { createAnthropic as createAnthropicV5 } from "@ai-sdk/anthropic-v5";
import type { RequestContext } from "@mastra/core/request-context";
// F1 两层 key:模型实例按"实际生效的 apiKey"缓存——env 兜底请求共用一个实例(等价
// 旧单例,保留 prompt-cache 等收益),访客自带 key 的请求各自命中自己的缓存项。
// 上限防滥用:访客 key 任意多,缓存只留最近 16 个。
type AgentAnthropicModel = ReturnType<ReturnType<typeof createAnthropicV5>>;
type RepairingAgentAnthropicModel = AgentAnthropicModel & RepairableLanguageModel;
const modelCache = new Map<string, RepairingModelRouterLanguageModel | RepairingAgentAnthropicModel>();
const MODEL_CACHE_LIMIT = 16;

function getRepairingModelFor(
  requestContext?: RequestContext,
): RepairingModelRouterLanguageModel | RepairingAgentAnthropicModel {
  const todoAwarenessSource = todoAwarenessSourceFromRequestContext(requestContext);
  const omObservationsSource = omObservationsSourceFromRequestContext(requestContext);
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const effectiveKey = apiKey || qingagentModelConfig.apiKey;
  const baseUrl = resolveBaseUrl(requestContext);
  const evict = () => {
    if (modelCache.size >= MODEL_CACHE_LIMIT) {
      const oldest = modelCache.keys().next().value;
      if (oldest !== undefined) modelCache.delete(oldest);
    }
  };

  // anthropic(智谱 GLM Coding 等):保留 v3 provider 原始 spec,只在 tool-call 参数 JSON 上加 fail-closed 修复层。
  if (resolveProtocol(requestContext) === "anthropic") {
    const anthModel = resolveModelId(requestContext, "flash");
    const anthKey = `anthropic ${baseUrl} ${anthModel} ${effectiveKey}`;
    let m = modelCache.get(anthKey);
    if (!m) {
      m = wrapToolCallRepairingModel(
        createAnthropicV5({ baseURL: anthropicBaseUrl(baseUrl), apiKey: effectiveKey })(
          anthModel,
        ) as RepairingAgentAnthropicModel,
      );
      evict();
      modelCache.set(anthKey, m);
    }
    return wrapModelWithTodoAwareness(
      wrapModelWithOmObservations(m, omObservationsSource),
      todoAwarenessSource,
    );
  }

  const modelId = resolveDeepseekRouterModelId(requestContext, "flash");
  // 缓存键含 baseURL + modelId + key:不同中转/别名/key 各自命中独立实例
  const cacheKey = `${baseUrl}|${modelId}|${effectiveKey}`;
  let model = modelCache.get(cacheKey);
  if (!model) {
    model = createRepairingQingagentModel({ id: modelId, url: baseUrl, apiKey: effectiveKey });
    evict();
    modelCache.set(cacheKey, model);
  }
  return wrapModelWithTodoAwareness(
    wrapModelWithOmObservations(model, omObservationsSource),
    todoAwarenessSource,
  );
}

const BUILTIN_SKILL_CATEGORIES = ["capability", "native", "style"] as const;

async function hasSkillFile(dir: string): Promise<boolean> {
  try {
    await access(join(dir, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

async function collectSkillDirs(root: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (isArchivedBuiltinSkillName(entry.name)) continue;
    if (await hasSkillFile(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * 把技能目录路径规范成正斜杠。@mastra/core 的 Workspace 加载技能时,用 lastIndexOf("/")/
 * split("/") 这类 POSIX 字符串操作取目录名做「技能名==目录名」校验(私有 #getParentPath);
 * Windows 反斜杠路径会让它取到整条路径 → 校验失败 → 所有技能加载失败。Node fs 在 Windows 上
 * 同样接受正斜杠,故磁盘读取不受影响。见 chunk-7OCF5TOO.cjs #getParentPath(6775) / addSkill(6058)。
 */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function resolveEnabledSkillDirs(): Promise<string[]> {
  let disabled = new Set<string>();
  try {
    disabled = await readDisabledSet();
  } catch {
    disabled = new Set<string>();
  }
  const roots = [
    ...BUILTIN_SKILL_CATEGORIES.map((category) => join(BUILTIN_SKILLS_DIR, category)),
    USER_SKILLS_DIR,
  ];
  return resolveEnabledSkillDirsFromRoots(roots, disabled);
}

export async function resolveEnabledSkillDirsFromRoots(
  roots: string[],
  disabled: Set<string>,
): Promise<string[]> {
  const groups = await Promise.all(
    roots.map(async (root) => {
      try {
        return await collectSkillDirs(root);
      } catch {
        // A broken user install directory or mount must not make all built-in
        // skills disappear from the Workspace.
        return [];
      }
    }),
  );
  return groups
    .flat()
    .filter((dir) => !disabled.has(dir.split(/[\\/]/).pop() ?? ""))
    .map(toPosixPath);
}

async function resolveSessionCredentialEnv(): Promise<Record<string, string>> {
  try {
    const { getAllCredentialEnv } = await import("../credentials/credentialsRepo.js");
    return await getAllCredentialEnv();
  } catch (error) {
    console.error("[sessionWorkspace] 凭据注入读取失败", error);
    return {};
  }
}

export async function getQingagentSessionWorkspace(sessionId: string): Promise<Workspace> {
  return await getSessionWorkspace(sessionId, {
    resolveSkillDirs: resolveEnabledSkillDirs,
    // 凭据注入:把仍走后端托管的平台凭据(钉钉等)解密后注入沙箱 env,
    // CLI skill 脚本从 env 读取认证信息。读失败不阻断沙箱(返回空)。
    resolveCredentialEnv: resolveSessionCredentialEnv,
    resolveFolderSources: getSessionFolderSources,
  });
}

/** 全局兜底 Workspace:技能发现/列表(getQingagentSkills)与无会话上下文时使用。
 *  不带沙箱——命令执行能力只存在于会话级 Workspace。 */
export const qingagentWorkspace = new Workspace({
  filesystem: new LocalFilesystem({
    basePath: BUILTIN_SKILLS_DIR,
    allowedPaths: [USER_SKILLS_DIR],
  }),
  skills: resolveEnabledSkillDirs,
});

/** 会话级 Workspace 解析:带 sessionId 的对话拿到"私有目录+技能只读+LocalSandbox"
 *  的完整沙箱;解析失败或无会话上下文回退全局兜底,绝不拖死主链。 */
async function resolveWorkspaceForRequest({
  requestContext,
}: {
  requestContext?: { get?: (key: string) => unknown };
}): Promise<Workspace> {
  // 测试环境旁路:现有 mock 测试经 agent.stream 间接触发本解析,不应装配重量级
  // LocalSandbox(真实 mkdir+子进程探测)——并行下会拖垮无关测试。沙箱能力由
  // sessionWorkspace.test/exec.test 直接调 getSessionWorkspace 覆盖,无需经此路径。
  // QINGAGENT_FORCE_SESSION_SANDBOX=1 可在需要端到端测沙箱时强制开启。
  if (process.env.VITEST && process.env.QINGAGENT_FORCE_SESSION_SANDBOX !== "1") {
    return qingagentWorkspace;
  }
  const sessionId = requestContext?.get?.("sessionId");
  if (typeof sessionId === "string" && sessionId.length > 0) {
    try {
      return await getQingagentSessionWorkspace(sessionId);
    } catch (error) {
      console.error("[sessionWorkspace] 装配失败,回退全局 Workspace", error);
    }
  }
  return qingagentWorkspace;
}

/**
 * Qingagent agent — AI writing assistant powered by DeepSeek.
 *
 * Uses a V2 ModelRouterLanguageModel subclass so tool-call JSON can be repaired
 * before Mastra parses the tool arguments.
 *
 * NOTE: readMaterial and summarizeMaterial are NOT registered here.
 * They are injected as session-scoped closures via the `toolsets`
 * stream option in runAgentTurn.ts so they can access the real
 * session state.materials map.
 *
 * Draft tools are injected as session-scoped closures via sessionTools.ts.
 */
export const qingagentAgent = new Agent({
  id: "qingagent",
  name: "Qingagent Writing Assistant",
  description: "AI 写作助手，帮助用户创作中文文档",
  // 惰性构建:repairingModel → writeDraft → AI-IR 编译共享设施 → mastra → 本文件 构成
  // 模块环;顶层立即调用在"测试直接 import repairingModel"时会循环回到这里、
  // 函数尚未定义而炸(repairToolCallJson.test 收集失败)。推迟到首次取模型时再建。
  // F1:按 requestContext 解析两层 key(visitor > global-db > env),实例按 key 缓存。
  model: ({ requestContext }) => getRepairingModelFor(requestContext),
  inputProcessors: buildQingagentInputProcessors,
  outputProcessors: buildQingagentOutputProcessors,
  instructions: () => buildSystemPrompt(),
  tools: (): ToolsInput => buildQingagentStaticTools(),
  workspace: resolveWorkspaceForRequest,
});

export function buildQingagentStaticTools(): ToolsInput {
  if (isQingagentToolSearchEnabled()) {
    return {
      askUser: askUserTool,
      storeMaterial: storeMaterialTool,
    };
  }
  return {
    askUser: askUserTool,
    parseFile: parseFileTool,
    storeMaterial: storeMaterialTool,
    fetchArticle: fetchArticleTool,
  };
}

export async function getQingagentSkills() {
  const workspace = await qingagentAgent.getWorkspace();
  const skills = workspace?.skills;
  if (!skills) {
    throw new Error("Qingagent workspace skills are not configured");
  }
  return skills;
}
