import {
  maskSensitiveAnnotationGroup,
  maskSensitiveValues,
  normalizeAnnotationSuggestion,
  type AnnotationGroup,
  type BridgeFrame,
  type ReviewContext,
  type ReviewType,
} from "@qingagent/contract-ts";
import {
  insertAnnotationGroups,
  replaceAnnotationGroupsByOrigin,
} from "@qingagent/db";
import crypto from "node:crypto";
import { z } from "zod";
import {
  collectTopLevelTextBlocks,
  containsLiteralMatch,
  findAnnotationQuoteMatches,
} from "../doc-engine/textEditOps.js";
import type { SessionState } from "../session/sessionState.js";

export const EXTERNAL_PLUGIN_REVIEW_ORIGIN = "external-plugin";

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
  const masked = maskSensitiveValues(summary.trim());
  return Array.from(masked).slice(0, ANNOTATION_SUMMARY_MAX_CHARS).join("");
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

export interface WriteAnnotationGroupsOptions {
  state: SessionState;
  groups: readonly AnnotationGroupInput[];
  reviewContext?: ReviewContext | null;
  forcedOrigin?: string | null;
  replacementMode?: "turn" | "replace";
  atomic?: boolean;
  assertWriteAllowed?: () => void;
  onOriginOverride?: (input: {
    reviewContext: ReviewContext | null | undefined;
    groupIndex: number;
    modelOrigin: string;
    forcedOrigin: string;
  }) => void;
}

export interface WriteAnnotationGroupsResult {
  ok: boolean;
  groupCount: number;
  anchorCount: number;
  errors: string[];
  groups: AnnotationGroup[];
  replacedOrigins: string[];
  frame: Extract<BridgeFrame, { kind: "annotationGroupsReady" }> | null;
}

const annotationGroupWriteQueues = new WeakMap<SessionState, Promise<void>>();

/**
 * 根据来源集合生成批注权威快照帧，确保 agent 主流与 external 数据面采用同一换代语义。
 */
export function createAnnotationGroupsReadyFrame(
  state: Pick<SessionState, "annotationGroups">,
  replacedOrigins: readonly string[],
): Extract<BridgeFrame, { kind: "annotationGroupsReady" }> {
  const replacedOriginSet = new Set(replacedOrigins);
  return {
    kind: "annotationGroupsReady",
    data: {
      groups: state.annotationGroups.filter((group) => replacedOriginSet.has(group.origin)),
      replacedOrigins: [...replacedOrigins],
    },
  };
}

/**
 * 批注写入的共享内核：逐字锚定、语义校验、建组、按来源换代并持久化。
 * Mastra 工具与 external 数据面共同调用；调用方负责把返回的权威 frame 接入各自流。
 */
export async function writeAnnotationGroups(
  options: WriteAnnotationGroupsOptions,
): Promise<WriteAnnotationGroupsResult> {
  const { state } = options;
  if (!state.doc) return emptyWriteResult(["当前没有可批注文档"]);

  const blocks = collectTopLevelTextBlocks(state.doc);
  const documentText = blocks.map((block) => block.text).join("\n");
  const materialTexts = [...state.materials.values()].map((material) => material.text);
  const errors: string[] = [];
  const forcedOrigin = options.forcedOrigin ?? reviewOrigin(options.reviewContext);
  let groups = options.groups.flatMap((modelSource, groupIndex) => {
    const normalizedModelSource = {
      ...modelSource,
      summary: truncateAnnotationSummary(modelSource.summary),
    };
    const source = forcedOrigin
      ? { ...normalizedModelSource, origin: forcedOrigin }
      : normalizedModelSource;
    if (forcedOrigin && modelSource.origin !== forcedOrigin) {
      options.onOriginOverride?.({
        reviewContext: options.reviewContext,
        groupIndex,
        modelOrigin: modelSource.origin,
        forcedOrigin,
      });
    }
    const semanticErrors = annotationGroupSemanticErrors(source, groupIndex);
    if (semanticErrors.length > 0) {
      errors.push(...semanticErrors);
      return [];
    }
    if (
      source.origin === "source-check"
      && source.judgment !== "无据"
      && !materialTexts.some((text) => containsLiteralMatch(text, source.materialQuote ?? ""))
    ) {
      errors.push(`第 ${groupIndex + 1} 组 materialQuote 字段无效：素材中未找到所引原句「${source.materialQuote ?? ""}」`);
      return [];
    }
    if (
      source.origin === "consistency"
      && !containsLiteralMatch(documentText, source.documentQuote ?? "")
    ) {
      errors.push(`第 ${groupIndex + 1} 组 documentQuote 字段无效：当前文档中未找到冲突对端原句「${source.documentQuote ?? ""}」`);
      return [];
    }
    const anchors = source.anchors.flatMap((spec, anchorIndex) => {
      const matches = findAnnotationQuoteMatches(blocks, spec.find, spec.all === true);
      if (matches.length === 0) {
        errors.push(`第 ${groupIndex + 1} 组 anchors.${anchorIndex}.find 字段无效：当前文档中未找到精确文本「${spec.find}」`);
      }
      return matches.map((match) => ({
        blockId: match.blockId,
        pmFrom: match.pmFrom,
        pmTo: match.pmTo,
        quote: match.matchText,
        textHash: crypto.createHash("sha256").update(match.matchText).digest("hex").slice(0, 24),
      }));
    });
    if (anchors.length === 0) return [];
    const evidence = source.origin === "source-check"
      ? source.judgment === "无据"
        ? `已核查范围：${source.checkedScope}`
        : `素材原句：${source.materialQuote}`
      : source.origin === "consistency"
        ? `文内冲突原句：${source.documentQuote}`
        : null;
    const suggestion = normalizeAnnotationSuggestion(source.note, source.suggestion);
    return [maskSensitiveAnnotationGroup({
      id: `annotation-${crypto.randomUUID()}`,
      summary: source.summary,
      note: evidence ? `${source.note}\n${evidence}` : source.note,
      origin: source.origin,
      ...(options.reviewContext?.templateId
        ? { reviewTemplateId: options.reviewContext.templateId }
        : {}),
      ...(suggestion ? { suggestion } : {}),
      severity: source.severity,
      status: "reviewing" as const,
      anchors,
    })];
  });

  if (options.atomic && errors.length > 0) groups = [];
  if (groups.length === 0) return emptyWriteResult(errors);

  const origins = new Set(groups.map((group) => group.origin));
  const previousWrite = annotationGroupWriteQueues.get(state) ?? Promise.resolve();
  const write = previousWrite.then(async () => {
    const turnOrigins = state._annotationOriginsReplacedThisTurn ?? new Set<string>();
    const originsToReplace = options.replacementMode === "replace"
      ? new Set(origins)
      : new Set([...origins].filter((origin) => !turnOrigins.has(origin)));
    const replacing = groups.filter((group) => originsToReplace.has(group.origin));
    const appending = groups.filter((group) => !originsToReplace.has(group.origin));
    options.assertWriteAllowed?.();
    if (replacing.length > 0) {
      await replaceAnnotationGroupsByOrigin(state.docId, state.docVersion, replacing);
    }
    options.assertWriteAllowed?.();
    if (appending.length > 0) {
      await insertAnnotationGroups(state.docId, state.docVersion, appending);
    }
    options.assertWriteAllowed?.();
    state.annotationGroups = [
      ...state.annotationGroups.filter((group) => !originsToReplace.has(group.origin)),
      ...replacing,
      ...appending,
    ];
    if (options.replacementMode !== "replace") {
      origins.forEach((origin) => turnOrigins.add(origin));
      state._annotationOriginsReplacedThisTurn = turnOrigins;
    }
  });
  annotationGroupWriteQueues.set(state, write.catch(() => undefined));
  await write;

  const replacedOrigins = [...origins];
  return {
    ok: true,
    groupCount: groups.length,
    anchorCount: groups.reduce((count, group) => count + group.anchors.length, 0),
    errors,
    groups,
    replacedOrigins,
    frame: createAnnotationGroupsReadyFrame(state, replacedOrigins),
  };
}

function emptyWriteResult(errors: string[]): WriteAnnotationGroupsResult {
  return {
    ok: false,
    groupCount: 0,
    anchorCount: 0,
    errors,
    groups: [],
    replacedOrigins: [],
    frame: null,
  };
}

function annotationGroupSemanticErrors(
  source: AnnotationGroupInput,
  groupIndex: number,
): string[] {
  const prefix = `第 ${groupIndex + 1} 组`;
  const errors: string[] = [];
  if (source.origin === "source-check") {
    if (!source.judgment || !["口径漂移", "数字失真", "无据", "素材遗漏"].includes(source.judgment)) {
      errors.push(`${prefix} judgment 字段必填，必须是“口径漂移”“数字失真”“无据”或“素材遗漏”`);
    } else if (source.judgment !== "无据" && !source.materialQuote?.trim()) {
      errors.push(`${prefix} materialQuote 字段必填：${source.judgment}必须逐字引用素材全文`);
    } else if (source.judgment === "无据" && !source.checkedScope?.trim()) {
      errors.push(`${prefix} checkedScope 字段必填：无据必须说明已核查的素材范围`);
    }
  }
  if (source.origin === "consistency") {
    if (!source.judgment || !["时间线", "数字", "称谓与术语", "论断"].includes(source.judgment)) {
      errors.push(`${prefix} judgment 字段必填，必须是“时间线”“数字”“称谓与术语”或“论断”`);
    }
    if (!source.documentQuote?.trim()) {
      errors.push(`${prefix} documentQuote 字段必填，且必须逐字来自当前文档全文`);
    }
  }
  return errors;
}

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
