import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { startToolHeartbeat } from "../../toolHeartbeat.js";
import { githubClient, githubMaterialId } from "./githubShared.js";

const MAX_TEXT_BYTES = 1024 * 1024;

function decodeText(content: string): string {
  const buffer = Buffer.from(content.replace(/\s/g, ""), "base64");
  if (buffer.length > MAX_TEXT_BYTES) throw Object.assign(new Error("GitHub 文件超过 1MB 文本上限"), { code: "FILE_TOO_LARGE", status: 413 });
  if (buffer.includes(0)) throw Object.assign(new Error("拒绝读取二进制文件"), { code: "BINARY_FILE", status: 415 });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (!text.trim()) throw Object.assign(new Error("文件正文为空"), { code: "EMPTY_FILE", status: 422 });
  return text;
}

export const githubReadFileTool = createTool({
  id: "github_read_file",
  description: "通过 GitHub Contents API 读取不超过 1MB 的文本文件，拒绝二进制，返回可供 storeMaterial 使用的稳定素材字段。",
  inputSchema: z.object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), path: z.string().min(1).max(1024), ref: z.string().min(1).max(255).optional() }),
  execute: async (input, context) => {
    const stop = startToolHeartbeat(context, { tool: "github_read_file" });
    try {
      const { client } = await githubClient(true);
      const response = await client.contents(input.owner, input.repo, input.path, input.ref, context?.abortSignal);
      if (response.data.type !== "file" || response.data.encoding !== "base64" || typeof response.data.content !== "string") {
        throw Object.assign(new Error("GitHub Contents 响应不是可解码文本文件"), { code: "UNSUPPORTED_CONTENT", status: 415 });
      }
      if (typeof response.data.size === "number" && response.data.size > MAX_TEXT_BYTES) throw Object.assign(new Error("GitHub 文件超过 1MB 文本上限"), { code: "FILE_TOO_LARGE", status: 413 });
      const text = decodeText(response.data.content);
      const sourceUrl = String(response.data.html_url ?? `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/blob/${encodeURIComponent(input.ref ?? "HEAD")}/${input.path.split("/").map(encodeURIComponent).join("/")}`);
      return { materialId: githubMaterialId(input.owner, input.repo, input.path, input.ref), title: `${input.repo}/${input.path}`, text, sourceUrl, rateLimit: response.rateLimit };
    } finally { stop(); }
  },
});
