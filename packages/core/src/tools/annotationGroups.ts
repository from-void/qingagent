import type { ReviewContext, ReviewType } from "@qingagent/contract-ts";
import { z } from "zod";

export const REVIEW_ORIGIN_MATRIX: Record<Exclude<ReviewType, "custom">, string> = {
  sensitive: "sensitive",
  deai: "deai",
  source: "source-check",
  consistency: "consistency",
  privacy: "privacy",
  format: "format",
  role: "角色审查",
};

export function reviewOrigin(context: ReviewContext | null | undefined): string | null {
  if (!context) return null;
  if (context.type === "custom") return `自定义审查:${context.templateName.trim()}`;
  if (context.type === "role") return `${REVIEW_ORIGIN_MATRIX.role}:${context.templateName.trim()}`;
  return REVIEW_ORIGIN_MATRIX[context.type];
}

export const ANNOTATION_SUMMARY_MAX_CHARS = 15;

export function truncateAnnotationSummary(summary: string): string {
  return Array.from(summary.trim()).slice(0, ANNOTATION_SUMMARY_MAX_CHARS).join("");
}

export const annotationGroupInputSchema = z.object({
  summary: z.string().min(1).describe("变更类型短标题，建议≤15字，如『履历时间与素材不符』『金额口径漂移』；超出时服务端截断，细节解释一律写进 note"),
  note: z.string().min(1),
  origin: z.string().min(1).describe("模型侧审查来源；菜单审查会由工具依据本轮 reviewContext 强制覆写"),
  suggestion: z.string().optional().describe("仅填写可直接执行的改写文本；只标注不改写时必须省略，不得复制 note 或原因说明"),
  severity: z.enum(["error", "warn", "info"]).optional()
    .describe("模板要求分级时填写；error=必须处理，warn=建议处理，info=仅提示。模板未要求时省略"),
  judgment: z.enum([
    "口径漂移", "数字失真", "无据", "素材遗漏",
    "时间线", "数字", "称谓与术语", "论断",
  ]).optional(),
  materialQuote: z.string().optional().describe("口径漂移/数字失真/素材遗漏时必填，且必须逐字来自素材全文"),
  checkedScope: z.string().optional().describe("无据时必填，说明已核查的素材范围"),
  documentQuote: z.string().optional().describe("一致性审查必填：与当前锚点冲突的另一处文内原句，必须逐字来自当前文档全文"),
  anchors: z.array(z.object({ find: z.string().min(1), all: z.boolean().optional() })).min(1),
});

const annotationParseFailureSchema = z.object({
  groupIndex: z.number().int().positive().nullable(),
  field: z.string().min(1),
  message: z.string().min(1),
}).describe("系统在模型参数 JSON 无法安全修复时注入的诊断；模型不得主动填写");

export const createAnnotationGroupsInputSchema = z.object({
  groups: z.array(annotationGroupInputSchema).min(1),
  _parseFailure: annotationParseFailureSchema.optional(),
});

export type AnnotationGroupInput = z.infer<typeof annotationGroupInputSchema>;
export type CreateAnnotationGroupsInput = z.infer<typeof createAnnotationGroupsInputSchema>;

const DIAGNOSTIC_DUMMY_GROUP: AnnotationGroupInput = {
  summary: "参数解析失败",
  note: "系统未执行任何批注写入。",
  origin: "system-parse-error",
  anchors: [{ find: "__annotation_json_parse_failure__" }],
};

const FIELD_NAMES = [
  "summary", "note", "origin", "suggestion", "severity", "judgment",
  "materialQuote", "checkedScope", "documentQuote", "anchors", "find", "all",
] as const;

function jsonErrorPosition(error: unknown, input: string): number {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:position|column)\s+(\d+)/i);
  if (!match) return input.length;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), input.length) : input.length;
}

/**
 * JSON.parse 只会把合法前缀走到首个坏字符；用此前已出现的 summary/字段名给出近似而可行动的路径。
 * 这里只诊断，不尝试补字段、补括号或执行任何部分批注。
 */
export function diagnoseAnnotationGroupsJson(input: string, error: unknown): {
  groupIndex: number | null;
  field: string;
  message: string;
} {
  const position = jsonErrorPosition(error, input);
  const prefix = input.slice(0, position);
  const groupsStart = prefix.search(/"groups"\s*:\s*\[/);
  const groupPrefix = groupsStart >= 0 ? prefix.slice(groupsStart) : prefix;
  const summaryCount = Array.from(groupPrefix.matchAll(/"summary"\s*:/g)).length;
  const groupIndex = groupsStart >= 0 ? Math.max(summaryCount, 1) : null;

  let field = "groups";
  let lastFieldPosition = -1;
  for (const candidate of FIELD_NAMES) {
    const pattern = new RegExp(`"${candidate}"\\s*:`, "g");
    for (const match of groupPrefix.matchAll(pattern)) {
      if ((match.index ?? -1) > lastFieldPosition) {
        lastFieldPosition = match.index ?? -1;
        field = candidate === "find" || candidate === "all" ? `anchors.${candidate}` : candidate;
      }
    }
  }

  const location = groupIndex === null
    ? `${field} 字段附近`
    : `第 ${groupIndex} 组的 ${field} 字段附近`;
  const reason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : String(error).slice(0, 160);
  return {
    groupIndex,
    field,
    message: `${location}不是合法 JSON（${reason}）。未写入任何批注；请只重发该组，或拆成每次≤3组后重试。`,
  };
}

export function annotationGroupsParseFailureInput(input: string, error: unknown): string {
  return JSON.stringify({
    groups: [DIAGNOSTIC_DUMMY_GROUP],
    _parseFailure: diagnoseAnnotationGroupsJson(input, error),
  } satisfies CreateAnnotationGroupsInput);
}
