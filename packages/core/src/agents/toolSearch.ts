import type { Tool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { ToolSearchProcessor } from "@mastra/core/processors";
import { resolveDeepseekRouterModelId } from "../llm/modelConfig.js";

export const QINGAGENT_TOOL_SEARCH_ENV = "QINGAGENT_TOOL_SEARCH";
export const QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY =
  "qingagentToolSearchProcessor";

export type QingagentToolSearchProcessor = ToolSearchProcessor;
export type QingagentToolSearchTools = Record<string, Tool<any, any>>;

function isEnabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isQingagentToolSearchEnabled(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return isEnabledFlag(env[QINGAGENT_TOOL_SEARCH_ENV]);
}

export function createQingagentToolSearchProcessor(
  tools: QingagentToolSearchTools,
): QingagentToolSearchProcessor {
  return new ToolSearchProcessor({
    tools,
    storage: "context",
    search: {
      topK: 3,
      minScore: 0,
      autoLoad: true,
    },
  });
}

export function toolSearchProcessorFromRequestContext(
  requestContext?: RequestContext,
): QingagentToolSearchProcessor | null {
  const processor = requestContext?.get(QINGAGENT_TOOL_SEARCH_PROCESSOR_CONTEXT_KEY);
  return processor instanceof ToolSearchProcessor ? processor : null;
}

export async function preloadQingagentToolSearchTools({
  processor,
  requestContext,
  messages,
  toolNames,
}: {
  processor: QingagentToolSearchProcessor;
  requestContext: RequestContext;
  messages: unknown[];
  toolNames: string[];
}): Promise<string[]> {
  const uniqueToolNames = Array.from(new Set(toolNames.filter(Boolean)));
  if (uniqueToolNames.length === 0) return [];
  const step = await processor.processInputStep({
    messages: messages as never,
    messageList: { addSystem: () => undefined } as never,
    stepNumber: 0,
    steps: [],
    systemMessages: [],
    state: {},
    model: resolveDeepseekRouterModelId(requestContext, "flash") as never,
    tools: {},
    requestContext,
    retryCount: 0,
    abort: (reason?: string): never => {
      throw new Error(reason ?? "ToolSearch preload aborted");
    },
  });
  const searchTool = step.tools?.search_tools as {
    execute?: (input: { query: string }) => Promise<unknown>;
  } | undefined;
  if (!searchTool?.execute) return [];
  const loaded: string[] = [];
  for (const toolName of uniqueToolNames) {
    const result = await searchTool.execute({ query: toolName });
    if (toolSearchResultIncludesTool(result, toolName)) loaded.push(toolName);
  }
  return loaded;
}

export function extractLoadedToolNamesFromToolSearchResult(result: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) {
      names.add(record.name);
    }
    if (Array.isArray(record.results)) {
      for (const item of record.results) visit(item);
    }
    if (Array.isArray(record.loaded)) {
      for (const item of record.loaded) {
        if (typeof item === "string" && item.length > 0) names.add(item);
        else visit(item);
      }
    }
    if (Array.isArray(record.tools)) {
      for (const item of record.tools) visit(item);
    }
  };
  visit(result);
  return Array.from(names);
}

function toolSearchResultIncludesTool(result: unknown, toolName: string): boolean {
  if (!result || typeof result !== "object") return false;
  const results = (result as { results?: unknown }).results;
  return Array.isArray(results) &&
    results.some((entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as { name?: unknown }).name === toolName
    );
}
