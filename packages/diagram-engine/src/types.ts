export type DiagramType = "flowchart" | "state" | "er" | "class" | "mindmap";

export interface Span {
  start: number;
  end: number;
}

export interface BaseNode {
  id: string;
  label: string;
  declared: boolean;
  implicit?: boolean;
  hasStableId: boolean;
  scopePath: string[];
  style?: Record<string, string>;
  sourceRefs: Span[];
  labelSpan?: Span;
}

export interface BaseEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  labelSpan?: Span;
  syntaxKind: string;
  syntaxSpan?: Span;
  direction?: EdgeDirection;
  lineStyle?: EdgeLineStyle;
  sourceMarker?: EdgeMarkerKind;
  targetMarker?: EdgeMarkerKind;
  minLength?: number;
  orderIndex: number;
  cardinality?: string;
  scopePath: string[];
  rewritable: boolean;
  stmt: Span;
}

export type EdgeDirection = "forward" | "backward" | "both" | "none";

export type EdgeLineStyle = "solid" | "dotted" | "thick" | "invisible";

export type EdgeMarkerKind = "arrow" | "circle" | "cross" | "none";

export interface ThemePalette {
  canvasBackground?: string;
  nodeFill?: string;
  nodeStroke?: string;
  lineColor?: string;
  edgeLabelBackground?: string;
  textColor?: string;
  clusterFill?: string;
  clusterStroke?: string;
  fontSize?: number;
}

export interface DiagramThemeMetadata {
  themePalette?: ThemePalette;
  perNodeStyles?: Record<string, NodeStyleOverride>;
  perSubgraphStyles?: Record<string, NodeStyleOverride>;
  perEdgeStyles?: Record<string, EdgeStyleOverride>;
}

export type FlowNodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "doublecircle"
  | "subroutine"
  | "cylinder"
  | "asymmetric"
  | "hexagon"
  | "parallelogram"
  | "parallelogram-alt"
  | "trapezoid"
  | "trapezoid-alt"
  | "bang"
  | "notch-rect"
  | "cloud"
  | "hourglass"
  | "bolt"
  | "brace"
  | "brace-r"
  | "braces"
  | "datastore"
  | "delay"
  | "h-cyl"
  | "lin-cyl"
  | "curv-trap"
  | "div-rect"
  | "doc"
  | "tri"
  | "fork"
  | "win-pane"
  | "f-circ"
  | "lin-doc"
  | "lin-rect"
  | "notch-pent"
  | "flip-tri"
  | "sl-rect"
  | "docs"
  | "st-rect"
  | "odd"
  | "flag"
  | "sm-circ"
  | "fr-circ"
  | "bow-rect"
  | "cross-circ"
  | "tag-doc"
  | "tag-rect"
  | "text";

export interface FlowSubgraph {
  id: string;
  label: string;
  span: Span;
  scopePath: string[];
  direction?: string;
}

export interface FlowGraph extends DiagramThemeMetadata {
  type: "flowchart";
  direction: string;
  nodes: (BaseNode & { shape?: string; shapeOpenSpan?: Span; shapeCloseSpan?: Span })[];
  edges: BaseEdge[];
  subgraphs: FlowSubgraph[];
  hasLinkStyle?: boolean;
  unclosedSubgraphCount?: number;
}

export interface StateGraph extends DiagramThemeMetadata {
  type: "state";
  nodes: (BaseNode & { kind: "state" | "start" | "end" | "choice" | "fork" | "composite" })[];
  edges: BaseEdge[];
  deleteProtectedNodeIds?: string[];
}

export interface ErGraph extends DiagramThemeMetadata {
  type: "er";
  entities: (BaseNode & { attrs: { type: string; name: string; keys?: string[]; span: Span }[] })[];
  rels: (BaseEdge & { leftCard: string; rightCard: string })[];
}

export interface ClassGraph extends DiagramThemeMetadata {
  type: "class";
  classes: (BaseNode & { members: { raw: string; span: Span }[]; generics?: string })[];
  rels: (BaseEdge & { relKind: string })[];
  deleteProtectedNodeIds?: string[];
}

export interface MindmapTree extends DiagramThemeMetadata {
  type: "mindmap";
  root: MindNode;
}

export interface MindNode {
  id: string;
  label: string;
  line: Span;
  indent: number;
  children: MindNode[];
  hasStableId: boolean;
  parentId: string | null;
  scopePath: string[];
  sourceRefs: Span[];
}

export type DiagramModel = FlowGraph | StateGraph | ErGraph | ClassGraph | MindmapTree;

export interface SpanMap {
  directives: Span[];
  protectedSpans: Span[];
}

export interface ParseResult extends DiagramThemeMetadata {
  model: DiagramModel;
  spanMap: SpanMap;
  ok: boolean;
  /** 内部图模型是否完整承载了源码的可见语义；false 时应回退原生 Mermaid 渲染。 */
  fullyRepresented: boolean;
  error?: string;
  errorSpan?: Span;
}

export type EditOp =
  | { kind: "connectEdge"; source: string; target: string; label?: string }
  | { kind: "deleteEdge"; edgeId: string }
  | { kind: "reconnectEdge"; edgeId: string; newSource?: string; newTarget?: string }
  | { kind: "setEdgeLabel"; edgeId: string; label: string }
  | { kind: "setEdgeArrow"; edgeId: string; direction: EdgeDirection; lineStyle?: EdgeLineStyle }
  | { kind: "addNode"; label: string; parentId?: string }
  | { kind: "deleteNode"; nodeId: string }
  | { kind: "relabelNode"; nodeId: string; label: string }
  | { kind: "setNodeShape"; nodeId: string; shape: FlowNodeShape }
  | { kind: "moveNode"; nodeId: string; newParentId: string };

export type Capability = { op: EditOp["kind"]; enabled: boolean; reason?: string };

export interface ElementIdMap {
  nodes?: Record<string, string>;
  edges?: Record<string, string>;
}

export interface RewriteResult {
  source: string;
  newNodeId?: string;
  newSubgraphId?: string;
  idMap?: ElementIdMap;
  ok: boolean;
  error?: string;
}

export interface NodeStyleOverride {
  fill?: string;
  stroke?: string;
  textColor?: string;
  strokeWidth?: number;
  fontSize?: number;
  rx?: number;
  ry?: number;
  dashArray?: string;
  width?: number;
  height?: number;
}

export interface EdgeStyleOverride {
  stroke?: string;
  textColor?: string;
  strokeWidth?: number;
  dashArray?: string;
  curve?: string;
}

export interface EdgeHandleOverride {
  sourceHandle?: string;
  targetHandle?: string;
}

export interface DiagramOverlay {
  positions?: Record<string, { x: number; y: number }>;
  styles?: Record<string, NodeStyleOverride>;
  edgeStyles?: Record<string, EdgeStyleOverride>;
  edgeHandles?: Record<string, EdgeHandleOverride>;
  /** 元素层级(越大越靠上)。Mermaid 没有 z 语义,只存视觉层。 */
  zOrders?: Record<string, number>;
}

/** 层级重排的四种动作(与画布右键/溢出菜单一一对应)。 */
export type ZOrderCommand = "raise" | "lower" | "front" | "back";

/**
 * 计算层级重排后的 zOrders。语义:
 * - 只在"可排序元素"之间比较(分区始终垫在节点之下,由渲染层保证,不进这套序);
 * - 上/下移一层 = 与相邻一层交换;移到顶/底层 = 排到序列两端;
 * - 多选按同向整体移动,保持它们彼此的相对次序;
 * - 返回结果只保留与默认次序不同的项,overlay 不堆无意义数据。
 */
export function applyZOrderCommand(input: {
  order: string[];
  selected: string[];
  command: ZOrderCommand;
  zOrders?: Record<string, number> | undefined;
}): Record<string, number> {
  const base = [...input.order].sort(
    (left, right) => zOrderValue(input.zOrders, input.order, left) - zOrderValue(input.zOrders, input.order, right),
  );
  const selected = new Set(input.selected.filter((id) => base.includes(id)));
  if (selected.size === 0) return { ...(input.zOrders ?? {}) };
  const moving = base.filter((id) => selected.has(id));
  const rest = base.filter((id) => !selected.has(id));
  let next: string[];
  if (input.command === "front") {
    next = [...rest, ...moving];
  } else if (input.command === "back") {
    next = [...moving, ...rest];
  } else {
    next = [...base];
    const step = input.command === "raise" ? 1 : -1;
    // 上移从后往前处理、下移从前往后处理,避免同一批元素互相顶掉。
    const indexes = base
      .map((id, index) => ({ id, index }))
      .filter((item) => selected.has(item.id))
      .sort((left, right) => (step > 0 ? right.index - left.index : left.index - right.index));
    for (const item of indexes) {
      const from = next.indexOf(item.id);
      const to = from + step;
      if (to < 0 || to >= next.length) continue;
      if (selected.has(next[to]!)) continue; // 同批元素之间不互换
      const swapped = next[to]!;
      next[to] = item.id;
      next[from] = swapped;
    }
  }
  const result: Record<string, number> = {};
  next.forEach((id, index) => {
    if (input.order[index] !== id) result[id] = index;
  });
  // 一旦有元素排序变了,整串都要落下来,否则默认次序会把它顶回去。
  if (Object.keys(result).length > 0) {
    next.forEach((id, index) => {
      result[id] = index;
    });
  }
  return result;
}

export function zOrderValue(
  zOrders: Record<string, number> | undefined,
  order: string[],
  id: string,
): number {
  const explicit = zOrders?.[id];
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return order.indexOf(id);
}

/** 按层级排序一组元素 id(默认次序 = 传入次序)。 */
export function sortIdsByZOrder(order: string[], zOrders?: Record<string, number> | undefined): string[] {
  return [...order].sort(
    (left, right) => zOrderValue(zOrders, order, left) - zOrderValue(zOrders, order, right),
  );
}

export interface GraphLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayoutCluster extends GraphLayoutRect {
  id: string;
  label: string;
  scopePath: string[];
  direction: string;
  depth: number;
  empty: boolean;
}

export interface DiagramGraphLayout {
  nodes: Record<string, GraphLayoutRect>;
  clusters: GraphLayoutCluster[];
}

export interface FlowShapeGeometry {
  outlinePath: string;
  detailPaths: string[];
  open?: boolean;
  outlineVisible?: boolean;
}

export interface DiagramAdapter {
  type: DiagramType;
  detect(source: string): boolean;
  parse(source: string): ParseResult;
  capabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[];
  rewrite(source: string, p: ParseResult, op: EditOp): RewriteResult;
}
