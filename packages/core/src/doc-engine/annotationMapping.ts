import type {
  AnnotationGroup,
  SuggestionAnchor,
} from "@qingagent/contract-ts";
import type { PmDoc, PmStep } from "@qingagent/pm-schema";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { normalizeAnnotationQuote } from "./textEditOps.js";

function nodeSize(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const value = node as { type?: unknown; text?: unknown; content?: unknown };
  if (value.type === "text") return typeof value.text === "string" ? value.text.length : 0;
  const content = Array.isArray(value.content) ? value.content : [];
  return 2 + content.reduce<number>((sum, child) => sum + nodeSize(child), 0);
}

export function pmDocContentSize(doc: PmDoc): number {
  return doc.content.reduce<number>((sum, child) => sum + nodeSize(child), 0);
}

function textBetweenPmDoc(doc: PmDoc, from: number, to: number): string {
  const chunks: string[] = [];
  const visit = (node: unknown, pos: number, isDoc = false): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: unknown; text?: unknown; content?: unknown };
    if (value.type === "text") {
      const text = typeof value.text === "string" ? value.text : "";
      const start = Math.max(0, from - pos);
      const end = Math.min(text.length, to - pos);
      if (start < end) chunks.push(text.slice(start, end));
      return;
    }
    const content = Array.isArray(value.content) ? value.content : [];
    let childPos = isDoc ? pos : pos + 1;
    for (const child of content) {
      const size = nodeSize(child);
      if (childPos < to && childPos + size > from) visit(child, childPos);
      childPos += size;
    }
  };
  visit(doc, 0, true);
  return chunks.join("");
}

function insertedSize(step: PmStep): number {
  const slice = step.slice as { content?: unknown; openStart?: number; openEnd?: number } | undefined;
  if (step.stepType !== "replace" || !Array.isArray(slice?.content)) return 0;
  return Math.max(0, slice.content.reduce<number>((sum, node) => sum + nodeSize(node), 0)
    - (slice.openStart ?? 0) - (slice.openEnd ?? 0));
}

export function mappingFromPmSteps(steps: readonly PmStep[]): Mapping {
  const mapping = new Mapping();
  for (const step of steps) {
    if (step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number") {
      mapping.appendMap(new StepMap([step.from, step.to - step.from, insertedSize(step)]));
    } else {
      mapping.appendMap(StepMap.empty);
    }
  }
  return mapping;
}

export type MappedAnnotationGroups = {
  groups: AnnotationGroup[];
  survivingAnchorIndexes: Map<string, number[]>;
  invalidatedAnchorIndexes: Map<string, number[]>;
  unlocatedGroupCount: number;
};

export function buildAnnotationMappingNotice(
  survivingGroupCount: number,
  unlocatedGroupCount: number,
): string {
  const located = `批注落地结果：${survivingGroupCount}处已定位`;
  return unlocatedGroupCount > 0
    ? `${located}；${unlocatedGroupCount}处因文档已改动未能定位。`
    : `${located}。`;
}

export function mapAnnotationGroupsThroughSteps(
  groups: readonly AnnotationGroup[],
  steps: readonly PmStep[],
  finalDoc?: PmDoc,
): MappedAnnotationGroups {
  const maps = steps.map((step) => step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number"
    ? new StepMap([step.from, step.to - step.from, insertedSize(step)])
    : StepMap.empty);
  const survivingAnchorIndexes = new Map<string, number[]>();
  const invalidatedAnchorIndexes = new Map<string, number[]>();
  let unlocatedGroupCount = 0;
  const mapped = groups.flatMap((group) => {
    const anchors: SuggestionAnchor[] = [];
    const indexes: number[] = [];
    const invalidIndexes: number[] = [];
    group.anchors.forEach((anchor, index) => {
      let from = anchor.pmFrom;
      let to = anchor.pmTo;
      let touched = false;
      let fallbackValidation = false;
      maps.forEach((map, stepIndex) => {
        const step = steps[stepIndex]!;
        if (step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number") {
          touched ||= step.from === step.to
            ? from < step.from && step.from < to
            : step.from < to && step.to > from;
        } else {
          // 未知/非 replace 步不猜坐标变化；最终仍用原句做一次兜底校验。
          fallbackValidation = true;
        }
        from = map.map(from, 1);
        to = map.map(to, -1);
      });
      const mappedQuote = finalDoc && (touched || fallbackValidation)
        ? textBetweenPmDoc(finalDoc, from, to)
        : anchor.quote;
      const textChanged = mappedQuote !== anchor.quote
        && normalizeAnnotationQuote(mappedQuote) !== normalizeAnnotationQuote(anchor.quote);
      if (from >= to || textChanged) {
        invalidIndexes.push(index);
        return;
      }
      anchors.push({ ...anchor, pmFrom: from, pmTo: to });
      indexes.push(index);
    });
    if (invalidIndexes.length > 0) invalidatedAnchorIndexes.set(group.id, invalidIndexes);
    // 同一问题的多个落点可以独立漂移：只忽略失效锚点，至少一个落点仍在就保留该组。
    if (anchors.length === 0) {
      unlocatedGroupCount += 1;
      return [];
    }
    survivingAnchorIndexes.set(group.id, indexes);
    return [{ ...group, anchors }];
  });
  return {
    groups: mapped,
    survivingAnchorIndexes,
    invalidatedAnchorIndexes,
    unlocatedGroupCount,
  };
}
