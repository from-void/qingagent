import { getDeterministicId, getPmContentHash } from "../hash";
import { PM_SCHEMA_VERSION } from "../schemaVersion";
import type { PmBlockNode, PmDoc, PmNode } from "../types";
import { normalizePmDoc, safeParsePmDoc } from "../validators";

export function isGeneratedAiBlockId(blockId: unknown): blockId is string {
  return typeof blockId === "string" && blockId.startsWith("ai-block-");
}

export function allocateMaterializedBlockIds(
  nodes: readonly PmBlockNode[],
  opts: { namespace?: string; existingIds?: ReadonlySet<string>; occurrence?: number },
): { nodes: PmBlockNode[]; ids: string[]; nextOccurrence: number } {
  const used = new Set(opts.existingIds ?? []);
  let occurrence = opts.occurrence ?? 0;
  const ids: string[] = [];

  const materialized = nodes.map((node) => {
    const sourceBlockId = node.attrs.blockId;
    if (!isGeneratedAiBlockId(sourceBlockId)) {
      used.add(sourceBlockId);
      ids.push(sourceBlockId);
      return node;
    }

    const baseId = getDeterministicId("block", {
      namespace: opts.namespace ?? "draft.materialize",
      sourceBlockId,
      type: node.type,
      contentHash: getPmContentHash(contentFingerprint(node)),
    });
    let blockId = baseId;
    while (used.has(blockId)) {
      blockId = `${baseId}~${occurrence}`;
      occurrence += 1;
    }
    used.add(blockId);
    ids.push(blockId);
    return rewriteBlockIdPrefix(node, sourceBlockId, blockId);
  });

  return { nodes: materialized, ids, nextOccurrence: occurrence };
}

export function materializeDraftBlockNodes(
  nodes: readonly PmBlockNode[],
  opts?: { namespace?: string; existingIds?: ReadonlySet<string> },
): PmBlockNode[] {
  const existingIds = new Set(opts?.existingIds ?? []);
  let occurrence = 0;
  const out: PmBlockNode[] = [];

  for (const node of nodes) {
    const result = allocateMaterializedBlockIds([node], {
      namespace: opts?.namespace,
      existingIds,
      occurrence,
    });
    occurrence = result.nextOccurrence;
    for (const id of result.ids) existingIds.add(id);
    out.push(...result.nodes);
  }

  return out;
}

export function materializeDraftBlockIds(doc: PmDoc, opts?: { namespace?: string }): PmDoc {
  const realTopLevelIds = new Set<string>();
  for (const node of doc.content) {
    if (!isGeneratedAiBlockId(node.attrs.blockId)) realTopLevelIds.add(node.attrs.blockId);
  }

  const content = materializeDraftBlockNodes(doc.content, {
    namespace: opts?.namespace,
    existingIds: realTopLevelIds,
  });
  const normalized = normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: doc.attrs.schemaVersion ?? PM_SCHEMA_VERSION },
    content,
  });
  const parsed = safeParsePmDoc(normalized);
  if (!parsed.success) {
    throw new Error(`materialized draft doc 未过 pmDocSchema: ${parsed.error.message}`);
  }
  assertUniqueBlockIds(parsed.data as PmDoc);
  return parsed.data as PmDoc;
}

function contentFingerprint(node: PmBlockNode): unknown {
  return stripBlockIds(node);
}

function stripBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlockIds);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "blockId") continue;
    out[key] = stripBlockIds(child);
  }
  return out;
}

function rewriteBlockIdPrefix<T extends PmNode>(node: T, oldPrefix: string, newPrefix: string): T {
  const record = node as unknown as Record<string, unknown>;
  const attrs = record.attrs && typeof record.attrs === "object"
    ? rewriteAttrs(record.attrs as Record<string, unknown>, oldPrefix, newPrefix)
    : record.attrs;
  const content = Array.isArray(record.content)
    ? record.content.map((child) => {
        if (child && typeof child === "object") {
          return rewriteBlockIdPrefix(child as PmNode, oldPrefix, newPrefix);
        }
        return child;
      })
    : record.content;
  return { ...record, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) } as unknown as T;
}

function rewriteAttrs(attrs: Record<string, unknown>, oldPrefix: string, newPrefix: string): Record<string, unknown> {
  const blockId = attrs.blockId;
  if (typeof blockId !== "string" || !blockId.startsWith(oldPrefix)) return attrs;
  return { ...attrs, blockId: `${newPrefix}${blockId.slice(oldPrefix.length)}` };
}

function assertUniqueBlockIds(doc: PmDoc): void {
  const seen = new Set<string>();
  for (const blockId of collectBlockIds(doc)) {
    if (seen.has(blockId)) throw new Error(`materialized draft doc 出现重复 blockId: ${blockId}`);
    seen.add(blockId);
  }
}

function collectBlockIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectBlockIds);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const attrs = record.attrs && typeof record.attrs === "object" ? record.attrs as Record<string, unknown> : null;
  const own = typeof attrs?.blockId === "string" ? [attrs.blockId] : [];
  return [...own, ...collectBlockIds(record.content)];
}
