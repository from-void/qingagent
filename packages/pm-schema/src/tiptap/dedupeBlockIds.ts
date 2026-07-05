import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

const DEDUPE_META = "qingagentDedupeBlockIds";

interface BlockIdOccurrence {
  pos: number;
  node: PmNode;
  blockId: string;
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
          const duplicates = findDuplicateBlockIds(occurrences);
          if (duplicates.length === 0) return null;

          const reserved = new Set(occurrences.map((occurrence) => occurrence.blockId));
          const tr = newState.tr;
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
