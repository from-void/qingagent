import { Agent, type ToolsInput } from "@mastra/core/agent";
import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { join } from "node:path";
import { planDraftTool } from "../tools/planDraft.js";
import { askUserQuestionTool } from "../tools/askUserQuestion.js";
import { parseFileTool } from "../tools/parseFile.js";
import { storeMaterialTool } from "../tools/storeMaterial.js";
import { buildSystemPrompt } from "../prompts/system.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { isArchivedBuiltinSkillName } from "../skills/archived.js";
import { getSessionWorkspace } from "../workspace/sessionWorkspace.js";
import { getSessionFolderSources } from "../folderSources/runtime.js";
import { readDisabledSet } from "../skills/enabledStore.js";
import { listTopLevelSkills } from "../skills/discovery.js";
import { beforeSkillToolCall } from "../skills/toolGate.js";
import {
  wrapToolCallRepairingModel,
} from "../llm/repairingModel.js";
import type { RepairableLanguageModel } from "../llm/repairingModel.js";
import {
  todoAwarenessSourceFromRequestContext,
  wrapModelWithTodoAwareness,
} from "../llm/todoAwarenessPrompt.js";
import {
  omObservationsSourceFromRequestContext,
  wrapModelWithOmObservations,
} from "../llm/omObservationsPrompt.js";
import {
  docVersionAwarenessSourceFromRequestContext,
  wrapModelWithDocVersionAwareness,
} from "../llm/docVersionAwarenessPrompt.js";
import {
  diagramVizEditingSourceFromRequestContext,
  wrapModelWithDiagramVizEditing,
} from "../llm/diagramVizEditingPrompt.js";
import {
  anthropicBaseUrl,
  createSnapshottingQingagentModel,
  resolveBaseUrl,
  resolveDeepseekAuth,
  resolveModelId,
  resolveProtocol,
} from "../llm/modelConfig.js";
import {
  buildQingagentInputProcessors,
  buildQingagentOutputProcessors,
} from "./processors.js";
import { isQingagentToolSearchEnabled } from "./toolSearch.js";
// 主 Agent 与工具内层统一使用 AI SDK 5 的 v2 provider；Mastra 自身的 ai v4 peer
// 由包管理器隔离，provider 统一从 canonical 包导入。
import { createAnthropic } from "@ai-sdk/anthropic";
import type { RequestContext } from "@mastra/core/request-context";
import { wrapModernModelUsage } from "../llm/modernUsageModel.js";
import { modelFetch } from "../llm/modelTransport.js";
// F1 两层 key:模型实例按"实际生效的 apiKey"缓存——env 兜底请求共用一个实例(等价
// 旧单例,保留 prompt-cache 等收益),访客自带 key 的请求各自命中自己的缓存项。
// 上限防滥用:访客 key 任意多,缓存只留最近 16 个。
type AgentAnthropicModel = ReturnType<ReturnType<typeof createAnthropic>>;
type RepairingAgentAnthropicModel = AgentAnthropicModel & RepairableLanguageModel;
const modelCache = new Map<string, RepairingAgentAnthropicModel>();
const MODEL_CACHE_LIMIT = 16;

function getRepairingModelFor(requestContext?: RequestContext) {
  const todoAwarenessSource = todoAwarenessSourceFromRequestContext(requestContext);
  const omObservationsSource = omObservationsSourceFromRequestContext(requestContext);
  const docVersionAwarenessSource =
    docVersionAwarenessSourceFromRequestContext(requestContext);
  const diagramVizEditingSource =
    diagramVizEditingSourceFromRequestContext(requestContext);
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const effectiveKey = apiKey;
  const baseUrl = resolveBaseUrl(requestContext);
  const evict = () => {
    if (modelCache.size >= MODEL_CACHE_LIMIT) {
      const oldest = modelCache.keys().next().value;
      if (oldest !== undefined) modelCache.delete(oldest);
    }
  };

  // anthropic(智谱 GLM Coding 等):保留 v2 provider 原始 spec,只在 tool-call 参数 JSON 上加 fail-closed 修复层。
  if (resolveProtocol(requestContext) === "anthropic") {
    const anthModel = resolveModelId(requestContext, "flash");
    const anthKey = `anthropic ${baseUrl} ${anthModel} ${effectiveKey}`;
    let m = modelCache.get(anthKey);
    if (!m) {
      m = wrapToolCallRepairingModel(
        createAnthropic({
          baseURL: anthropicBaseUrl(baseUrl),
          apiKey: effectiveKey,
          fetch: modelFetch,
        })(
          anthModel,
        ) as RepairingAgentAnthropicModel,
      );
      evict();
      modelCache.set(anthKey, m);
    }
    const contextualModel = wrapModelWithTodoAwareness(
      wrapModelWithOmObservations(
        wrapModelWithDocVersionAwareness(
          wrapModelWithDiagramVizEditing(m, diagramVizEditingSource),
          docVersionAwarenessSource,
        ),
        omObservationsSource,
      ),
      todoAwarenessSource,
    );
    return maybeTrackNonBridgeModel(contextualModel, requestContext);
  }

  // OpenAI 兼容主链按 requestContext 建轻量 provider，fetch 闭包才能只把本 turn 的最终
  // provider body 写入该会话快照；底层 HTTP/DeepSeek prompt cache 不依赖 JS model 实例复用。
  const model = wrapToolCallRepairingModel(
    createSnapshottingQingagentModel(requestContext),
    { guardProviderCall: true },
  );
  const contextualModel = wrapModelWithTodoAwareness(
    wrapModelWithOmObservations(
      wrapModelWithDocVersionAwareness(
        wrapModelWithDiagramVizEditing(model, diagramVizEditingSource),
        docVersionAwarenessSource,
      ),
      omObservationsSource,
    ),
    todoAwarenessSource,
  );
  return maybeTrackNonBridgeModel(contextualModel, requestContext);
}

/** 正常主链仍由 processAgentStream 按 step 记账；live eval 不经过 bridge，显式接请求级包装。 */
function maybeTrackNonBridgeModel<T extends object>(model: T, requestContext?: RequestContext): T {
  const callSite = requestContext?.get("usageCallSite");
  if (typeof callSite !== "string" || !callSite) return model;
  return wrapModernModelUsage(model, {
    requestContext,
    callSite,
    modelId: resolveModelId(requestContext, "flash"),
    keyOrigin: resolveDeepseekAuth(requestContext).origin,
  });
}

const BUILTIN_SKILL_CATEGORIES = ["capability", "native", "style"] as const;

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
        return await listTopLevelSkills(root);
      } catch {
        // A broken user install directory or mount must not make all built-in
        // skills disappear from the Workspace.
        return [];
      }
    }),
  );
  return groups
    .flat()
    .filter((skill) => !isArchivedBuiltinSkillName(skill.metadata.name))
    .filter((skill) => !disabled.has(skill.metadata.name))
    .map((skill) => toPosixPath(skill.path));
}

export async function getQingagentSessionWorkspace(sessionId: string): Promise<Workspace> {
  return await getSessionWorkspace(sessionId, {
    resolveSkillDirs: resolveEnabledSkillDirs,
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
  // 惰性构建:按请求解析模型配置，避免模块加载期固化凭据与请求上下文。
  // F1:按 requestContext 解析两层 key(visitor > global-db > env),实例按 key 缓存。
  model: ({ requestContext }) => getRepairingModelFor(requestContext),
  inputProcessors: buildQingagentInputProcessors,
  outputProcessors: buildQingagentOutputProcessors,
  instructions: () => buildSystemPrompt(),
  tools: (): ToolsInput => buildQingagentStaticTools(),
  hooks: {
    beforeToolCall: beforeSkillToolCall,
  },
  workspace: resolveWorkspaceForRequest,
});

export function buildQingagentStaticTools(): ToolsInput {
  // 新轮只暴露语义化工具名；legacy askUser 仅在旧快照 resume 时按执行注入，
  // 待老会话数据迁移或过期后连同兼容注入一起删除。
  if (isQingagentToolSearchEnabled()) {
    return {
      planDraft: planDraftTool,
      askUserQuestion: askUserQuestionTool,
      storeMaterial: storeMaterialTool,
    };
  }
  return {
    planDraft: planDraftTool,
    askUserQuestion: askUserQuestionTool,
    parseFile: parseFileTool,
    storeMaterial: storeMaterialTool,
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
