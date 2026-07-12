import { createHash } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { githubClient } from "./githubShared.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

const repoPart = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "GitHub owner/repo 含非法字符");
const queryPart = z.string().trim().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value) && !/(^|\s)repo\s*:/i.test(value), "查询不得包含控制字符或额外 repo: 限定");

export function buildGithubCodeSearchQuery(owner: string, repo: string, query: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || /[\0\r\n]/.test(query) || /(^|\s)repo\s*:/i.test(query)) {
    throw Object.assign(new Error("GitHub 搜索参数非法"), { code: "INVALID_ARGUMENT", status: 400 });
  }
  return `${query.trim()} repo:${owner}/${repo}`;
}

type SearchItem = Record<string, unknown>;
type Fragment = { fragmentId: string; path: string; fragment: string; score: number | null; sourceUrl: string; title: string };

function fragments(owner: string, repo: string, items: SearchItem[]): Fragment[] {
  const output: Fragment[] = [];
  for (const item of items) {
    const path = typeof item.path === "string" ? item.path : "";
    const sourceUrl = typeof item.html_url === "string" ? item.html_url : "";
    const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null;
    if (!path || !sourceUrl) continue;
    const matches = Array.isArray(item.text_matches) ? item.text_matches : [];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index] as Record<string, unknown>;
      const fragment = typeof match.fragment === "string" ? match.fragment : "";
      const line = typeof match.line_number === "number" ? `L${match.line_number}` : `片段${index + 1}`;
      const fragmentId = `ghfrag-${createHash("sha256").update(`${owner}\0${repo}\0${path}\0${index}\0${fragment}`).digest("hex").slice(0, 24)}`;
      output.push({ fragmentId, path, fragment, score, sourceUrl, title: `${repo}/${path}#${line}` });
    }
  }
  return output;
}

export const githubSearchCodeTool = createTool({
  id: "github_search_code",
  description: "在指定 GitHub 仓库的默认分支搜索代码。先 search 展示命中并征得用户确认；只有用户明确选中后才用 select_fragment 让该片段进入素材缓存。GitHub 搜索仅索引小于 384KB 的文件。",
  inputSchema: z.object({
    action: z.enum(["search", "select_fragment"]).default("search"),
    owner: repoPart,
    repo: repoPart,
    query: queryPart,
    fragmentId: z.string().regex(/^ghfrag-[a-f0-9]{24}$/).optional(),
  }).superRefine((value, context) => {
    if (value.action === "select_fragment" && !value.fragmentId) context.addIssue({ code: "custom", path: ["fragmentId"], message: "选择片段时必须提供 fragmentId" });
  }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_search_code" });
    try {
      let connectedClient;
      try {
        connectedClient = await githubClient(false);
      } catch (error) {
        if ((error as { code?: string }).code === "GITHUB_NOT_CONNECTED") {
          return { ok: false, reasonCode: "GITHUB_NOT_CONNECTED", message: "请先连接 GitHub 后再搜索代码", hits: [], count: 0 };
        }
        throw error;
      }
      const scopedQuery = buildGithubCodeSearchQuery(input.owner, input.repo, input.query);
      const response = await connectedClient.client.searchCode(scopedQuery, context?.abortSignal);
      const hits = fragments(input.owner, input.repo, Array.isArray(response.data.items) ? response.data.items : []);
      if (input.action === "search") {
        return { ok: true, query: input.query, hits, count: hits.length, totalCount: typeof response.data.total_count === "number" ? response.data.total_count : hits.length, incomplete: response.data.incomplete_results === true, rateLimit: response.rateLimit };
      }
      const selected = hits.find((hit) => hit.fragmentId === input.fragmentId);
      if (!selected) throw Object.assign(new Error("所选 GitHub 搜索片段已失效，请重新搜索"), { code: "FRAGMENT_NOT_FOUND", status: 404 });
      if (!selected.fragment.trim()) throw Object.assign(new Error("所选 GitHub 搜索片段为空，不能存为素材"), { code: "EMPTY_FRAGMENT", status: 422 });
      return { ok: true, selected: true, materialId: selected.fragmentId, title: selected.title, text: selected.fragment, sourceUrl: selected.sourceUrl, rateLimit: response.rateLimit };
    } finally { stop(); }
  },
});
