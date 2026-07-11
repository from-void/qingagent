import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

const DEDUPE_META = "qingagentDedupeBlockIds";

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
    return [
      new Plugin({
        key: dedupeBlockIdsPluginKey,
        appendTransaction(transactions, oldState, newState) {
          const docChanged = transactions.some((tr) => tr.docChanged);
          if (!docChanged) return null;
          if (transactions.some((tr) => tr.getMeta(DEDUPE_META))) return null;
          if (transactions.some((tr) => shouldSkipDedupeTransaction(tr, oldState.doc.content.size))) {
            return null;
          }

          const occurrences = collectBlockIdOccurrences(newState.doc);
          const pasteRanges = collectPasteInsertedRanges(transactions);
          const missing = pasteRanges.length > 0 ? collectMissingBlockIds(newState.doc, pasteRanges) : [];
          const duplicates = findDuplicateBlockIds(occurrences);
          if (duplicates.length === 0 && missing.length === 0) return null;

          const reserved = new Set(occurrences.map((occurrence) => occurrence.blockId));
          const tr = newState.tr;
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
        },
      }),
    ];
  },
});

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

function shouldSkipDedupeTransaction(tr: Transaction, oldDocContentSize: number): boolean {
  if (!tr.docChanged) return false;
  if (tr.getMeta("isApplyingRemote") || tr.getMeta("qingagentApplyingRemote")) return true;
  return transactionReplacesWholeDoc(tr, oldDocContentSize);
}

function transactionReplacesWholeDoc(tr: Transaction, oldDocContentSize: number): boolean {
  return tr.steps.some((step) => {
    let replacesWholeDoc = false;
    step.getMap().forEach((oldStart, oldEnd, newStart) => {
      if (oldStart === 0 && oldEnd === oldDocContentSize && newStart === 0) {
        replacesWholeDoc = true;
      }
    });
    return replacesWholeDoc;
  });
}
