import { countGraphemes, truncateGraphemes } from "@qingagent/contract-ts";

import { parseDiagram } from "./parser.js";

import { MAX_MERMAID_ID_GRAPHEMES, createEdgeIdFactory, getLines, isStableMermaidId } from "./shared.js";

import { BaseEdge, BaseNode, DiagramModel, DiagramOverlay, DiagramType, ElementIdMap, MindNode, RewriteResult } from "./types.js";



export function getStableElementIds(model: DiagramModel): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const node of modelNodes(model)) {
    if (node.id) nodes.add(node.id);
  }
  // 分区也是可拖拽的稳定画布元素，位置与普通节点共用 overlay.positions。
  if (model.type === "flowchart") {
    for (const subgraph of model.subgraphs) {
      if (subgraph.id) nodes.add(subgraph.id);
    }
  }
  for (const edge of modelEdges(model)) {
    if (edge.id) edges.add(edge.id);
  }
  return { nodes, edges };
}

export function filterStableOverlay(source: string, overlay: DiagramOverlay | null | undefined): DiagramOverlay | undefined {
  if (!overlay) return undefined;
  const parsed = parseDiagram(source);
  if (!parsed.ok) return undefined;
  const ids = getStableElementIds(parsed.model);
  const positions = filterRecord(overlay.positions, ids.nodes);
  const styles = filterRecord(overlay.styles, ids.nodes);
  const zOrders = filterRecord(overlay.zOrders, ids.nodes);
  const edgeStyles = filterRecord(overlay.edgeStyles, ids.edges);
  const edgeHandles = filterRecord(overlay.edgeHandles, ids.edges);
  return compactOverlay({ positions, styles, zOrders, edgeStyles, edgeHandles });
}

export function carryOverDiagramOverlay(
  oldSource: string,
  oldOverlay: DiagramOverlay | null | undefined,
  newSource: string,
  idMap?: ElementIdMap,
): DiagramOverlay | undefined {
  if (!oldOverlay) return undefined;
  const oldParsed = parseDiagram(oldSource);
  const newParsed = parseDiagram(newSource);
  if (!oldParsed.ok || !newParsed.ok) return undefined;
  const oldIds = getStableElementIds(oldParsed.model);
  const newIds = getStableElementIds(newParsed.model);
  const nodes = intersectSets(oldIds.nodes, newIds.nodes);
  const edges = intersectSets(oldIds.edges, newIds.edges);
  const positions = remapRecord(oldOverlay.positions, newIds.nodes, nodes, idMap?.nodes);
  const styles = remapRecord(oldOverlay.styles, newIds.nodes, nodes, idMap?.nodes);
  const zOrders = remapRecord(oldOverlay.zOrders, newIds.nodes, nodes, idMap?.nodes);
  const edgeStyles = remapRecord(oldOverlay.edgeStyles, newIds.edges, edges, idMap?.edges);
  const edgeHandles = remapRecord(oldOverlay.edgeHandles, newIds.edges, edges, idMap?.edges);
  return compactOverlay({ positions, styles, zOrders, edgeStyles, edgeHandles });
}

export function compactOverlay(overlay: DiagramOverlay): DiagramOverlay | undefined {
  const compacted: DiagramOverlay = {
    ...(overlay.positions ? { positions: overlay.positions } : {}),
    ...(overlay.styles ? { styles: overlay.styles } : {}),
    ...(overlay.zOrders ? { zOrders: overlay.zOrders } : {}),
    ...(overlay.edgeStyles ? { edgeStyles: overlay.edgeStyles } : {}),
    ...(overlay.edgeHandles ? { edgeHandles: overlay.edgeHandles } : {}),
  };
  return emptyOverlay(compacted) ? undefined : compacted;
}

export function modelNodes(model: DiagramModel): BaseNode[] {
  if (model.type === "flowchart") return model.nodes;
  if (model.type === "state") return model.nodes;
  if (model.type === "er") return model.entities;
  if (model.type === "class") return model.classes;
  return flattenMindmap(model.root).map((node) => ({
    id: node.id,
    label: node.label,
    declared: true,
    hasStableId: node.hasStableId,
    scopePath: node.scopePath,
    sourceRefs: node.sourceRefs,
  }));
}

export function addedNodeRewriteResult(
  source: string,
  nextSource: string,
  expectedType: DiagramType,
  id: string,
): RewriteResult {
  const reparsed = parseDiagram(nextSource);
  if (!reparsed.ok || reparsed.model.type !== expectedType) {
    return { ok: false, source, error: reparsed.error ?? "新节点写回后无法重新解析" };
  }
  if (
    countGraphemes(id) > MAX_MERMAID_ID_GRAPHEMES ||
    !isStableMermaidId(id)
  ) {
    return { ok: false, source, error: "新节点 ID 写回校验失败" };
  }
  const matchingNodes = modelNodes(reparsed.model).filter((node) => node.id === id);
  if (matchingNodes.length !== 1) {
    return { ok: false, source, error: "新节点写回校验失败" };
  }
  return { ok: true, newNodeId: id, source: nextSource };
}

export function edgeRewriteResult(
  originalSource: string,
  nextSource: string,
  diagramType: DiagramType,
  oldEdge: BaseEdge,
  verify?: (nextModel: DiagramModel, nextEdge: BaseEdge) => boolean,
): RewriteResult {
  const reparsed = parseDiagram(nextSource);
  if (!reparsed.ok || reparsed.model.type !== diagramType) {
    return { ok: false, source: originalSource, error: reparsed.error ?? "边改写后无法重新解析" };
  }
  const nextEdge = modelEdges(reparsed.model).find((edge) => edge.orderIndex === oldEdge.orderIndex);
  if (!nextEdge) return { ok: false, source: originalSource, error: "边改写后无法重新定位" };
  if (verify && !verify(reparsed.model, nextEdge)) {
    return { ok: false, source: originalSource, error: "边改写后语义校验失败" };
  }
  return nextEdge.id === oldEdge.id
    ? { ok: true, source: nextSource }
    : { ok: true, source: nextSource, idMap: { edges: { [oldEdge.id]: nextEdge.id } } };
}

export function modelEdges(model: DiagramModel): BaseEdge[] {
  if (model.type === "flowchart") return model.edges;
  if (model.type === "state") return model.edges;
  if (model.type === "er") return model.rels;
  if (model.type === "class") return model.rels;
  const nodes = flattenMindmap(model.root);
  const edges: BaseEdge[] = [];
  let order = 0;
  const nextEdgeId = createEdgeIdFactory("mind");
  for (const node of nodes) {
    for (const child of node.children) {
      const orderIndex = order++;
      edges.push({
        id: nextEdgeId({ source: node.id, target: child.id, syntaxKind: "tree" }),
        source: node.id,
        target: child.id,
        syntaxKind: "tree",
        orderIndex,
        scopePath: child.scopePath.slice(0, -1),
        rewritable: node.hasStableId && child.hasStableId,
        stmt: child.line,
      });
    }
  }
  return edges;
}

export function flattenMindmap(root: MindNode): MindNode[] {
  const out: MindNode[] = [];
  const walk = (node: MindNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function subtreeEnd(source: string, node: MindNode): number {
  const lines = getLines(source);
  const current = lines.find((line) => line.start === node.line.start);
  if (!current) return node.line.end;
  let end = current.end;
  for (const line of lines.slice(current.index + 1)) {
    if (!line.text.trim()) {
      end = line.end;
      continue;
    }
    const indent = line.text.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= node.indent) break;
    end = line.end;
  }
  return end;
}

export function insertAtLineBoundary(source: string, index: number, text: string): string {
  const leading = index > 0 && source[index - 1] !== "\n" ? "\n" : "";
  const trailing = index < source.length && text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  return source.slice(0, index) + leading + text + trailing + source.slice(index);
}

export function isMindmapDescendant(candidate: MindNode, ancestor: MindNode): boolean {
  return candidate.scopePath.length > ancestor.scopePath.length && ancestor.scopePath.every((part, index) => candidate.scopePath[index] === part);
}

export function filterRecord<T>(record: Record<string, T> | undefined, allowed: Set<string>): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function remapRecord<T>(
  record: Record<string, T> | undefined,
  allowedNewIds: Set<string>,
  unchangedIds: Set<string>,
  idMap: Record<string, string> | undefined,
): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [oldId, value] of Object.entries(record)) {
    const newId = idMap?.[oldId] ?? (unchangedIds.has(oldId) ? oldId : null);
    if (newId && allowedNewIds.has(newId)) out[newId] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function emptyOverlay(overlay: DiagramOverlay): boolean {
  return !overlay.positions && !overlay.styles && !overlay.zOrders && !overlay.edgeStyles && !overlay.edgeHandles;
}

export function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}
