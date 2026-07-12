import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getConnectorService } from "../connectors/connectorService.js";
import type { FeishuStartResult } from "../connectors/feishuConnector.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

export const feishuAuthDomainSchema = z.enum([
  "docs", "base", "sheets", "calendar", "im", "drive", "mail", "task",
  "approval", "contact", "minutes", "wiki",
]);

export const feishuAuthStartTool = createTool({
  id: "feishu_auth_start",
  description: "发起飞书应用配置或用户授权卡。按本次意图选择最小 domains；连接器自动完成扫码收尾与状态复核。",
  inputSchema: z.object({ domains: z.array(feishuAuthDomainSchema).min(1).max(12) }).strict(),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "feishu_auth_start" });
    try { return await getConnectorService().start("feishu", input) as FeishuStartResult; }
    finally { stop(); }
  },
});
