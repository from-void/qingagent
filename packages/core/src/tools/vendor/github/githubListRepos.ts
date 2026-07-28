import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { startToolHeartbeat } from "../../toolHeartbeat.js";
import { githubClient } from "./githubShared.js";

export const githubListReposTool = createTool({
  id: "github_list_repos",
  description: "分页列出 GitHub 仓库（每页最多 100 条）。已连接时 owner 可省略并列出当前用户可见仓；匿名模式必须提供 owner，只列公开仓；truncated 为 true 时用 nextPage 继续。",
  inputSchema: z.object({
    owner: z.string().min(1).max(100).optional(),
    page: z.number().int().min(1).default(1),
  }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_list_repos" });
    try {
      const { client, connected } = await githubClient(true);
      if (!connected && !input.owner) throw Object.assign(new Error("匿名模式必须提供 owner"), { code: "OWNER_REQUIRED", status: 400 });
      const page = input.page ?? 1;
      const response = await client.listRepos(input.owner, page, context?.abortSignal);
      const repos = response.data.slice(0, 100).map((repo) => ({
        owner: String((repo.owner as Record<string, unknown> | undefined)?.login ?? input.owner ?? ""),
        name: String(repo.name ?? ""), fullName: String(repo.full_name ?? ""), private: Boolean(repo.private),
        defaultBranch: String(repo.default_branch ?? "main"), url: String(repo.html_url ?? ""),
      }));
      return {
        repos,
        count: repos.length,
        page,
        nextPage: response.nextPage,
        truncated: response.nextPage !== null || response.data.length > repos.length,
        anonymous: !connected,
        rateLimit: response.rateLimit,
      };
    } finally { stop(); }
  },
});
