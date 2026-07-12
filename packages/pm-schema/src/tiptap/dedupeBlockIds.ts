import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

const DEDUPE_META = "qingagentDedupeBlockIds";
export const APPLYING_REMOTE_META = "qingagentApplyingRemote";

interface BlockIdOccurrence {
  pos: number;
  node: PmNode;
  blockId: string;
}

interface MissingBlockId {
  pos: number;
  node: PmNode;
}

export const dedupeBlockIdsPluginKey = new PluginKey("qingagentDedupeBlockIds");

export const DedupeBlockIds = Extension.create({
  name: "qingagentDedupeBlockIds",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: dedupeBlockIdsPluginKey,
        appendTransaction(transactions, _oldState, newState) {
          // 审阅/揭示等只读态的 PM position 与 blockId 都是锚点；只读初始化事务不改正文，
          // 回到可编辑态后由前端先做一次存量自愈，此插件继续承接后续本地事务。
          if (!editor.isEditable) return null;
          // appendTransaction 一轮可能同时收到 remote/自身追加事务与其后插件产生的本地事务。
          // 不能用“任一需跳过”否决整批；只要批次中存在尚未归一的本地 doc change 就必须扫描。
          const hasLocalDocChange = transactions.some((tr) =>
            tr.docChanged &&
            !tr.getMeta(DEDUPE_META) &&
            !shouldSkipDedupeTransaction(tr));
          if (!hasLocalDocChange) return null;

          const pasteRanges = collectPasteInsertedRanges(transactions);
          const missing = pasteRanges.length > 0 ? collectMissingBlockIds(newState.doc, pasteRanges) : [];
          return buildDedupeBlockIdsTransaction(newState, missing);
        },
      }),
    ];
  },
});

/**
 * 对已落入编辑器的存量文档执行同一套确定性 blockId 修复。
 * 文档序首个 id 保留，后续重复项按既有 `~N` 规则改写；调用方负责决定载入/审阅时机。
 */
export function createDedupeBlockIdsTransaction(state: EditorState): Transaction | null {
  return buildDedupeBlockIdsTransaction(state, []);
}

function buildDedupeBlockIdsTransaction(
  state: EditorState,
  missing: readonly MissingBlockId[],
): Transaction | null {
  const occurrences = collectBlockIdOccurrences(state.doc);
  const duplicates = findDuplicateBlockIds(occurrences);
  if (duplicates.length === 0 && missing.length === 0) return null;

  const reserved = new Set(occurrences.map((occurrence) => occurrence.blockId));
  const tr = state.tr;
  for (const item of missing) {
    const nextBlockId = allocateUniqueBlockId("block-pasted", reserved);
    reserved.add(nextBlockId);
    tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, blockId: nextBlockId }, item.node.marks);
  }
  for (const duplicate of duplicates) {
    const nextBlockId = allocateUniqueBlockId(duplicate.blockId, reserved);
    reserved.add(nextBlockId);
    tr.setNodeMarkup(
      duplicate.pos,
      undefined,
      { ...duplicate.node.attrs, blockId: nextBlockId },
      duplicate.node.marks,
    );
  }

  if (!tr.docChanged) return null;
  tr.setMeta(DEDUPE_META, true);
  tr.setMeta("addToHistory", false);
  return tr;
}

function collectBlockIdOccurrences(doc: PmNode): BlockIdOccurrence[] {
  const occurrences: BlockIdOccurrence[] = [];
  doc.descendants((node, pos) => {
    const blockId = node.attrs.blockId;
    if (typeof blockId === "string" && blockId.length > 0) {
      occurrences.push({ pos, node, blockId });
    }
    return true;
  });
  return occurrences;
}

function collectMissingBlockIds(doc: PmNode, ranges: readonly { from: number; to: number }[]): MissingBlockId[] {
  const missing: MissingBlockId[] = [];
  doc.descendants((node, pos) => {
    if (ranges.some((range) => pos >= range.from && pos < range.to) &&
      Object.prototype.hasOwnProperty.call(node.attrs, "blockId") &&
      (typeof node.attrs.blockId !== "string" || node.attrs.blockId.length === 0)) {
      missing.push({ pos, node });
    }
    return true;
  });
  return missing;
}

function collectPasteInsertedRanges(transactions: readonly Transaction[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const tr of transactions) {
    if (tr.getMeta("uiEvent") !== "paste") continue;
    for (const step of tr.steps) {
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newEnd > newStart) ranges.push({ from: newStart, to: newEnd });
      });
    }
  }
  return ranges;
}

function findDuplicateBlockIds(occurrences: readonly BlockIdOccurrence[]): BlockIdOccurrence[] {
  const seen = new Set<string>();
  const duplicates: BlockIdOccurrence[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.blockId)) {
      duplicates.push(occurrence);
    } else {
      seen.add(occurrence.blockId);
    }
  }
  return duplicates;
}

function allocateUniqueBlockId(baseId: string, reserved: ReadonlySet<string>): string {
  let index = 1;
  let candidate = `${baseId}~${index}`;
  while (reserved.has(candidate)) {
    index += 1;
    candidate = `${baseId}~${index}`;
  }
  return candidate;
}

function shouldSkipDedupeTransaction(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  return Boolean(tr.getMeta("isApplyingRemote") || tr.getMeta(APPLYING_REMOTE_META));
}
