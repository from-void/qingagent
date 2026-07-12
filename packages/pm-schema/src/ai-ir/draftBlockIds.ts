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
  for (const blockId of collectBlockIds(nodes)) {
    if (!isGeneratedAiBlockId(blockId)) used.add(blockId);
  }
  let occurrence = opts.occurrence ?? 0;
  const ids: string[] = [];
  const baseNamespace = opts.namespace ?? "draft.materialize";

  const allocatePrefix = <T extends PmNode>(node: T, sourceBlockId: string, namespace: string): T => {
    const baseId = getDeterministicId("block", {
      namespace,
      sourceBlockId,
      type: node.type,
      contentHash: getPmContentHash(stripBlockIds(node)),
    });
    const sourceIds = collectBlockIds(node).filter((id) => id.startsWith(sourceBlockId));
    let blockId = baseId;
    let projected = sourceIds.map((id) => `${blockId}${id.slice(sourceBlockId.length)}`);
    while (projected.some((id) => used.has(id))) {
      blockId = `${baseId}~${occurrence}`;
      occurrence += 1;
      projected = sourceIds.map((id) => `${blockId}${id.slice(sourceBlockId.length)}`);
    }
    projected.forEach((id) => used.add(id));
    return rewriteBlockIdPrefix(node, sourceBlockId, blockId);
  };

  const materialized = nodes.map((node) => {
    const sourceBlockId = node.attrs.blockId;
    const top = isGeneratedAiBlockId(sourceBlockId)
      ? allocatePrefix(node, sourceBlockId, baseNamespace)
      : node;
    const topBlockId = top.attrs.blockId;
    used.add(topBlockId);
    ids.push(topBlockId);

    const visitChildren = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visitNode);
      return value;
    };
    const visitNode = (value: unknown): unknown => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      let current = value as PmNode;
      const currentRecord = current as unknown as { attrs?: { blockId?: unknown } };
      const currentId = currentRecord.attrs?.blockId;
      if (isGeneratedAiBlockId(currentId)) {
        current = allocatePrefix(current, currentId, `${baseNamespace}:${topBlockId}`);
      }
      const record = current as unknown as Record<string, unknown>;
      return Array.isArray(record.content)
        ? { ...record, content: visitChildren(record.content) }
        : current;
    };
    const record = top as unknown as Record<string, unknown>;
    if (!Array.isArray(record.content)) {
      return top;
    }
    return { ...record, content: visitChildren(record.content) } as PmBlockNode;
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
  assertUniquePmBlockIds(parsed.data as PmDoc);
  return parsed.data as PmDoc;
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

/** 只校验 canonical 身份唯一性，不物化或改写任何 blockId。 */
export function assertUniquePmBlockIds(doc: PmDoc): void {
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
