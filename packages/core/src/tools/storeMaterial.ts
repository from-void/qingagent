import { createTool } from "@mastra/core/tools";
import { createHash } from "crypto";
import { z } from "zod";

/**
 * storeMaterial tool — returns a material ID and echoes the input data.
 *
 * The execute function is pure: it generates an ID and returns the data
 * unchanged. The bridge layer (processAgentStream) picks up the tool-result
 * event and writes the material into `state.materials` — no shared mutable
 * state or AsyncLocalStorage needed.
 */
export const storeMaterialTool = createTool({
  id: "storeMaterial",
  description:
    "将已解析/抓取的素材存入当前会话素材库。" +
    "⚠️ 正文全文由系统自动引用本地已提取的内容(parseFile 解析的、fetchArticle/scrapeWithBrowser 抓取的)," +
    "你无需、也绝对不要传入正文——只需提供 filename(用于关联本地正文)、标题、可选的简短摘要。" +
    "返回素材 ID，后续可通过 readMaterial 读取。",
  inputSchema: z.object({
    filename: z
      .string()
      .describe("原始文件名(用于关联本地已提取的正文,务必与 parseFile/抓取时一致)"),
    mimeType: z.string().describe("MIME 类型"),
    pages: z.number().nullable().optional().describe("页数（PDF 专属；网页/无页数可不填）"),
    title: z.string().nullable().optional().describe("文档标题（如有；没有可不填）"),
    summary: z
      .string()
      .optional()
      .describe("素材摘要(可选,简短一句话)。可以写摘要,但绝对不要在这里写正文/全文内容。"),
  }),
  outputSchema: z.object({
    materialId: z.string().describe("存储后的素材 ID"),
    stored: z.boolean().describe("是否存储成功"),
  }),
  execute: async (input) => {
    // Pure computation — no session state dependency.
    // Bridge layer handles the actual persistence into state.materials.
    const materialId = "mat-" + createHash("sha256").update(input.filename).digest("hex").slice(0, 12);
    return { materialId, stored: true };
  },
});
