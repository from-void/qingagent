import type {
  ChatChip,
  LegacySection,
} from "@qingagent/contract-ts";
import { tableSelectionTextSignature } from "@qingagent/contract-ts";
import {
  pmTableSelectionCellTexts,
  pmToPlainText,
  type PmBlockNode,
  type PmDoc,
  type PmNode,
} from "@qingagent/pm-schema";
import type { SessionState } from "../session/sessionState.js";
import {
  currentPmDoc,
} from "./draftScratch.js";

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

export type TableSelectionFreshnessResult =
  | { ok: true }
  | { ok: false; tableRef: string; reason: string };

/** tableSelection 的签名来自用户点击修改时看到的单元格；服务端 canonical 不一致时必须拒绝。 */
export function validateTableSelectionFreshness(
  state: SessionState,
  chips: readonly ChatChip[],
): TableSelectionFreshnessResult {
  const doc = currentPmDoc(state);
  for (const chip of chips) {
    const selection = chip.tableSelection;
    if (!selection) continue;
    const tableRef = chip.resourceRef?.id;
    if (!tableRef || !selection.signature) {
      return {
        ok: false,
        tableRef: tableRef ?? "unknown",
        reason: "表格选区缺少可校验的版本签名，请刷新文档并重新选择后再试。",
      };
    }
    const cellTexts = pmTableSelectionCellTexts(doc, tableRef, selection);
    if (!cellTexts || tableSelectionTextSignature(cellTexts) !== selection.signature) {
      return {
        ok: false,
        tableRef,
        reason: "文档正文与所选表格版本不一致，本次修改未开始；请确认编辑已保存，刷新后重新选择再试。",
      };
    }
  }
  return { ok: true };
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
  return !isListItemRefNode(node) && node.type !== "text" && node.type !== "hardBreak" &&
    node.type !== "inlineMath" && node.type !== "footnoteReference" &&
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
): Array<{ ref: string; type: string; summary: string; lang?: "mermaid" | "drawio"; parentListRef?: string }> {
  const refs = chip.selectionRefs && chip.selectionRefs.length > 0
    ? chip.selectionRefs
    : chip.resourceRef?.id
      ? [chip.resourceRef.id]
      : [];
  if (refs.length === 0) return [];
  const doc = state.docDraftCandidateDoc ?? currentPmDoc(state);
  const byRef = new Map(collectReadableDraftRefs(doc).map((entry) => [entry.ref, entry]));
  const out: Array<{
    ref: string;
    type: string;
    summary: string;
    lang?: "mermaid" | "drawio";
    parentListRef?: string;
  }> = [];
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
      ...(entry.node.type === "diagram" && entry.node.attrs.lang === "drawio"
        ? { lang: "drawio" as const }
        : entry.node.type === "diagram"
          ? { lang: "mermaid" as const }
          : {}),
      ...(entry.parentListRef ? { parentListRef: entry.parentListRef } : {}),
    });
  }
  return out;
}

export function buildTableSelectionContext(
  state: SessionState,
  chip: ChatChip,
): string | null {
  const selection = chip.tableSelection;
  if (!selection) return null;
  const tableRef = chip.resourceRef?.id;
  if (!tableRef) return null;

  const doc = state.docDraftCandidateDoc ?? currentPmDoc(state);
  const cellTexts = pmTableSelectionCellTexts(doc, tableRef, selection);
  const signatureMismatch = Boolean(
    selection.signature &&
    (!cellTexts || tableSelectionTextSignature(cellTexts) !== selection.signature),
  );
  const axisLabel = selection.axis === "row" ? "行" : "列";
  const physicalAxis = selection.axis === "row" ? "物理行" : "物理列";
  const range = selection.startIndex === selection.endIndex
    ? String(selection.startIndex)
    : `${selection.startIndex}..${selection.endIndex}`;
  const staleGuidance = signatureMismatch
    ? `\n- **选区可能已过期**：签名与当前表格不一致。当前只把 ref="${tableRef}" 当作整表引用；务必先 readDraft 核对，谨慎缩小操作范围，不能盲信旧索引。`
    : `\n- 仅对第 ${range} ${axisLabel}操作，不要改选区外的${axisLabel}或其它块。`;

  return (
    `> ${chip.label}${chip.suffix ? `（位置：${chip.suffix}）` : ""}` +
    `\n\n[表格选区定位提示]\n` +
    `- 用户选中该表第 ${range} ${axisLabel}（0-based ${physicalAxis}），表 ref="${tableRef}"。\n` +
    `- 行列没有稳定 id，索引以当前结构为准；先调用 readDraft(mode:"range", from:"${tableRef}", to:"${tableRef}") 确认当前表格结构，再调用 editDraft。` +
    staleGuidance +
    `\n- 工具失败时按 error 重新定位或询问用户，不能声称已生效。`
  );
}
