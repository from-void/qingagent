import { createTool } from "@mastra/core/tools";
import { getConnectorService } from "../../../connectors/connectorService.js";
import type { FeishuStartResult } from "../../../connectors/feishuConnector.js";
import {
  FEISHU_AUTH_START_TOOL,
  feishuAuthDomainSchema,
  feishuAuthStartInputSchema,
} from "../../../confirm/connectAccountConfirmation.js";
import { isBypassEnabled } from "../../../security/bypassMode.js";
import { startToolHeartbeat } from "../../toolHeartbeat.js";

export { feishuAuthDomainSchema };

export const feishuAuthStartTool = createTool({
  id: FEISHU_AUTH_START_TOOL,
  description: "发起飞书应用配置或用户授权；流层会自动展示扫码授权卡，连接器自动完成扫码收尾与状态复核，不要再调用 show_qr 或复述配对码。按本次意图选择最小 domains。",
  inputSchema: feishuAuthStartInputSchema,
  requireApproval: () => !isBypassEnabled(),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "feishu_auth_start" });
    try { return await getConnectorService().start("feishu", input) as FeishuStartResult; }
    finally { stop(); }
  },
});
