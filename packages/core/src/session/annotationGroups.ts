import {
  maskSensitiveAnnotationGroup,
  normalizeAnnotationSuggestion,
  type AnnotationGroup,
  type BridgeFrame,
  type ReviewContext,
} from "@qingagent/contract-ts";
import {
  insertAnnotationGroups,
  replaceAnnotationGroupsByOrigin,
} from "@qingagent/db";
import crypto from "node:crypto";
import {
  containsLiteralMatch,
  findAnnotationQuoteMatches,
} from "../utils/annotationQuoteMatches.js";
import { collectTopLevelTextBlocks } from "../utils/pmTextBlocks.js";
import {
  reviewOrigin,
  truncateAnnotationSummary,
  type AnnotationGroupInput,
} from "../tools/annotationGroups.js";
import type { SessionState } from "./sessionState.js";

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
