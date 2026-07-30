import { createTool } from "@mastra/core/tools";
import { getConnectorService } from "../../../connectors/connectorService.js";
import type { GithubStartResult } from "../../../connectors/githubConnector.js";
import {
  GITHUB_AUTH_START_TOOL,
  githubAuthStartInputSchema,
} from "../../../confirm/connectAccountConfirmation.js";
import { isBypassEnabled } from "../../../security/bypassMode.js";
import { startToolHeartbeat } from "../../toolHeartbeat.js";

/** 模型只选择最小固定 scope；device_code/token 始终封装在 connector service 内。 */
export const githubAuthStartTool = createTool({
  id: GITHUB_AUTH_START_TOOL,
  description: "在用户需要连接 GitHub 时发起可信 device flow；流层会自动展示纯配对码授权卡（无二维码），不要再调用 show_qr 或复述配对码。默认 repo(含私有仓);仅当用户明确只要公开仓时才传 public_repo。",
  inputSchema: githubAuthStartInputSchema,
  requireApproval: () => !isBypassEnabled(),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_auth_start" });
    try { return await getConnectorService().start("github", input) as GithubStartResult; }
    finally { stop(); }
  },
});
