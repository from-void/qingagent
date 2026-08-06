import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import {
  WORKSPACE_TOOLS,
  createWorkspaceTools,
  editFileTool,
  listFilesTool,
  readFileTool,
  searchTool,
  type Workspace,
} from "@mastra/core/workspace";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";
import { guardToolModelOutputMapper } from "../tools/toolModelOutput.js";

type ToolLike = {
  id: string;
  description: string;
  inputSchema?: unknown;
  toModelOutput?: (output: unknown) => unknown;
  execute?: (input: never, context?: unknown) => Promise<unknown> | unknown;
};

const FOLDER_SOURCE_DENY_ERROR =
  "拒绝通过通用 workspace 工具读取 /sources 资料库内容。请使用 readDocument 读取文件，或使用 searchDocuments 检索资料库；只浏览目录结构可用 mastra_workspace_list_files。";

const ROOT_WIDE_GREP_DENY_ERROR =
  "拒绝在有资料库的会话中执行未限定范围的通用 grep，因为它可能扫描 /sources 正文。请把 path 显式限定到 /workspace 或 /skills；检索资料库请使用 searchDocuments。";

const grepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().default("."),
  contextLines: z.number().optional().default(0),
  maxCount: z.number().optional(),
  caseSensitive: z.boolean().optional().default(true),
  includeHidden: z.boolean().optional().default(false),
});

const workspaceSearchInputSchema = z.object({
  query: z.string().describe("Search query"),
  topK: z.number().optional(),
  mode: z.enum(["bm25", "vector", "hybrid"]).optional(),
  minScore: z.number().optional(),
});

export interface ProtectedFolderSourceWorkspaceToolOptions {
  getWorkspace: () => Promise<Workspace>;
}

function normalizeVirtualPathForDecision(path: string): string {
  const slashPath = path.trim().replace(/\\/g, "/");
  const normalized = posixPath.normalize(slashPath);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function isFolderSourceVirtualPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = normalizeVirtualPathForDecision(value);
  return normalized === "/sources" || normalized.startsWith("/sources/");
}

function isWorkspaceOrSkillsPath(value: string): boolean {
  const normalized = normalizeVirtualPathForDecision(value);
  return (
    normalized === "/workspace" ||
    normalized.startsWith("/workspace/") ||
    normalized === "/skills" ||
    normalized.startsWith("/skills/")
  );
}

function shouldRejectGrepPath(rawPath: string | undefined): string | null {
  const path = rawPath ?? ".";
  if (isFolderSourceVirtualPath(path)) {
    return FOLDER_SOURCE_DENY_ERROR;
  }
  if (!isWorkspaceOrSkillsPath(path)) {
    return ROOT_WIDE_GREP_DENY_ERROR;
  }
  return null;
}

async function withWorkspaceContext(
  context: unknown,
  getWorkspace: () => Promise<Workspace>,
): Promise<unknown> {
  if ((context as { workspace?: Workspace } | undefined)?.workspace) return context;
  return { ...(context as object | undefined), workspace: await getWorkspace() };
}

function workspaceWithToolEnabled(workspace: Workspace, toolName: string): Workspace {
  return new Proxy(workspace, {
    get(target, prop, receiver) {
      if (prop === "getToolsConfig") {
        return () => {
          const config = target.getToolsConfig();
          if (!config) return config;
          return {
            ...config,
            [toolName]: {
              ...((config as Record<string, unknown>)[toolName] as Record<string, unknown> | undefined),
              enabled: true,
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function getDelegatedWorkspaceTool(
  workspace: Workspace,
  toolName: string,
  context: unknown,
): Promise<ToolLike> {
  const delegateWorkspace = workspaceWithToolEnabled(workspace, toolName);
  const tools = await createWorkspaceTools(delegateWorkspace, {
    requestContext: (context as { requestContext?: unknown } | undefined)?.requestContext,
    workspace: delegateWorkspace,
  });
  const tool = tools[toolName] as ToolLike | undefined;
  if (!tool?.execute) {
    throw new Error(`Mastra workspace tool is unavailable: ${toolName}`);
  }
  return tool;
}

function denied(error: string) {
  return { ok: false, error };
}

function expandFolderSourceTreePaths(output: unknown, rootPath: string): unknown {
  if (typeof output !== "string") return output;
  const normalizedRoot = normalizeVirtualPathForDecision(rootPath).replace(/\/$/, "");
  const segments: string[] = [];
  let inTree = true;

  return output
    .split("\n")
    .map((line) => {
      if (!inTree || line.length === 0) {
        if (line.length === 0) inTree = false;
        return line;
      }
      if (line === ".") return normalizedRoot;
      if (line.startsWith("[output truncated:")) return line;

      const match = /^(\t*)(.+)$/.exec(line);
      if (!match) return line;
      const depth = match[1]?.length ?? 0;
      const name = match[2];
      if (!name) return line;
      segments.length = depth;
      segments[depth] = name;
      return posixPath.join(normalizedRoot, ...segments);
    })
    .join("\n");
}

function isFolderSourceSearchResult(result: Awaited<ReturnType<Workspace["search"]>>[number]): boolean {
  const metadataPath = result.metadata?.path;
  if (isFolderSourceVirtualPath(result.id)) return true;
  return typeof metadataPath === "string" && isFolderSourceVirtualPath(metadataPath);
}

function effectiveSearchMode(
  workspace: Workspace,
  requested?: "bm25" | "vector" | "hybrid",
): "bm25" | "vector" | "hybrid" {
  if (requested === "hybrid" && !workspace.canHybrid) {
    return workspace.canVector ? "vector" : "bm25";
  }
  if (requested === "vector" && !workspace.canVector) {
    return "bm25";
  }
  return requested ?? (workspace.canHybrid ? "hybrid" : workspace.canVector ? "vector" : "bm25");
}

export function createProtectedFolderSourceReadFileTool(
  options: ProtectedFolderSourceWorkspaceToolOptions,
) {
  return createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
    description:
      `${readFileTool.description}\n\n` +
      "安全限制：本工具不能读取 /sources 资料库正文；资料库文件请改用 readDocument，资料库检索请改用 searchDocuments。",
    inputSchema: readFileTool.inputSchema,
    toModelOutput: guardToolModelOutputMapper(readFileTool.toModelOutput),
    execute: async (input, context) => {
      if (isFolderSourceVirtualPath(input.path)) {
        return denied(FOLDER_SOURCE_DENY_ERROR);
      }
      const stop = startToolHeartbeat(context, { tool: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE });
      try {
        const delegatedContext = await withWorkspaceContext(context, options.getWorkspace);
        return await readFileTool.execute?.(
          input as never,
          delegatedContext as ToolExecutionContext,
        );
      } finally {
        stop();
      }
    },
  });
}

export function createFolderSourceListFilesTool(
  options: ProtectedFolderSourceWorkspaceToolOptions,
) {
  return createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
    description:
      `${listFilesTool.description}\n\n` +
      "路径契约：列举 /sources 资料库时，每个条目都返回可直接传给 readDocument 的完整虚拟路径。",
    inputSchema: listFilesTool.inputSchema,
    toModelOutput: listFilesTool.toModelOutput,
    execute: async (input, context) => {
      const stop = startToolHeartbeat(context, { tool: WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES });
      try {
        const delegatedContext = await withWorkspaceContext(context, options.getWorkspace);
        const output = await listFilesTool.execute?.(
          input as never,
          delegatedContext as ToolExecutionContext,
        );
        return isFolderSourceVirtualPath(input.path)
          ? expandFolderSourceTreePaths(output, input.path)
          : output;
      } finally {
        stop();
      }
    },
  });
}

export function createProtectedFolderSourceEditFileTool(
  options: ProtectedFolderSourceWorkspaceToolOptions,
) {
  return createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
    description:
      `${editFileTool.description}\n\n` +
      "安全限制：本工具不能编辑 /sources 资料库文件；资料库是只读的，读取请改用 readDocument，检索请改用 searchDocuments。",
    inputSchema: editFileTool.inputSchema,
    toModelOutput: guardToolModelOutputMapper(editFileTool.toModelOutput),
    execute: async (input, context) => {
      if (isFolderSourceVirtualPath(input.path)) {
        return denied(FOLDER_SOURCE_DENY_ERROR);
      }
      const stop = startToolHeartbeat(context, { tool: WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE });
      try {
        const delegatedContext = await withWorkspaceContext(context, options.getWorkspace);
        return await editFileTool.execute?.(
          input as never,
          delegatedContext as ToolExecutionContext,
        );
      } finally {
        stop();
      }
    },
  });
}

export function createProtectedFolderSourceGrepTool(
  options: ProtectedFolderSourceWorkspaceToolOptions,
) {
  return createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.GREP,
    description:
      "Search file contents using a regex pattern. Walks the workspace filesystem and returns matching lines with file paths and line numbers.\n\n" +
      "安全限制：本工具不能搜索 /sources 资料库正文；资料库检索请改用 searchDocuments。",
    inputSchema: grepInputSchema,
    execute: async (input, context) => {
      const denyReason = shouldRejectGrepPath(input.path);
      if (denyReason) return denied(denyReason);
      const stop = startToolHeartbeat(context, { tool: WORKSPACE_TOOLS.FILESYSTEM.GREP });
      try {
        const delegatedContext = await withWorkspaceContext(context, options.getWorkspace);
        const workspace = (delegatedContext as { workspace?: Workspace } | undefined)?.workspace;
        if (!workspace) throw new Error("workspace filesystem is not configured");
        const delegatedTool = await getDelegatedWorkspaceTool(
          workspace,
          WORKSPACE_TOOLS.FILESYSTEM.GREP,
          delegatedContext,
        );
        return await delegatedTool.execute?.(input as never, delegatedContext);
      } finally {
        stop();
      }
    },
  });
}

export function createProtectedFolderSourceSearchTool(
  options: ProtectedFolderSourceWorkspaceToolOptions,
) {
  return createTool({
    id: WORKSPACE_TOOLS.SEARCH.SEARCH,
    description:
      `${searchTool.description}\n\n` +
      "安全限制：本工具不会返回 /sources 资料库正文或路径命中；资料库检索请改用 searchDocuments。",
    inputSchema: workspaceSearchInputSchema,
    toModelOutput: guardToolModelOutputMapper(searchTool.toModelOutput),
    execute: async (input, context) => {
      const stop = startToolHeartbeat(context, { tool: WORKSPACE_TOOLS.SEARCH.SEARCH });
      try {
        const delegatedContext = await withWorkspaceContext(context, options.getWorkspace);
        const workspace = (delegatedContext as { workspace?: Workspace } | undefined)?.workspace;
        if (!workspace) throw new Error("workspace search is not configured");
        const mode = effectiveSearchMode(workspace, input.mode);
        const results = await workspace.search(input.query, {
          topK: input.topK,
          mode,
          minScore: input.minScore,
        });
        const safeResults = results.filter((result) => !isFolderSourceSearchResult(result));
        const lines = safeResults.map((result) => {
          const lineInfo = result.lineRange ? `:${result.lineRange.start}-${result.lineRange.end}` : "";
          return `${result.id}${lineInfo}: ${result.content}`;
        });
        lines.push("---");
        lines.push(`${safeResults.length} result${safeResults.length !== 1 ? "s" : ""} (${mode} search)`);
        return lines.join("\n");
      } finally {
        stop();
      }
    },
  });
}
