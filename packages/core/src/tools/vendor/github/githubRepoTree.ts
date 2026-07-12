import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { startToolHeartbeat } from "../../toolHeartbeat.js";
import { githubClient } from "./githubShared.js";

const MAX_ENTRIES = 5_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 20;

export const githubRepoTreeTool = createTool({
  id: "github_repo_tree",
  description: "读取 GitHub 仓库文件树（只读，产品限制 5000 项、2MB、20 层），并透出 GitHub/产品截断状态。",
  inputSchema: z.object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), ref: z.string().min(1).max(255).default("HEAD") }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_repo_tree" });
    try {
      const { client } = await githubClient(true);
      const response = await client.tree(input.owner, input.repo, input.ref, context?.abortSignal);
      let bytes = 0;
      const entries: Array<{ path: string; type: string; size: number | null; sha: string }> = [];
      let productTruncated = false;
      for (const raw of response.data.tree) {
        const path = String(raw.path ?? "");
        if (path.split("/").length > MAX_DEPTH) { productTruncated = true; continue; }
        const entry = { path, type: String(raw.type ?? ""), size: typeof raw.size === "number" ? raw.size : null, sha: String(raw.sha ?? "") };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length >= MAX_ENTRIES || bytes + size > MAX_BYTES) { productTruncated = true; break; }
        entries.push(entry); bytes += size;
      }
      return { entries, count: entries.length, truncated: Boolean(response.data.truncated) || productTruncated, providerTruncated: Boolean(response.data.truncated), rateLimit: response.rateLimit };
    } finally { stop(); }
  },
});
