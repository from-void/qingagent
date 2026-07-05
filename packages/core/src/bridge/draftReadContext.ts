import type {
  ChatChip,
  LegacySection,
} from "@qingagent/contract-ts";
import {
  pmToPlainText,
  type PmBlockNode,
  type PmDoc,
  type PmNode,
} from "@qingagent/pm-schema";
import type { SessionState } from "./sessionState.js";
import {
  currentPmDoc,
  getSectionText,
} from "./draftScratch.js";

const PM_TEXT_BLOCK_BOUNDARY_SIZE = 2;

export function estimatedPmTextBlockSize(text: string): number {
  return text.length + PM_TEXT_BLOCK_BOUNDARY_SIZE;
}

export function buildSectionToLineMap(sections: LegacySection[]): Map<number, number> {
  const sectionToLine = new Map<number, number>();
  let lineNum = 1;

  for (let si = 0; si < sections.length; si++) {
    if (si > 0) {
      lineNum++;
    }
    sectionToLine.set(si, lineNum);
    lineNum++;
  }

  return sectionToLine;
}

export type ReadableDraftNode = PmBlockNode | Extract<PmNode, { type: "listItem" | "taskItem" }>;

export interface ReadableDraftRefEntry {
  ref: string;
  node: ReadableDraftNode;
  path: number[];
  topIndex: number;
  topBlock: PmBlockNode;
  parentListRef?: string;
}

export function nodeBlockId(node: PmNode | PmBlockNode): string | undefined {
  if (!("attrs" in node)) return undefined;
  const blockId = (node.attrs as Record<string, unknown> | undefined)?.blockId;
  return typeof blockId === "string" && blockId ? blockId : undefined;
}

export function isListItemRefNode(node: PmNode | PmBlockNode): node is Extract<PmNode, { type: "listItem" | "taskItem" }> {
  return node.type === "listItem" || node.type === "taskItem";
}

export function isPmBlockNode(node: PmNode | PmBlockNode): node is PmBlockNode {
  return !isListItemRefNode(node) && node.type !== "text" && node.type !== "hardBreak" && node.type !== "inlineMath" &&
    node.type !== "column" && node.type !== "tableRow" && node.type !== "tableCell" && node.type !== "tableHeader";
}

export function isListBlockNode(node: PmNode | PmBlockNode): boolean {
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

export function collectReadableDraftRefs(doc: PmDoc): ReadableDraftRefEntry[] {
  const out: ReadableDraftRefEntry[] = [];

  function visit(
    node: PmNode,
    path: number[],
    topIndex: number,
    topBlock: PmBlockNode,
    parentListRef?: string,
  ): void {
    const ref = nodeBlockId(node);
    if (ref && (path.length === 1 || isListItemRefNode(node))) {
      out.push({
        ref,
        node: node as ReadableDraftNode,
        path,
        topIndex,
        topBlock,
        ...(parentListRef ? { parentListRef } : {}),
      });
    }
    if (!("content" in node) || !Array.isArray(node.content)) return;
    const nextParentListRef = ref && isListBlockNode(node) ? ref : parentListRef;
    node.content.forEach((child, index) => {
      if (typeof child !== "object" || child === null) return;
      visit(child as PmNode, [...path, index], topIndex, topBlock, nextParentListRef);
    });
  }

  doc.content.forEach((block, index) => {
    visit(block, [index], index, block);
  });
  return out;
}

export function summarizeReadableDraftNode(doc: PmDoc, node: ReadableDraftNode): string {
  if (isListItemRefNode(node)) {
    return pmToPlainText({ type: "doc", attrs: doc.attrs, content: node.content });
  }
  return summarizeSelectedBlock(doc, node);
}

export function summarizeReadDraftOutputText(doc: PmDoc, node: ReadableDraftNode): string {
  if (isListItemRefNode(node)) {
    return pmToPlainText({ type: "doc", attrs: doc.attrs, content: node.content });
  }
  return pmToPlainText({ type: "doc", attrs: doc.attrs, content: [node] });
}

/**
 * 给"用户选中的块"生成一段人读摘要,供 agent 知道引用的到底是什么。
 * 原子块(图表/图片/公式/分隔线/附件)没有内联文字,必须按类型取它的关键内容,
 * 否则只剩空串 / 块类型名,会让 agent 失去定位依据。文本块走 pmToPlainText。
 */
export function summarizeSelectedBlock(doc: PmDoc, block: PmDoc["content"][number]): string {
  const attrs = (block.attrs ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (block.type) {
    case "diagram":
      return `[图表 ${str(attrs.lang) || "mermaid"}]\n${str(attrs.source)}`.trim();
    case "image":
      return `[图片] ${str(attrs.caption) || str(attrs.alt) || str(attrs.src)}`.trim();
    case "blockMath":
      return `[公式] ${str(attrs.latex)}`.trim();
    case "horizontalRule":
      return "[分隔线]";
    case "fileAttachment":
      return `[附件] ${str(attrs.name) || str(attrs.fileName) || str(attrs.src)}`.trim();
    default:
      return pmToPlainText({ type: "doc", attrs: doc.attrs, content: [block] });
  }
}

/**
 * 按稳定 blockId 精确解析选区 chip 引用的块。chip.resourceRef.id 承载前端选中块的 blockId
 * (见 WorkspacePage.toContractChip),这里在候选草稿文档里按 id 命中——对图表/图片等原子块
 * 也能找回,且不受 PM 位置估算漂移影响。命中失败(老链路/占位 id)返回 null,调用方降级。
 */
export function resolveSelectionChipBlocks(
  state: SessionState,
  chip: ChatChip,
): Array<{ ref: string; type: string; summary: string; parentListRef?: string }> {
  const refs = chip.selectionRefs && chip.selectionRefs.length > 0
    ? chip.selectionRefs
    : chip.resourceRef?.id
      ? [chip.resourceRef.id]
      : [];
  if (refs.length === 0) return [];
  const doc = state.docDraftCandidateDoc ?? currentPmDoc(state);
  const byRef = new Map(collectReadableDraftRefs(doc).map((entry) => [entry.ref, entry]));
  const out: Array<{ ref: string; type: string; summary: string; parentListRef?: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const entry = byRef.get(ref);
    if (!entry) continue;
    out.push({
      ref,
      type: entry.node.type,
      summary: summarizeReadableDraftNode(doc, entry.node),
      ...(entry.parentListRef ? { parentListRef: entry.parentListRef } : {}),
    });
  }
  return out;
}

export function getTextBetweenPositions(
  sections: LegacySection[],
  from: number,
  to: number,
): string | null {
  let offset = 1;
  const parts: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const text = getSectionText(section) ?? "";
    const sectionStart = offset + 1; // after open tag
    const sectionEnd = sectionStart + text.length;
    if (sectionEnd > from && sectionStart < to) {
      const sliceStart = Math.max(0, from - sectionStart);
      const sliceEnd = Math.min(text.length, to - sectionStart);
      parts.push(text.slice(sliceStart, sliceEnd));
    }
    offset += estimatedPmTextBlockSize(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
