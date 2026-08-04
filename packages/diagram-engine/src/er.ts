import { applyEdits, lineRemovalSpan, lineSpan } from "./flowchart.js";

import { safeMermaidId, safeMermaidLabel } from "./mermaid.js";

import { addedNodeRewriteResult, edgeRewriteResult } from "./overlay.js";

import { boundedUniqueMermaidId, cap, connectEndpointError, createEdgeIdFactory, dedupeEdits, emptyParse, ensureCapability, getLines, insertBeforeSourceEnd, reconnectEndpointError, unsupportedRewrite } from "./shared.js";

import { parseDiagramThemeMetadata, presentationSyntaxFullyRepresented } from "./theme.js";

import { BaseNode, Capability, EditOp, ErGraph, ParseResult, RewriteResult, Span } from "./types.js";



export function parseEr(source: string): ParseResult {
  const lines = getLines(source);
  const header = lines.find((line) => /^\s*erDiagram\b/.test(line.text));
  if (!header) return emptyParse("er", "缺少 erDiagram 头");
  const entities = new Map<string, BaseNode & { attrs: { type: string; name: string; keys?: string[]; span: Span }[] }>();
  const rels: ErGraph["rels"] = [];
  const protectedSpans: Span[] = [];
  let order = 0;
  let fullyRepresented = true;
  const nextEdgeId = createEdgeIdFactory("er");
  let inAttrs: string | null = null;
  const ensureEntity = (id: string, span?: Span, declared = false) => {
    const existing = entities.get(id);
    if (existing) {
      if (declared) existing.declared = true;
      if (span) existing.sourceRefs.push(span);
      return existing;
    }
    const node: BaseNode & { attrs: { type: string; name: string; keys?: string[]; span: Span }[] } = {
      id,
      label: id,
      declared,
      implicit: !declared,
      hasStableId: true,
      scopePath: [],
      sourceRefs: span ? [span] : [],
      attrs: [],
    };
    entities.set(id, node);
    return node;
  };
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed || line === header) continue;
    if (trimmed.startsWith("%%")) {
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const inlineBlock = trimmed.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*\{\s*(.*?)\s*\}\s*$/u);
    if (inlineBlock) {
      const entity = ensureEntity(inlineBlock[1]!, lineSpan(line), true);
      const attr = parseErAttr(inlineBlock[2] ?? "", lineSpan(line));
      if (attr) entity.attrs.push(attr);
      if (!attr || attr.keys?.length) fullyRepresented = false;
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const blockStart = trimmed.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*\{\s*$/u);
    if (blockStart) {
      inAttrs = blockStart[1]!;
      ensureEntity(inAttrs, lineSpan(line), true);
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (inAttrs) {
      if (!/^}/.test(trimmed)) {
        const attr = parseErAttr(trimmed, lineSpan(line));
        if (attr) entities.get(inAttrs)?.attrs.push(attr);
        if (!attr || attr.keys?.length) fullyRepresented = false;
      }
      protectedSpans.push(lineSpan(line));
      if (/^}/.test(trimmed)) inAttrs = null;
      continue;
    }
    const rel = line.text.match(/^(\s*)([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s+([|o}{][|o}{]--[|o}{][|o}{])\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)(?:\s*:\s*(.*?))?\s*$/u);
    if (rel) {
      const left = rel[2]!;
      const syntax = rel[3]!;
      const right = rel[4]!;
      const label = rel[5]?.trim();
      const orderIndex = order++;
      ensureEntity(left);
      ensureEntity(right);
      rels.push({
        id: nextEdgeId({ source: left, target: right, syntaxKind: syntax, label: label || undefined }),
        source: left,
        target: right,
        ...(label ? { label } : {}),
        syntaxKind: syntax,
        orderIndex,
        scopePath: [],
        rewritable: true,
        stmt: lineSpan(line),
        leftCard: syntax.slice(0, 2),
        rightCard: syntax.slice(-2),
      });
      continue;
    }
    const bare = trimmed.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]*)$/u);
    if (bare) {
      ensureEntity(bare[1]!, lineSpan(line), true);
      continue;
    }
    protectedSpans.push(lineSpan(line));
    fullyRepresented = false;
  }
  const themeMetadata = parseDiagramThemeMetadata(source, entities.keys());
  return {
    ok: true,
    fullyRepresented:
      fullyRepresented && presentationSyntaxFullyRepresented(source),
    ...themeMetadata,
    model: { type: "er", entities: [...entities.values()], rels, ...themeMetadata },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
}

export function erCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as ErGraph;
  const edge = target?.edgeId ? model.rels.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.entities.find((n) => n.id === target.nodeId) : undefined;
  return [
    cap("connectEdge", true),
    cap("deleteEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("reconnectEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("addNode", true),
    cap("deleteNode", !!node && node.hasStableId && node.attrs.length === 0, node?.attrs.length ? "属性块实体只读" : undefined),
    cap("relabelNode", false, "ER 实体名就是引用 id,默认禁止 rename"),
    cap("setNodeShape", false, "ER 节点形状由图类型决定"),
    cap("setEdgeLabel", false, "ER 关系标签语法不是 flowchart |label|"),
    cap("moveNode", false, "ER 不支持节点改父"),
  ];
}

export function rewriteEr(source: string, p: ParseResult, op: EditOp): RewriteResult {
  const model = p.model as ErGraph;
  const ensure = ensureCapability(p, op, op.kind === "deleteEdge" || op.kind === "reconnectEdge" ? { edgeId: op.edgeId } : "nodeId" in op ? { nodeId: op.nodeId } : undefined);
  if (!ensure.ok) return { ok: false, source, error: ensure.error };
  if (op.kind === "connectEdge") {
    const endpointError = connectEndpointError(model.entities.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    return { ok: true, source: insertBeforeSourceEnd(source, `  ${op.source} ||--o{ ${op.target}${op.label ? ` : ${safeMermaidLabel(op.label)}` : ""}\n`) };
  }
  if (op.kind === "deleteEdge") {
    const edge = model.rels.find((e) => e.id === op.edgeId)!;
    return { ok: true, source: applyEdits(source, [{ ...lineRemovalSpan(source, edge.stmt), text: "" }]) };
  }
  if (op.kind === "reconnectEdge") {
    const edge = model.rels.find((e) => e.id === op.edgeId)!;
    const endpointError = reconnectEndpointError(model.entities.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    const line = source.slice(edge.stmt.start, edge.stmt.end);
    return edgeRewriteResult(
      source,
      applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: `  ${op.newSource ?? edge.source} ${edge.syntaxKind} ${op.newTarget ?? edge.target}${edge.label ? ` : ${edge.label}` : ""}${line.endsWith("\n") ? "\n" : ""}` }]),
      model.type,
      edge,
    );
  }
  if (op.kind === "addNode") {
    const baseId = safeMermaidId(safeMermaidId(op.label, "entity").toUpperCase(), "ENTITY");
    const id = boundedUniqueMermaidId(model.entities.map((n) => n.id), baseId);
    const nextSource = insertBeforeSourceEnd(source, `  ${id}\n`);
    return addedNodeRewriteResult(source, nextSource, "er", id);
  }
  if (op.kind === "deleteNode") {
    const node = model.entities.find((n) => n.id === op.nodeId)!;
    const edits = [...node.sourceRefs.map((ref) => ({ ...lineRemovalSpan(source, ref), text: "" }))];
    for (const edge of model.rels.filter((e) => e.source === op.nodeId || e.target === op.nodeId)) edits.push({ ...lineRemovalSpan(source, edge.stmt), text: "" });
    return { ok: true, source: applyEdits(source, dedupeEdits(edits)) };
  }
  return unsupportedRewrite(source, op.kind);
}

export function parseErAttr(text: string, span: Span): { type: string; name: string; keys?: string[]; span: Span } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\S+)\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)(?:\s+(.+?))?\s*$/u);
  if (!match) return null;
  const keys = match[3]
    ?.split(/[,\s]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  return {
    type: match[1]!,
    name: match[2]!,
    ...(keys && keys.length > 0 ? { keys } : {}),
    span,
  };
}
