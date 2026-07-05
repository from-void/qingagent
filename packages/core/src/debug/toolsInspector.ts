// F7 debug:工具原始视图数据(id/description/JSON Schema)。
// 放在 core 是因为 Agent 实例在这一层;server 的 /debug/tools 直接消费。

import {
  isStandardSchemaWithJSON,
  standardSchemaToJSONSchema,
  toStandardSchema,
} from "@mastra/core/schema";
import { qingagentAgent } from "../agents/qingagent.js";
import { webSearchTool } from "../tools/webSearch.js";
import { generateSvgTool } from "../tools/generateSvg.js";
import { scrapeWithBrowserTool } from "../tools/scrapeWithBrowser.js";
import { runJsTool } from "../tools/runJs.js";
import { getPyodideTools } from "../tools/runPython.js";

// capability 工具(按 skill 启用动态注入 toolset,不在 agent 固定工具里)——
// R2-C 发现 debug 页漏列 webSearch 等,这里静态登记原始 schema。
const CAPABILITY_TOOL_ENTRIES: Array<[string, unknown]> = [
  ["webSearch", webSearchTool],
  ["generateSvg", generateSvgTool],
  ["scrapeWithBrowser", scrapeWithBrowserTool],
  ["run_js", runJsTool],
];

export interface DebugToolEntry {
  id: string;
  description: string;
  group: string;
  inputSchema: unknown;
}

function toJsonSchemaSafe(schema: unknown): unknown {
  if (schema == null) return null;
  try {
    const standardSchema = isStandardSchemaWithJSON(schema)
      ? schema
      : toStandardSchema(schema as Parameters<typeof toStandardSchema>[0]);
    return standardSchemaToJSONSchema(standardSchema, { io: "input" });
  } catch {
    return { note: "schema 无法序列化" };
  }
}

/** 列出主 Agent 固定工具 + 会话作用域工具名录(闭包工具运行期注入,schema 略)。 */
export async function describeToolsForDebug(): Promise<DebugToolEntry[]> {
  const tools: DebugToolEntry[] = [];
  try {
    const agentTools = await qingagentAgent.listTools();
    for (const [id, tool] of Object.entries(agentTools ?? {})) {
      const record = tool as { description?: string; inputSchema?: unknown };
      tools.push({
        id,
        description: record.description ?? "",
        group: "agent",
        inputSchema: toJsonSchemaSafe(record.inputSchema),
      });
    }
  } catch {
    // agent 工具解析失败时仍返回会话工具名录
  }
  for (const [id, tool] of CAPABILITY_TOOL_ENTRIES) {
    const record = tool as { description?: string; inputSchema?: unknown };
    tools.push({
      id,
      description: record.description ?? "",
      group: "capability",
      inputSchema: toJsonSchemaSafe(record.inputSchema),
    });
  }
  for (const [id, tool] of Object.entries(getPyodideTools())) {
    const record = tool as { description?: string; inputSchema?: unknown };
    tools.push({
      id,
      description: record.description ?? "",
      group: "capability",
      inputSchema: toJsonSchemaSafe(record.inputSchema),
    });
  }
  for (const id of ["readMaterial", "summarizeMaterial", "readDraft", "editDraft", "readDiff", "writeDraft"]) {
    tools.push({
      id,
      description: "会话作用域工具(运行期以会话闭包注入,schema 略)",
      group: "sessionScoped",
      inputSchema: null,
    });
  }
  return tools;
}
