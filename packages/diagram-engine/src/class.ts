import { applyEdits, lineRemovalSpan, lineSpan } from "./flowchart.js";

import { safeMermaidId, safeMermaidLabel } from "./mermaid.js";

import { addedNodeRewriteResult, edgeRewriteResult } from "./overlay.js";

import { boundedUniqueMermaidId, cap, connectEndpointError, createEdgeIdFactory, dedupeEdits, emptyParse, ensureCapability, getLines, insertBeforeSourceEnd, reconnectEndpointError, unsupportedRewrite } from "./shared.js";

import { parseDiagramThemeMetadata, presentationSyntaxFullyRepresented } from "./theme.js";

import { BaseNode, Capability, ClassGraph, EditOp, ParseResult, RewriteResult, Span } from "./types.js";



export function parseClass(source: string): ParseResult {
  const lines = getLines(source);
  const header = lines.find((line) => /^\s*classDiagram\b/.test(line.text));
  if (!header) return emptyParse("class", "缺少 classDiagram 头");
  const classes = new Map<string, BaseNode & { members: { raw: string; span: Span }[]; generics?: string }>();
  const rels: ClassGraph["rels"] = [];
  const protectedSpans: Span[] = [];
  const deleteProtectedNodeIds = new Set<string>();
  let order = 0;
  let fullyRepresented = true;
  const nextEdgeId = createEdgeIdFactory("class");
  let inClass: string | null = null;
  const ensureClass = (id: string, span?: Span, declared = false) => {
    const existing = classes.get(id);
    if (existing) {
      if (declared) existing.declared = true;
      if (span) existing.sourceRefs.push(span);
      return existing;
    }
    const node = { id, label: id, declared, implicit: !declared, hasStableId: true, scopePath: [], sourceRefs: span ? [span] : [], members: [] };
    classes.set(id, node);
    return node;
  };
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed || line === header) continue;
    if (trimmed.startsWith("%%")) {
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const block = trimmed.match(/^class\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)(?:~[^~]+~)?\s*\{\s*$/u);
    if (block) {
      if (trimmed.includes("~")) fullyRepresented = false;
      inClass = block[1]!;
      ensureClass(inClass, lineSpan(line), true);
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (inClass) {
      protectedSpans.push(lineSpan(line));
      if (/^}/.test(trimmed)) inClass = null;
      else classes.get(inClass)?.members.push({ raw: trimmed, span: lineSpan(line) });
      continue;
    }
    const colonMember = trimmed.match(/^([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*:\s*\S.*$/u);
    if (colonMember) {
      fullyRepresented = false;
      deleteProtectedNodeIds.add(colonMember[1]!);
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const decl = trimmed.match(/^class\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)(?:\s*\["([^"]+)"\])?\s*$/u);
    if (decl) {
      const node = ensureClass(decl[1]!, lineSpan(line), true);
      if (decl[2]) node.label = decl[2];
      continue;
    }
    const rel = line.text.match(/^(\s*)([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s+([<|*o.]{0,2}--[>|*o.]{0,2}|<\|--|\*--|o--|\.\.>|-->)\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)(?:\s*:\s*(.*?))?\s*$/u);
    if (rel) {
      const left = rel[2]!;
      const syntax = rel[3]!;
      const right = rel[4]!;
      const label = rel[5]?.trim();
      const orderIndex = order++;
      ensureClass(left);
      ensureClass(right);
      rels.push({
        id: nextEdgeId({ source: left, target: right, syntaxKind: syntax, label: label || undefined }),
        source: left,
        target: right,
        ...(label ? { label } : {}),
        syntaxKind: syntax,
        relKind: syntax,
        orderIndex,
        scopePath: [],
        rewritable: true,
        stmt: lineSpan(line),
      });
      continue;
    }
    protectedSpans.push(lineSpan(line));
    fullyRepresented = false;
  }
  const themeMetadata = parseDiagramThemeMetadata(source, classes.keys());
  return {
    ok: true,
    fullyRepresented:
      fullyRepresented && presentationSyntaxFullyRepresented(source),
    ...themeMetadata,
    model: {
      type: "class",
      classes: [...classes.values()],
      rels,
      ...(deleteProtectedNodeIds.size > 0 ? { deleteProtectedNodeIds: [...deleteProtectedNodeIds] } : {}),
      ...themeMetadata,
    },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
}

export function classCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as ClassGraph;
  const edge = target?.edgeId ? model.rels.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.classes.find((n) => n.id === target.nodeId) : undefined;
  const deleteProtected = !!node && model.deleteProtectedNodeIds?.includes(node.id);
  return [
    cap("connectEdge", true),
    cap("deleteEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("reconnectEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("addNode", true),
    cap(
      "deleteNode",
      !!node && node.hasStableId && node.members.length === 0 && !deleteProtected,
      node?.members.length
        ? "成员块 class 只读"
        : deleteProtected
          ? "该 class 含未完整建模的冒号式成员，暂不可删除"
          : undefined,
    ),
    cap("relabelNode", false, "class 名就是引用 id,默认禁止 rename"),
    cap("setNodeShape", false, "class 节点形状由图类型决定"),
    cap("setEdgeLabel", false, "class 关系标签语法不是 flowchart |label|"),
    cap("moveNode", false, "class 不支持节点改父"),
  ];
}

export function rewriteClass(source: string, p: ParseResult, op: EditOp): RewriteResult {
  const model = p.model as ClassGraph;
  const ensure = ensureCapability(p, op, op.kind === "deleteEdge" || op.kind === "reconnectEdge" ? { edgeId: op.edgeId } : "nodeId" in op ? { nodeId: op.nodeId } : undefined);
  if (!ensure.ok) return { ok: false, source, error: ensure.error };
  if (op.kind === "connectEdge") {
    const endpointError = connectEndpointError(model.classes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    return { ok: true, source: insertBeforeSourceEnd(source, `  ${op.source} --> ${op.target}${op.label ? ` : ${safeMermaidLabel(op.label)}` : ""}\n`) };
  }
  if (op.kind === "deleteEdge") {
    const edge = model.rels.find((e) => e.id === op.edgeId)!;
    return { ok: true, source: applyEdits(source, [{ ...lineRemovalSpan(source, edge.stmt), text: "" }]) };
  }
  if (op.kind === "reconnectEdge") {
    const edge = model.rels.find((e) => e.id === op.edgeId)!;
    const endpointError = reconnectEndpointError(model.classes.map((n) => n.id), op);
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
    const id = boundedUniqueMermaidId(
      model.classes.map((n) => n.id),
      safeMermaidId(op.label, "Class"),
    );
    const nextSource = insertBeforeSourceEnd(source, `  class ${id}\n`);
    return addedNodeRewriteResult(source, nextSource, "class", id);
  }
  if (op.kind === "deleteNode") {
    const node = model.classes.find((n) => n.id === op.nodeId)!;
    const edits = [...node.sourceRefs.map((ref) => ({ ...lineRemovalSpan(source, ref), text: "" }))];
    for (const edge of model.rels.filter((e) => e.source === op.nodeId || e.target === op.nodeId)) edits.push({ ...lineRemovalSpan(source, edge.stmt), text: "" });
    return { ok: true, source: applyEdits(source, dedupeEdits(edits)) };
  }
  return unsupportedRewrite(source, op.kind);
}
