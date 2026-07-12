import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getConnectorService } from "../../../connectors/connectorService.js";
import type { GithubStartResult } from "../../../connectors/githubConnector.js";
import { startToolHeartbeat } from "../../toolHeartbeat.js";

/** 模型只选择最小固定 scope；device_code/token 始终封装在 connector service 内。 */
export const githubAuthStartTool = createTool({
  id: "github_auth_start",
  description: "在用户需要连接 GitHub 时发起可信 device flow 授权卡。默认 repo(含私有仓);仅当用户明确只要公开仓时才传 public_repo。",
  inputSchema: z.object({ scope: z.enum(["public_repo", "repo"]).default("repo") }).strict(),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_auth_start" });
    try { return await getConnectorService().start("github", input) as GithubStartResult; }
    finally { stop(); }
  },
});
