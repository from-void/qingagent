import { parseDiagram } from "./parser.js";

import { getFlowShapeGeometry, normalizeFlowShapeName } from "./flowchart.js";

import { modelEdges, modelNodes } from "./overlay.js";

import { GRAPH_LAYOUT_NODE_HEIGHT, GRAPH_LAYOUT_NODE_MAX_HEIGHT, GRAPH_LAYOUT_NODE_MAX_WIDTH, GRAPH_LAYOUT_NODE_MIN_HEIGHT, GRAPH_LAYOUT_NODE_MIN_WIDTH, GRAPH_LAYOUT_NODE_WIDTH, clampNodeHeight, clampNodeWidth, samePath, sanitizeColor } from "./presentation.js";

import { BaseEdge, BaseNode, DiagramGraphLayout, DiagramModel, DiagramOverlay, EdgeMarkerKind, EdgeStyleOverride, FlowGraph, GraphLayoutCluster, GraphLayoutRect, NodeStyleOverride, ThemePalette, sortIdsByZOrder } from "./types.js";



export function graphToSvg(source: string, overlay: DiagramOverlay | null | undefined = undefined): string | null {
  const parsed = parseDiagram(source);
  if (!parsed.ok) return null;
  // State/ER/Class/mindmap 都有通用节点/边字段无法表达的专有语义。带 overlay 时若继续
  // 生成通用 SVG，会丢状态形状、实体属性、类成员、基数或树关系；返回 null 让导出层
  // 保留已生成的官方 Mermaid SVG。flowchart 的 overlay 才由这里完整接管。
  if (parsed.model.type !== "flowchart" && hasGraphSvgOverlay(overlay)) return null;
  const edges = modelEdges(parsed.model);
  const flattened = modelNodes(parsed.model);
  const hasFlowSubgraphs = parsed.model.type === "flowchart" && parsed.model.subgraphs.length > 0;
  if (flattened.length === 0 && !hasFlowSubgraphs) return null;
  const layout = layoutDiagramGraph(parsed.model, overlay);
  const endpointRects: Record<string, GraphLayoutRect> = {
    ...layout.nodes,
    ...Object.fromEntries(layout.clusters.map((cluster) => [cluster.id, cluster])),
  };
  const bounds = graphSvgBounds(flattened, edges, layout, endpointRects, overlay);
  const clusterSvg = layout.clusters
    .sort((left, right) => left.depth - right.depth)
    .map((cluster) => renderSvgCluster(
      cluster,
      parsed.model.themePalette,
      parsed.model.type === "flowchart" ? parsed.model.perSubgraphStyles?.[cluster.id] : undefined,
    ))
    .join("");
  // 节点绘制顺序 = 层级顺序(后画的盖前面的),与画布 z 轴一致。
  const nodeOrder = new Map(
    sortIdsByZOrder(flattened.map((node) => node.id), overlay?.zOrders).map((id, index) => [id, index]),
  );
  const nodeSvg = [...flattened]
    .sort((left, right) => (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0))
    .map((node) =>
      renderSvgNode(
        node,
        layout.nodes[node.id] ?? { x: 24, y: 24, width: GRAPH_LAYOUT_NODE_WIDTH, height: GRAPH_LAYOUT_NODE_HEIGHT },
        parsed.model.themePalette,
        parsed.model.perNodeStyles?.[node.id],
        overlay?.styles?.[node.id],
      ),
    )
    .join("");
  const edgeSvg = edges
    .filter((edge) => endpointRects[edge.source] && endpointRects[edge.target])
    .map((edge) =>
      renderSvgEdge(
        edge,
        endpointRects[edge.source]!,
        endpointRects[edge.target]!,
        parsed.model.themePalette,
        { ...(parsed.model.perEdgeStyles?.[edge.id] ?? {}), ...(overlay?.edgeStyles?.[edge.id] ?? {}) },
      ),
    )
    .join("");
  const canvasBackground = sanitizeColor(parsed.model.themePalette?.canvasBackground) ?? "#faf6ec";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}" role="img">${svgDefs(parsed.model.themePalette)}<rect x="${bounds.minX}" y="${bounds.minY}" width="${bounds.width}" height="${bounds.height}" fill="${canvasBackground}"/>${clusterSvg}${edgeSvg}${nodeSvg}</svg>`;
}

export function hasGraphSvgOverlay(overlay: DiagramOverlay | null | undefined): boolean {
  return !!overlay && (
    Object.keys(overlay.positions ?? {}).length > 0 ||
    Object.keys(overlay.styles ?? {}).length > 0 ||
    Object.keys(overlay.edgeStyles ?? {}).length > 0
  );
}

export { GRAPH_LAYOUT_NODE_HEIGHT, GRAPH_LAYOUT_NODE_MAX_HEIGHT, GRAPH_LAYOUT_NODE_MAX_WIDTH, GRAPH_LAYOUT_NODE_MIN_HEIGHT, GRAPH_LAYOUT_NODE_MIN_WIDTH, GRAPH_LAYOUT_NODE_WIDTH };

export const GRAPH_LAYOUT_NODE_GAP = 70;

export const GRAPH_LAYOUT_LAYER_GAP = 86;

export const GRAPH_LAYOUT_ROOT_OFFSET = 40;

export const GRAPH_CLUSTER_SIDE_PADDING = 30;

export const GRAPH_CLUSTER_TITLE_HEIGHT = 46;

export const GRAPH_CLUSTER_BOTTOM_PADDING = 28;

export type LayoutDirection = "TB" | "BT" | "LR" | "RL";

export type LayoutItem = {
  id: string;
  width: number;
  height: number;
  nodeRects: Record<string, GraphLayoutRect>;
  clusters: GraphLayoutCluster[];
};

export type LayoutLink = { source: string; target: string; minLength: number };

export function graphLayoutNodeSize(
  sourceStyle: NodeStyleOverride | undefined,
  overlayStyle: NodeStyleOverride | undefined,
): { width: number; height: number } {
  return {
    width: clampNodeWidth(overlayStyle?.width ?? sourceStyle?.width ?? GRAPH_LAYOUT_NODE_WIDTH),
    height: clampNodeHeight(overlayStyle?.height ?? sourceStyle?.height ?? GRAPH_LAYOUT_NODE_HEIGHT),
  };
}

export function layoutDiagramGraph(
  model: DiagramModel,
  overlay: DiagramOverlay | null | undefined = undefined,
): DiagramGraphLayout {
  const nodes = modelNodes(model);
  const edges = modelEdges(model);
  const nodeSize = (nodeId: string) => graphLayoutNodeSize(model.perNodeStyles?.[nodeId], overlay?.styles?.[nodeId]);
  if (model.type !== "flowchart" || model.subgraphs.length === 0) {
    const items = nodes.map((node): LayoutItem => {
      const size = nodeSize(node.id);
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        nodeRects: {
          [node.id]: { x: 0, y: 0, width: size.width, height: size.height },
        },
        clusters: [],
      };
    });
    const arranged = arrangeLayoutItems(
      items,
      edges.map((edge) => ({ source: edge.source, target: edge.target, minLength: edge.minLength ?? 1 })),
      graphModelDirection(model),
    );
    const nodeRects = translateLayoutItems(arranged.items, GRAPH_LAYOUT_ROOT_OFFSET, GRAPH_LAYOUT_ROOT_OFFSET).nodes;
    applyOverlayPositions(nodeRects, overlay);
    return { nodes: nodeRects, clusters: [] };
  }

  const subgraphById = new Map(model.subgraphs.map((subgraph) => [subgraph.id, subgraph]));
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const rootDirection = normalizeLayoutDirection(model.direction);

  const endpointItemAtScope = (endpointId: string, scopePath: string[]): string | null => {
    const node = nodeById.get(endpointId);
    const endpointPath = node?.scopePath ?? (
      subgraphById.has(endpointId)
        ? [...subgraphById.get(endpointId)!.scopePath, endpointId]
        : []
    );
    if (endpointPath.length < scopePath.length || !scopePath.every((part, index) => endpointPath[index] === part)) return null;
    if (endpointPath.length === scopePath.length) return endpointId;
    return endpointPath[scopePath.length] ?? endpointId;
  };

  const subgraphDirection = (subgraphId: string, inherited: LayoutDirection): LayoutDirection => {
    const subgraph = subgraphById.get(subgraphId);
    if (!subgraph?.direction) return inherited;
    const endpointInside = (endpointId: string): boolean => {
      const node = nodeById.get(endpointId);
      if (node) return node.scopePath.includes(subgraphId);
      const childSubgraph = subgraphById.get(endpointId);
      return !!childSubgraph && childSubgraph.id !== subgraphId && childSubgraph.scopePath.includes(subgraphId);
    };
    const hasExternalNodeLink = model.edges.some((edge) => {
      const sourceInside = endpointInside(edge.source);
      const targetInside = endpointInside(edge.target);
      return sourceInside !== targetInside;
    });
    // Mermaid 官方行为:子图节点连到外部时,该子图 direction 被父方向覆盖。
    return hasExternalNodeLink ? inherited : normalizeLayoutDirection(subgraph.direction);
  };

  const buildGroup = (scopePath: string[], direction: LayoutDirection): LayoutItem[] => {
    const directNodes = model.nodes.filter((node) => samePath(node.scopePath, scopePath));
    const directSubgraphs = model.subgraphs.filter((subgraph) => samePath(subgraph.scopePath, scopePath));
    const items: LayoutItem[] = directNodes.map((node) => {
      const size = nodeSize(node.id);
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        nodeRects: {
          [node.id]: { x: 0, y: 0, width: size.width, height: size.height },
        },
        clusters: [],
      };
    });
    for (const subgraph of directSubgraphs) {
      const ownDirection = subgraphDirection(subgraph.id, direction);
      const childScope = [...scopePath, subgraph.id];
      const children = buildGroup(childScope, ownDirection);
      const pairs = model.edges
        .map((edge): LayoutLink | null => {
          const source = endpointItemAtScope(edge.source, childScope);
          const target = endpointItemAtScope(edge.target, childScope);
          return source && target && source !== target ? { source, target, minLength: edge.minLength ?? 1 } : null;
        })
        .filter((pair): pair is LayoutLink => !!pair);
      const arranged = arrangeLayoutItems(children, pairs, ownDirection);
      const translated = translateLayoutItems(
        arranged.items,
        GRAPH_CLUSTER_SIDE_PADDING,
        GRAPH_CLUSTER_TITLE_HEIGHT,
      );
      const width = Math.max(
        GRAPH_LAYOUT_NODE_WIDTH + GRAPH_CLUSTER_SIDE_PADDING * 2,
        arranged.width + GRAPH_CLUSTER_SIDE_PADDING * 2,
      );
      const height = Math.max(
        GRAPH_LAYOUT_NODE_HEIGHT + GRAPH_CLUSTER_TITLE_HEIGHT + GRAPH_CLUSTER_BOTTOM_PADDING,
        arranged.height + GRAPH_CLUSTER_TITLE_HEIGHT + GRAPH_CLUSTER_BOTTOM_PADDING,
      );
      const cluster: GraphLayoutCluster = {
        id: subgraph.id,
        label: subgraph.label,
        x: 0,
        y: 0,
        width,
        height,
        scopePath: [...subgraph.scopePath],
        direction: ownDirection,
        depth: subgraph.scopePath.length,
        empty: children.length === 0,
      };
      items.push({
        id: subgraph.id,
        width,
        height,
        nodeRects: translated.nodes,
        clusters: [cluster, ...translated.clusters],
      });
    }
    return items;
  };

  const rootItems = buildGroup([], rootDirection);
  const rootPairs = model.edges
    .map((edge): LayoutLink | null => {
      const source = endpointItemAtScope(edge.source, []);
      const target = endpointItemAtScope(edge.target, []);
      return source && target && source !== target ? { source, target, minLength: edge.minLength ?? 1 } : null;
    })
    .filter((pair): pair is LayoutLink => !!pair);
  const root = arrangeLayoutItems(rootItems, rootPairs, rootDirection);
  const translated = translateLayoutItems(root.items, GRAPH_LAYOUT_ROOT_OFFSET, GRAPH_LAYOUT_ROOT_OFFSET);
  applyOverlayPositions(translated.nodes, overlay);
  const clusters = refitClustersToContents(translated.clusters, translated.nodes, model.nodes, overlay);
  applyOverlayClusterPositions(translated.nodes, clusters, model, overlay);
  return { nodes: translated.nodes, clusters };
}

export function graphModelDirection(model: DiagramModel): LayoutDirection {
  if (model.type === "flowchart") return normalizeLayoutDirection(model.direction);
  if (model.type === "mindmap") return "LR";
  return "TB";
}

export function normalizeLayoutDirection(value: string | undefined): LayoutDirection {
  const direction = (value ?? "").trim().toUpperCase().replace(/;$/, "");
  if (direction === "LR" || direction === "RL" || direction === "BT") return direction;
  return "TB";
}

export function arrangeLayoutItems(
  items: LayoutItem[],
  rawLinks: LayoutLink[],
  direction: LayoutDirection,
): { items: Array<LayoutItem & { x: number; y: number }>; width: number; height: number } {
  if (items.length === 0) return { items: [], width: 0, height: 0 };
  const ids = new Set(items.map((item) => item.id));
  const links = rawLinks.filter(({ source, target }) => ids.has(source) && ids.has(target) && source !== target);
  const incoming = new Map(items.map((item) => [item.id, 0]));
  const outgoing = new Map(items.map((item) => [item.id, new Map<string, number>()]));
  for (const { source, target, minLength } of links) {
    const existingLength = outgoing.get(source)!.get(target);
    if (existingLength === undefined) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    outgoing.get(source)!.set(target, Math.max(existingLength ?? 1, minLength));
  }
  const rank = new Map<string, number>();
  const queue = items.filter((item) => (incoming.get(item.id) ?? 0) === 0).map((item) => item.id);
  for (const id of queue) rank.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    for (const [target, minLength] of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + minLength));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  let fallbackRank = Math.max(0, ...rank.values());
  for (const item of items) {
    if (!rank.has(item.id)) rank.set(item.id, fallbackRank++);
  }
  const layers = new Map<number, LayoutItem[]>();
  for (const item of items) {
    const itemRank = rank.get(item.id) ?? 0;
    const layer = layers.get(itemRank) ?? [];
    layer.push(item);
    layers.set(itemRank, layer);
  }
  const orderedLayerEntries = [...layers.entries()].sort(([left], [right]) => left - right);
  const orderedLayers = orderedLayerEntries.map(([, layer]) => layer);
  const layerRanks = orderedLayerEntries.map(([itemRank]) => itemRank);
  const vertical = direction === "TB" || direction === "BT";
  const layerMainSizes = orderedLayers.map((layer) => Math.max(...layer.map((item) => vertical ? item.height : item.width)));
  const layerCrossSizes = orderedLayers.map((layer) =>
    layer.reduce((size, item, index) => size + (vertical ? item.width : item.height) + (index > 0 ? GRAPH_LAYOUT_NODE_GAP : 0), 0)
  );
  const mainSize = layerMainSizes.reduce((size, layerSize, index) => {
    if (index === 0) return layerSize;
    const rankDistance = Math.max(1, layerRanks[index]! - layerRanks[index - 1]!);
    return size + layerSize + GRAPH_LAYOUT_LAYER_GAP * rankDistance;
  }, 0);
  const crossSize = Math.max(...layerCrossSizes);
  const placed: Array<LayoutItem & { x: number; y: number }> = [];
  let mainCursor = 0;
  orderedLayers.forEach((layer, layerIndex) => {
    const layerMain = layerMainSizes[layerIndex]!;
    const layerCross = layerCrossSizes[layerIndex]!;
    let crossCursor = (crossSize - layerCross) / 2;
    for (const item of layer) {
      let x = vertical ? crossCursor : mainCursor;
      let y = vertical ? mainCursor : crossCursor;
      if (direction === "BT") y = mainSize - y - item.height;
      if (direction === "RL") x = mainSize - x - item.width;
      placed.push({ ...item, x, y });
      crossCursor += (vertical ? item.width : item.height) + GRAPH_LAYOUT_NODE_GAP;
    }
    const nextRank = layerRanks[layerIndex + 1];
    const rankDistance = nextRank === undefined ? 0 : Math.max(1, nextRank - layerRanks[layerIndex]!);
    mainCursor += layerMain + GRAPH_LAYOUT_LAYER_GAP * rankDistance;
  });
  return {
    items: placed,
    width: vertical ? crossSize : mainSize,
    height: vertical ? mainSize : crossSize,
  };
}

export function translateLayoutItems(
  items: Array<LayoutItem & { x: number; y: number }>,
  offsetX: number,
  offsetY: number,
): { nodes: Record<string, GraphLayoutRect>; clusters: GraphLayoutCluster[] } {
  const nodes: Record<string, GraphLayoutRect> = {};
  const clusters: GraphLayoutCluster[] = [];
  for (const item of items) {
    const itemX = offsetX + item.x;
    const itemY = offsetY + item.y;
    for (const [id, rect] of Object.entries(item.nodeRects)) {
      nodes[id] = { ...rect, x: rect.x + itemX, y: rect.y + itemY };
    }
    for (const cluster of item.clusters) {
      clusters.push({ ...cluster, x: cluster.x + itemX, y: cluster.y + itemY });
    }
  }
  return { nodes, clusters };
}

export function applyOverlayPositions(
  nodes: Record<string, GraphLayoutRect>,
  overlay: DiagramOverlay | null | undefined,
): void {
  for (const [id, position] of Object.entries(overlay?.positions ?? {})) {
    if (!nodes[id] || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    nodes[id] = { ...nodes[id]!, x: position.x, y: position.y };
  }
}

export function applyOverlayClusterPositions(
  nodes: Record<string, GraphLayoutRect>,
  clusters: GraphLayoutCluster[],
  model: FlowGraph,
  overlay: DiagramOverlay | null | undefined,
): void {
  const positionById = overlay?.positions ?? {};
  const modelNodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const modelSubgraphById = new Map(model.subgraphs.map((subgraph) => [subgraph.id, subgraph]));
  for (const cluster of [...clusters].sort((left, right) => left.depth - right.depth)) {
    const position = positionById[cluster.id];
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    const dx = position.x - cluster.x;
    const dy = position.y - cluster.y;
    if (dx === 0 && dy === 0) continue;
    cluster.x += dx;
    cluster.y += dy;
    for (const [nodeId, rect] of Object.entries(nodes)) {
      if (!modelNodeById.get(nodeId)?.scopePath.includes(cluster.id)) continue;
      nodes[nodeId] = { ...rect, x: rect.x + dx, y: rect.y + dy };
    }
    for (const candidate of clusters) {
      if (!modelSubgraphById.get(candidate.id)?.scopePath.includes(cluster.id)) continue;
      candidate.x += dx;
      candidate.y += dy;
    }
  }
}

export function refitClustersToContents(
  clusters: GraphLayoutCluster[],
  nodes: Record<string, GraphLayoutRect>,
  modelNodes: FlowGraph["nodes"],
  overlay?: DiagramOverlay | null,
): GraphLayoutCluster[] {
  const next = clusters.map((cluster) => ({ ...cluster }));
  const scopeByNodeId = new Map(modelNodes.map((node) => [node.id, node.scopePath]));
  for (const cluster of [...next].sort((left, right) => right.depth - left.depth)) {
    // 用户手动拉过的分区尺寸(overlay)是下限之一:分区可以比内容大,但绝不会小于内容包络,
    // 收缩时不会把已有子节点吞掉。
    const sized = overlay?.styles?.[cluster.id];
    const overlayWidth = typeof sized?.width === "number" && Number.isFinite(sized.width) ? sized.width : 0;
    const overlayHeight = typeof sized?.height === "number" && Number.isFinite(sized.height) ? sized.height : 0;
    const directNodes = Object.entries(nodes)
      .filter(([nodeId]) => scopeByNodeId.get(nodeId)?.includes(cluster.id))
      .map(([, rect]) => rect);
    const childClusters = next.filter((candidate) => candidate.scopePath[candidate.scopePath.length - 1] === cluster.id);
    const contents = [...directNodes, ...childClusters];
    if (contents.length === 0) {
      if (overlayWidth > 0) cluster.width = Math.max(cluster.width, overlayWidth);
      if (overlayHeight > 0) cluster.height = Math.max(cluster.height, overlayHeight);
      continue;
    }
    const minX = Math.min(...contents.map((rect) => rect.x));
    const minY = Math.min(...contents.map((rect) => rect.y));
    const maxX = Math.max(...contents.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...contents.map((rect) => rect.y + rect.height));
    cluster.x = minX - GRAPH_CLUSTER_SIDE_PADDING;
    cluster.y = minY - GRAPH_CLUSTER_TITLE_HEIGHT;
    cluster.width = Math.max(
      GRAPH_LAYOUT_NODE_WIDTH + GRAPH_CLUSTER_SIDE_PADDING * 2,
      maxX - minX + GRAPH_CLUSTER_SIDE_PADDING * 2,
      overlayWidth,
    );
    cluster.height = Math.max(
      GRAPH_LAYOUT_NODE_HEIGHT + GRAPH_CLUSTER_TITLE_HEIGHT + GRAPH_CLUSTER_BOTTOM_PADDING,
      maxY - minY + GRAPH_CLUSTER_TITLE_HEIGHT + GRAPH_CLUSTER_BOTTOM_PADDING,
      overlayHeight,
    );
  }
  return next;
}

export function svgDefs(themePalette: ThemePalette | undefined): string {
  const lineColor = sanitizeColor(themePalette?.lineColor) ?? "#8d7447";
  return `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="${lineColor}"/></marker><marker id="circle-edge" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth"><circle cx="5" cy="5" r="3.2" fill="#faf6ec" stroke="${lineColor}" stroke-width="1.5"/></marker><marker id="cross-edge" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M2 2 L8 8 M8 2 L2 8" stroke="${lineColor}" stroke-width="1.8"/></marker></defs>`;
}

export const SVG_NODE_WIDTH = GRAPH_LAYOUT_NODE_WIDTH;

export const SVG_NODE_HEIGHT = GRAPH_LAYOUT_NODE_HEIGHT;

export const SVG_PADDING = 32;

// 导出会在无网络的 server Chromium 中直接绘制 SVG。VPS 的 fonts-noto-cjk 注册名是
// "Noto * CJK SC"，并不提供 "Noto Serif SC" / "Songti SC"；旧字体栈最终落到缺少中文
// 字形的 generic serif，PDF 与 PNG 只剩框线。与 generateSvg 已验证路径一致，交给系统
// sans-serif 做平台字体回退；作为 presentation attribute 内联到每个 text，不依赖宿主 CSS。
export const SVG_TEXT_FONT_FAMILY = "sans-serif";

export type SvgBounds = { minX: number; minY: number; maxX: number; maxY: number };

export function textWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, char) => width + (/[\u0000-\u00ff]/.test(char) ? fontSize * (char === " " ? 0.35 : 0.62) : fontSize), 0);
}

export function wrapNodeLabel(label: string, fontSize: number, nodeWidth = SVG_NODE_WIDTH): string[] {
  const maxWidth = Math.max(32, nodeWidth - 16);
  const lines: string[] = [];
  let line = "";
  for (const char of Array.from(label)) {
    if (char === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    if (line && textWidth(line + char, fontSize) > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  }
  lines.push(line);
  if (lines.length <= 2) return lines;
  let last = lines[1] ?? "";
  while (last && textWidth(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1);
  return [lines[0] ?? "", `${last}…`];
}

export function edgeGeometry(from: GraphLayoutRect, to: GraphLayoutRect) {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const start = rectBoundaryPoint(from, toCenter);
  const end = rectBoundaryPoint(to, fromCenter);
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const mainDistance = horizontal ? end.x - start.x : end.y - start.y;
  const bend = Math.max(36, Math.abs(mainDistance) * 0.45) * Math.sign(mainDistance || 1);
  return {
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    c1x: horizontal ? start.x + bend : start.x,
    c1y: horizontal ? start.y : start.y + bend,
    c2x: horizontal ? end.x - bend : end.x,
    c2y: horizontal ? end.y : end.y - bend,
    horizontal,
  };
}

export function rectBoundaryPoint(rect: GraphLayoutRect, toward: { x: number; y: number }): { x: number; y: number } {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: rect.y + rect.height };
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.width / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.height / 2) / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

export function graphSvgBounds(
  nodes: BaseNode[],
  edges: BaseEdge[],
  layout: DiagramGraphLayout,
  endpointRects: Record<string, GraphLayoutRect>,
  overlay: DiagramOverlay | null | undefined,
): { minX: number; minY: number; width: number; height: number } {
  const bounds: SvgBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (minX: number, minY: number, maxX: number, maxY: number) => {
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minY = Math.min(bounds.minY, minY);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxY = Math.max(bounds.maxY, maxY);
  };
  for (const cluster of layout.clusters) {
    include(cluster.x, cluster.y, cluster.x + cluster.width, cluster.y + cluster.height);
  }
  for (const node of nodes) {
    const pos = layout.nodes[node.id]!;
    const stroke = typeof overlay?.styles?.[node.id]?.strokeWidth === "number" ? Math.max(1, Math.min(8, overlay.styles[node.id]!.strokeWidth!)) : 1.5;
    include(pos.x - stroke / 2, pos.y - stroke / 2, pos.x + pos.width + stroke / 2, pos.y + pos.height + stroke / 2);
  }
  for (const edge of edges) {
    const from = endpointRects[edge.source];
    const to = endpointRects[edge.target];
    if (!from || !to) continue;
    const path = edgeGeometry(from, to);
    include(
      Math.min(path.x1, path.x2, path.c1x, path.c2x),
      Math.min(path.y1, path.y2, path.c1y, path.c2y),
      Math.max(path.x1, path.x2, path.c1x, path.c2x),
      Math.max(path.y1, path.y2, path.c1y, path.c2y),
    );
    if (edge.label) {
      const centerX = (path.x1 + path.x2) / 2;
      const baseline = (path.y1 + path.y2) / 2 - 6;
      const halfWidth = textWidth(edge.label, 12) / 2;
      include(centerX - halfWidth, baseline - 12, centerX + halfWidth, baseline + 3);
    }
  }
  let minX = bounds.minX - SVG_PADDING;
  let minY = bounds.minY - SVG_PADDING;
  let width = bounds.maxX - bounds.minX + SVG_PADDING * 2;
  let height = bounds.maxY - bounds.minY + SVG_PADDING * 2;
  if (width < 420) {
    minX -= (420 - width) / 2;
    width = 420;
  }
  if (height < 240) {
    minY -= (240 - height) / 2;
    height = 240;
  }
  return { minX: Math.floor(minX), minY: Math.floor(minY), width: Math.ceil(width), height: Math.ceil(height) };
}

export function renderSvgNode(
  node: BaseNode,
  pos: GraphLayoutRect,
  themePalette: ThemePalette | undefined,
  sourceStyle: NodeStyleOverride | undefined,
  overlayStyle: NodeStyleOverride | undefined,
): string {
  const fill = sanitizeColor(overlayStyle?.fill) ?? sanitizeColor(sourceStyle?.fill) ?? sanitizeColor(themePalette?.nodeFill) ?? "#efe3cc";
  const stroke = sanitizeColor(overlayStyle?.stroke) ?? sanitizeColor(sourceStyle?.stroke) ?? sanitizeColor(themePalette?.nodeStroke) ?? "#b08a3e";
  const textColor = sanitizeColor(overlayStyle?.textColor) ?? sanitizeColor(sourceStyle?.textColor) ?? sanitizeColor(themePalette?.textColor) ?? "#2f2a22";
  const strokeWidthSource = overlayStyle?.strokeWidth ?? sourceStyle?.strokeWidth;
  const strokeWidth = typeof strokeWidthSource === "number" ? Math.max(1, Math.min(8, strokeWidthSource)) : 1.5;
  const fontSizeSource = overlayStyle?.fontSize ?? sourceStyle?.fontSize ?? themePalette?.fontSize;
  const fontSize = typeof fontSizeSource === "number" ? Math.max(9, Math.min(28, fontSizeSource)) : 14;
  const lines = wrapNodeLabel(node.label, fontSize, pos.width);
  const lineHeight = Math.max(16, Math.round(fontSize * 1.3));
  const firstBaseline = pos.y + pos.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.36;
  const text = lines.map((line, index) => `<tspan x="${pos.x + pos.width / 2}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`).join("");
  const geometry = getFlowShapeGeometry((node as BaseNode & { shape?: string }).shape);
  const normalizedShape = normalizeFlowShapeName((node as BaseNode & { shape?: string }).shape);
  const dashArray = overlayStyle?.dashArray ?? sourceStyle?.dashArray;
  const rx = overlayStyle?.rx ?? sourceStyle?.rx;
  const ry = overlayStyle?.ry ?? sourceStyle?.ry;
  const layoutAttributes = ` data-layout-x="${pos.x}" data-layout-y="${pos.y}" data-layout-width="${pos.width}" data-layout-height="${pos.height}"`;
  const shape = normalizedShape === "rect"
    ? `<rect x="${pos.x}" y="${pos.y}" width="${pos.width}" height="${pos.height}"${typeof rx === "number" ? ` rx="${rx}"` : ""}${typeof ry === "number" ? ` ry="${ry}"` : ""} fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${layoutAttributes}${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}/>`
    : `<g transform="translate(${pos.x} ${pos.y}) scale(${pos.width / SVG_NODE_WIDTH} ${pos.height / SVG_NODE_HEIGHT})"${layoutAttributes}><path d="${geometry.outlinePath}" fill="${geometry.open ? "none" : fill}" stroke="${geometry.outlineVisible === false ? "none" : stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}/>${geometry.detailPaths.map((path) => `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/>`).join("")}</g>`;
  return `<g data-node-id="${escapeXml(node.id)}">${shape}<text text-anchor="middle" font-size="${fontSize}" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${text}</text></g>`;
}

export function renderSvgEdge(
  edge: BaseEdge,
  from: GraphLayoutRect,
  to: GraphLayoutRect,
  themePalette: ThemePalette | undefined,
  style: EdgeStyleOverride | undefined,
): string {
  const stroke = sanitizeColor(style?.stroke) ?? sanitizeColor(themePalette?.lineColor) ?? "#8d7447";
  const textColor = sanitizeColor(style?.textColor) ?? sanitizeColor(themePalette?.textColor) ?? "#5c5346";
  const strokeWidth = typeof style?.strokeWidth === "number"
    ? Math.max(1, Math.min(8, style.strokeWidth))
    : edge.lineStyle === "thick" ? 2.8 : 1.4;
  const { x1, y1, x2, y2, c1x, c1y, c2x, c2y, horizontal } = edgeGeometry(from, to);
  const curve = style?.curve;
  const pathData = curve === "linear"
    ? `M${x1} ${y1} L${x2} ${y2}`
    : curve?.startsWith("step")
      ? horizontal
        ? `M${x1} ${y1} L${(x1 + x2) / 2} ${y1} L${(x1 + x2) / 2} ${y2} L${x2} ${y2}`
        : `M${x1} ${y1} L${x1} ${(y1 + y2) / 2} L${x2} ${(y1 + y2) / 2} L${x2} ${y2}`
      : `M${x1} ${y1} C${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
  const invisible = edge.lineStyle === "invisible";
  const labelX = (x1 + x2) / 2;
  const labelY = (y1 + y2) / 2 - 6;
  const label = edge.label && !invisible
    ? `${themePalette?.edgeLabelBackground ? `<rect x="${labelX - textWidth(edge.label, 12) / 2 - 5}" y="${labelY - 12}" width="${textWidth(edge.label, 12) + 10}" height="17" fill="${themePalette.edgeLabelBackground}"/>` : ""}<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="12" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${escapeXml(edge.label)}</text>`
    : "";
  const sourceMarker = edge.sourceMarker ?? (edge.direction === "backward" || edge.direction === "both" ? "arrow" : "none");
  const targetMarker = edge.targetMarker ?? (edge.direction === "forward" || edge.direction === "both" || edge.direction === undefined ? "arrow" : "none");
  const markerUrl = (marker: EdgeMarkerKind) => marker === "arrow" ? "url(#arrow)" : marker === "circle" ? "url(#circle-edge)" : marker === "cross" ? "url(#cross-edge)" : null;
  const markerStart = markerUrl(sourceMarker);
  const markerEnd = markerUrl(targetMarker);
  const dashArray = style?.dashArray ?? (edge.lineStyle === "dotted" ? "4 6" : undefined);
  return `<g data-edge-id="${escapeXml(edge.id)}" data-line-style="${edge.lineStyle ?? "solid"}"><path d="${pathData}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}${markerStart && !invisible ? ` marker-start="${markerStart}"` : ""}${markerEnd && !invisible ? ` marker-end="${markerEnd}"` : ""}${invisible ? ' visibility="hidden"' : ""}/>${label}</g>`;
}

export function renderSvgCluster(
  cluster: GraphLayoutCluster,
  themePalette: ThemePalette | undefined,
  style: NodeStyleOverride | undefined,
): string {
  const fill = sanitizeColor(style?.fill) ?? sanitizeColor(themePalette?.clusterFill) ?? "#f3ecdd";
  const stroke = sanitizeColor(style?.stroke) ?? sanitizeColor(themePalette?.clusterStroke) ?? "#cdbfa3";
  const text = sanitizeColor(style?.textColor) ?? sanitizeColor(themePalette?.textColor) ?? "#2f2a22";
  const strokeWidth = typeof style?.strokeWidth === "number"
    ? Math.max(1, Math.min(8, style.strokeWidth))
    : 1.5;
  const dashArray = style?.dashArray;
  const emptyHint = cluster.empty
    ? `<text x="${cluster.x + cluster.width / 2}" y="${cluster.y + cluster.height / 2 + 12}" text-anchor="middle" font-size="12" fill="${text}" fill-opacity="0.58" font-family="${SVG_TEXT_FONT_FAMILY}">拖入节点</text>`
    : "";
  return `<g data-cluster-id="${escapeXml(cluster.id)}" data-layout-x="${cluster.x}" data-layout-y="${cluster.y}" data-layout-width="${cluster.width}" data-layout-height="${cluster.height}" data-direction="${cluster.direction}" data-empty="${cluster.empty}"><rect x="${cluster.x}" y="${cluster.y}" width="${cluster.width}" height="${cluster.height}" fill="${fill}" fill-opacity="0.72" stroke="${stroke}" stroke-width="${strokeWidth}"${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : cluster.empty ? ' stroke-dasharray="6 5"' : ""}/><text x="${cluster.x + cluster.width / 2}" y="${cluster.y + 27}" text-anchor="middle" font-size="14" font-weight="600" fill="${text}" font-family="${SVG_TEXT_FONT_FAMILY}">${escapeXml(cluster.label)}</text>${emptyHint}</g>`;
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
