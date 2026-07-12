import { editDraftInputSchema } from "@qingagent/contract-ts/schemas";
import { z } from "zod";

/**
 * 草稿工具参数的共享运行期 schema。
 *
 * repairingModel 需要在 provider 返回后校验修复结果；schema 放在 llm 层，
 * 避免模型适配层反向依赖具体工具实现。
 */
export { editDraftInputSchema };

export const writeDraftInputSchema = z.object({
  title: z.string().describe("文档标题"),
  outline: z.string().describe("文档大纲或写作方向"),
  targetLength: z.number().optional().describe("(已废弃,等价于 lengthTarget+approx)目标字数"),
  lengthTarget: z.number().optional().describe("用户的字数数值锚点,如 1500"),
  lengthBound: z
    .enum(["approx", "max", "min", "exact"])
    .optional()
    .describe(
      "字数约束语义:approx='1500字左右/约1500字/裸数字';max='不超过/以内/最多';min='不少于/至少';exact='就要1500字/严格'",
    ),
  lengthTolerancePct: z
    .number()
    .optional()
    .describe("用户明说的波动幅度(0-0.5,如'上下一百字'对 1500 即 0.067);不说则用系统默认"),
  lengthMin: z
    .number()
    .optional()
    .describe(
      "用户给出明确字数区间时的下限(如'3000到3800字'填 3000)。与 lengthMax 成对使用,此时验收区间就是 [lengthMin,lengthMax] 本身,不要再用 lengthTarget 折中点(否则验收带会比用户区间窄)",
    ),
  lengthMax: z
    .number()
    .optional()
    .describe("用户给出明确字数区间时的上限(如'3000到3800字'填 3800)。与 lengthMin 成对使用"),
  lengthUnit: z
    .enum(["withPunct", "noPunct"])
    .optional()
    .describe("计数口径,仅用户明确说了才填:withPunct=含标点;noPunct=不含标点"),
  lengthRaw: z.string().optional().describe("用户表达字数要求的原话,审计用"),
  intent: z.enum(["express", "reason"]).default("express").describe(
    "写作意图。express=表达感染型(散文/小说/随笔/文案/演讲稿),追求流畅发散、快速;reason=论证分析型(报告/方案/评估/数据解读/技术说明),需要严谨推理。默认 express。",
  ),
  styleHint: z.string().optional().describe("风格提示"),
  basedOnMaterialIds: z.array(z.string()).optional().describe("限定使用的素材 ID"),
});
