import { applyEdits, lineRemovalSpan, lineSpan } from "./flowchart.js";

import { safeMermaidId, safeMermaidLabel } from "./mermaid.js";

import { addedNodeRewriteResult, edgeRewriteResult } from "./overlay.js";

import { boundedUniqueMermaidId, cap, connectEndpointError, createEdgeIdFactory, dedupeEdits, emptyParse, ensureCapability, getLines, insertBeforeSourceEnd, isStableStateId, reconnectEndpointError, unsupportedRewrite } from "./shared.js";

import { parseDiagramThemeMetadata, presentationSyntaxFullyRepresented } from "./theme.js";

import { BaseEdge, BaseNode, Capability, EditOp, ParseResult, RewriteResult, Span, StateGraph } from "./types.js";



export function parseState(source: string): ParseResult {
  const lines = getLines(source);
  const header = lines.find((line) => /^\s*stateDiagram(?:-v2)?\b/.test(line.text));
  if (!header) return emptyParse("state", "缺少 stateDiagram 头");
  const nodes = new Map<string, BaseNode & { kind: "state" | "start" | "end" | "choice" | "fork" | "composite" }>();
  const edges: BaseEdge[] = [];
  const protectedSpans: Span[] = [];
  const deleteProtectedNodeIds = new Set<string>();
  let edgeOrder = 0;
  let fullyRepresented = true;
  const nextEdgeId = createEdgeIdFactory("state");
  let compositeDepth = 0;
  const ensureNode = (id: string, label = id, declared = false, span?: Span, labelSpan?: Span, kind: "state" | "start" | "end" | "choice" | "fork" | "composite" = "state") => {
    const existing = nodes.get(id);
    if (existing) {
      if (declared) existing.declared = true;
      if (label && existing.label === existing.id) existing.label = label;
      if (span) existing.sourceRefs.push(span);
      if (labelSpan) existing.labelSpan = labelSpan;
      return existing;
    }
    const node = { id, label, declared, implicit: !declared, hasStableId: kind === "start" || kind === "end" ? false : isStableStateId(id), scopePath: [], sourceRefs: span ? [span] : [], ...(labelSpan ? { labelSpan } : {}), kind };
    nodes.set(id, node);
    return node;
  };
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed || line === header) continue;
    if (trimmed.startsWith("%%")) {
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const compositeDeclaration = line.text.match(new RegExp(
      String.raw`^(\s*)state\s+(?:"([^"]*)"\s+as\s+(${STATE_ENDPOINT_RE})|(${STATE_ENDPOINT_RE}))\s*\{\s*$`,
      "u",
    ));
    if (compositeDeclaration) {
      fullyRepresented = false;
      const label = compositeDeclaration[2];
      const id = compositeDeclaration[3] ?? compositeDeclaration[4]!;
      const labelStart = label === undefined
        ? undefined
        : line.start + compositeDeclaration[1]!.length + `state "`.length;
      ensureNode(
        id,
        label ?? id,
        true,
        lineSpan(line),
        labelStart === undefined
          ? undefined
          : { start: labelStart, end: labelStart + label!.length },
        "composite",
      );
      deleteProtectedNodeIds.add(id);
      protectedSpans.push(lineSpan(line));
      compositeDepth += 1;
      continue;
    }
    if (/^note\b|^state\s+\S+\s*<</i.test(trimmed) || /<<(?:choice|fork|join)>>/i.test(trimmed)) {
      fullyRepresented = false;
      const specialDeclaration = trimmed.match(
        /^state\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*<<\s*(?:choice|fork|join)\s*>>/iu,
      );
      if (specialDeclaration) deleteProtectedNodeIds.add(specialDeclaration[1]!);
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (/^}$/.test(trimmed)) {
      compositeDepth = Math.max(0, compositeDepth - 1);
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const alias = line.text.match(new RegExp(String.raw`^(\s*)state\s+"([^"]+)"\s+as\s+(${STATE_ENDPOINT_RE})\s*$`, "u"));
    if (alias) {
      const label = alias[2]!;
      const id = alias[3]!;
      const labelStart = line.start + alias[1]!.length + `state "`.length;
      ensureNode(id, label, true, lineSpan(line), { start: labelStart, end: labelStart + label.length });
      continue;
    }
    const transition = matchStateTransition(line.text);
    if (transition) {
      const from = stateEndpoint(transition.from, "source");
      const to = stateEndpoint(transition.to, "target");
      const label = transition.label?.trim();
      const orderIndex = edgeOrder++;
      ensureNode(from.id, from.label, false, undefined, undefined, from.kind);
      ensureNode(to.id, to.label, false, undefined, undefined, to.kind);
      edges.push({
        id: nextEdgeId({ source: from.id, target: to.id, syntaxKind: "-->", label: label || undefined }),
        source: from.id,
        target: to.id,
        ...(label ? { label } : {}),
        syntaxKind: "-->",
        orderIndex,
        scopePath: [],
        rewritable: compositeDepth === 0 && !from.pseudo && !to.pseudo,
        stmt: lineSpan(line),
      });
      continue;
    }
    const bare = matchStateBare(line.text);
    if (bare) {
      ensureNode(bare.id, bare.id, true, lineSpan(line));
      continue;
    }
    protectedSpans.push(lineSpan(line));
    fullyRepresented = false;
  }
  const themeMetadata = parseDiagramThemeMetadata(source, nodes.keys());
  return {
    ok: true,
    fullyRepresented:
      fullyRepresented && presentationSyntaxFullyRepresented(source),
    ...themeMetadata,
    model: {
      type: "state",
      nodes: [...nodes.values()],
      edges,
      ...(deleteProtectedNodeIds.size > 0 ? { deleteProtectedNodeIds: [...deleteProtectedNodeIds] } : {}),
      ...themeMetadata,
    },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
}

export function stateCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as StateGraph;
  const edge = target?.edgeId ? model.edges.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.nodes.find((n) => n.id === target.nodeId) : undefined;
  const deleteProtected = !!node && model.deleteProtectedNodeIds?.includes(node.id);
  return [
    cap("connectEdge", true),
    cap("deleteEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "transition 不可回写"),
    cap("reconnectEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "transition 不可回写"),
    cap("addNode", true),
    cap(
      "deleteNode",
      !!node && node.hasStableId && node.kind === "state" && !deleteProtected,
      deleteProtected ? "该节点含未完整建模的特殊 State 声明，暂不可删除" : "仅普通 state 可删除",
    ),
    cap("relabelNode", !!node && node.hasStableId && !!node.labelSpan, node?.labelSpan ? undefined : "仅 state \"label\" as ID 可改 label"),
    cap("setNodeShape", false, "state 形状由状态语义决定,不做形状回写"),
    cap("setEdgeLabel", false, "state 边标签语法不是 flowchart |label|"),
    cap("moveNode", false, "state 不支持节点改父"),
  ];
}

export function rewriteState(source: string, p: ParseResult, op: EditOp): RewriteResult {
  const model = p.model as StateGraph;
  const ensure = ensureCapability(p, op, op.kind === "deleteEdge" || op.kind === "reconnectEdge" ? { edgeId: op.edgeId } : "nodeId" in op ? { nodeId: op.nodeId } : undefined);
  if (!ensure.ok) return { ok: false, source, error: ensure.error };
  if (op.kind === "connectEdge") {
    const endpointError = connectEndpointError(model.nodes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    return { ok: true, source: insertBeforeSourceEnd(source, `  ${op.source} --> ${op.target}${op.label ? ` : ${safeMermaidLabel(op.label)}` : ""}\n`) };
  }
  if (op.kind === "deleteEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    return { ok: true, source: applyEdits(source, [{ ...lineRemovalSpan(source, edge.stmt), text: "" }]) };
  }
  if (op.kind === "reconnectEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const endpointError = reconnectEndpointError(model.nodes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    const line = source.slice(edge.stmt.start, edge.stmt.end);
    return edgeRewriteResult(
      source,
      applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: `  ${op.newSource ?? edge.source} --> ${op.newTarget ?? edge.target}${edge.label ? ` : ${edge.label}` : ""}${line.endsWith("\n") ? "\n" : ""}` }]),
      model.type,
      edge,
    );
  }
  if (op.kind === "addNode") {
    const id = boundedUniqueMermaidId(
      model.nodes.map((n) => n.id),
      safeMermaidId(op.label, "state"),
    );
    const nextSource = insertBeforeSourceEnd(source, `  state "${safeMermaidLabel(op.label)}" as ${id}\n`);
    return addedNodeRewriteResult(source, nextSource, "state", id);
  }
  if (op.kind === "deleteNode") {
    const node = model.nodes.find((n) => n.id === op.nodeId)!;
    const edits = [...node.sourceRefs.map((ref) => ({ ...lineRemovalSpan(source, ref), text: "" }))];
    for (const edge of model.edges.filter((e) => e.source === op.nodeId || e.target === op.nodeId)) edits.push({ ...lineRemovalSpan(source, edge.stmt), text: "" });
    return { ok: true, source: applyEdits(source, dedupeEdits(edits)) };
  }
  if (op.kind === "relabelNode") {
    const node = model.nodes.find((n) => n.id === op.nodeId)!;
    return { ok: true, source: applyEdits(source, [{ start: node.labelSpan!.start, end: node.labelSpan!.end, text: safeMermaidLabel(op.label) }]) };
  }
  return unsupportedRewrite(source, op.kind);
}

export const STATE_ENDPOINT_RE = String.raw`(?:\[\*\]|[\p{L}\p{N}_][\p{L}\p{N}_-]*)`;

export function matchStateTransition(text: string): { from: string; to: string; label?: string } | null {
  const match = text.match(new RegExp(String.raw`^\s*(${STATE_ENDPOINT_RE})\s*-->\s*(${STATE_ENDPOINT_RE})(?:\s*:\s*(.*?))?\s*$`, "u"));
  if (!match) return null;
  return { from: match[1]!, to: match[2]!, ...(match[3] !== undefined ? { label: match[3] } : {}) };
}

export function matchStateBare(text: string): { id: string } | null {
  const match = text.match(new RegExp(String.raw`^\s*(${STATE_ENDPOINT_RE})\s*$`, "u"));
  if (!match || match[1] === "[*]") return null;
  return { id: match[1]! };
}

export function stateEndpoint(raw: string, role: "source" | "target"): {
  id: string;
  label: string;
  kind: "state" | "start" | "end";
  pseudo: boolean;
} {
  if (raw === "[*]") {
    return role === "source"
      ? { id: "__start", label: "[*]", kind: "start", pseudo: true }
      : { id: "__end", label: "[*]", kind: "end", pseudo: true };
  }
  return { id: raw, label: raw, kind: "state", pseudo: false };
}
