import { countGraphemes, truncateGraphemes } from "@qingagent/contract-ts";

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
  nodeFill?: string;
  nodeStroke?: string;
  lineColor?: string;
  textColor?: string;
  clusterFill?: string;
  clusterStroke?: string;
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

function zOrderValue(
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

type LineInfo = {
  text: string;
  start: number;
  end: number;
  bodyEnd: number;
  index: number;
  startsLine?: boolean;
  separator?: "\n" | ";";
};

type Edit = { start: number; end: number; text: string };
type EdgeIdInput = { source: string; target: string; syntaxKind: string; label?: string };
type EdgeIdFactory = (input: EdgeIdInput) => string;

// 注意:`<---`/`<===` 必须排在 `<--`/`<==` 之前,否则会被短 token 先吃掉。
// 反向实线/粗线带 `|label|` 时,Mermaid 11 只接受 3 段长形(`<---`/`<===`),
// 短形 `<--|x|`/`<==|x|` 直接解析失败(已实测),故反向回写一律用长形(见 flowArrowToken)。
const FLOW_ARROW_TOKEN_RE = /(?:<-.->|<-->|<==>|<---|<===|<-.-|<==|<--|-.->|==>|---|-.-|===|-->)/g;
const MERMAID_ID_SOURCE = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_-]*`;
const MAX_MERMAID_ID_GRAPHEMES = 64;
const MERMAID_ID_LIST_SOURCE = String.raw`${MERMAID_ID_SOURCE}(?:\s*,\s*${MERMAID_ID_SOURCE})*`;
const MERMAID_ID_RE = new RegExp(String.raw`^${MERMAID_ID_SOURCE}$`, "u");
const FLOW_NODE_REF_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})(.*)$`, "u");
const FLOW_SUBGRAPH_DECLARATION_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})\s*\[\s*(.*?)\s*\]\s*$`, "u");
const CLASS_DEFINITION_RE = new RegExp(String.raw`^classDef\s+(${MERMAID_ID_LIST_SOURCE})\s+(.+?)\s*;?$`, "iu");
const CLASS_ASSIGNMENT_RE = new RegExp(String.raw`^class\s+(${MERMAID_ID_LIST_SOURCE})\s+(${MERMAID_ID_SOURCE})\s*;?$`, "iu");
const INLINE_STYLE_RE = new RegExp(String.raw`^style\s+(${MERMAID_ID_SOURCE})\s+(.+?)\s*;?$`, "iu");
const INLINE_CLASS_RE = new RegExp(String.raw`:::(${MERMAID_ID_SOURCE})`, "gu");
const FLOW_EDGE_ID_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})@`, "u");
const MERMAID_ID_PREFIX_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})`, "u");

const EDGE_OPS: EditOp["kind"][] = ["connectEdge", "deleteEdge", "reconnectEdge", "setEdgeLabel", "setEdgeArrow"];
const NODE_OPS: EditOp["kind"][] = ["addNode", "deleteNode", "relabelNode", "setNodeShape"];
const MINDMAP_OPS: EditOp["kind"][] = ["addNode", "deleteNode", "relabelNode", "moveNode", "setNodeShape", "setEdgeLabel"];

export const registry: Record<DiagramType, DiagramAdapter> = {
  flowchart: makeFlowchartAdapter(),
  state: makeStateAdapter(),
  er: makeErAdapter(),
  class: makeClassAdapter(),
  mindmap: makeMindmapAdapter(),
};

export function detectType(source: string): DiagramType | null {
  for (const adapter of Object.values(registry)) {
    if (adapter.detect(source)) return adapter.type;
  }
  return null;
}

export function parseDiagram(source: string): ParseResult {
  const type = detectType(source);
  if (!type) {
    return emptyParse("flowchart", "不支持的 Mermaid 图类型");
  }
  return registry[type].parse(source);
}

export function getCapabilities(
  sourceOrParse: string | ParseResult,
  target?: { nodeId?: string; edgeId?: string },
): Capability[] {
  const parsed = typeof sourceOrParse === "string" ? parseDiagram(sourceOrParse) : sourceOrParse;
  return registry[parsed.model.type].capabilities(parsed, target);
}

export function applyEdit(source: string, op: EditOp): RewriteResult {
  const parsed = parseDiagram(source);
  if (!parsed.ok) return { ok: false, source, error: parsed.error ?? "图表解析失败" };
  if (parsed.model.type !== "flowchart") {
    return registry[parsed.model.type].rewrite(source, parsed, op);
  }
  const rewriteSource = completeOpenFlowSubgraphs(source, parsed.model);
  const rewriteParsed = rewriteSource === source ? parsed : parseFlowchart(rewriteSource);
  if (!rewriteParsed.ok || rewriteParsed.model.type !== "flowchart") {
    return { ok: false, source, error: rewriteParsed.error ?? "分区补全后无法重新解析" };
  }
  const result = registry.flowchart.rewrite(rewriteSource, rewriteParsed, op);
  const verified = verifyFlowSubgraphsPreserved(rewriteSource, result);
  return verified.ok || rewriteSource === source ? verified : { ...verified, source };
}

type PreparedFlowchartRewrite = {
  source: string;
  parsed: ParseResult & { model: FlowGraph };
};

function prepareFlowchartRewrite(source: string, operation: string): PreparedFlowchartRewrite | RewriteResult {
  const parsed = parseDiagram(source);
  if (!parsed.ok) return { ok: false, source, error: parsed.error ?? "图表解析失败" };
  if (parsed.model.type !== "flowchart") return unsupportedRewrite(source, operation);
  const rewriteSource = completeOpenFlowSubgraphs(source, parsed.model);
  const rewriteParsed = rewriteSource === source ? parsed : parseFlowchart(rewriteSource);
  if (!rewriteParsed.ok || rewriteParsed.model.type !== "flowchart") {
    return { ok: false, source, error: rewriteParsed.error ?? "分区补全后无法重新解析" };
  }
  return {
    source: rewriteSource,
    parsed: rewriteParsed as ParseResult & { model: FlowGraph },
  };
}

/**
 * 把指定 flowchart 节点包进新 subgraph。连续独立声明会原位包裹；其它情况只迁移节点声明，
 * 不重排边、注释、样式等无关源码。parentSubgraph 省略时在根级创建。
 */
export function wrapNodesInSubgraph(
  source: string,
  nodeIds: string[],
  title: string,
  parentSubgraph?: string | null,
): RewriteResult {
  const prepared = prepareFlowchartRewrite(source, "wrapNodesInSubgraph");
  if (!("parsed" in prepared)) return prepared;
  source = prepared.source;
  const parsed = prepared.parsed;
  const model = parsed.model;
  const nextTitle = title.trim();
  if (!nextTitle) return { ok: false, source, error: "分区名称不能为空" };
  const parent = parentSubgraph
    ? model.subgraphs.find((subgraph) => subgraph.id === parentSubgraph)
    : undefined;
  if (parentSubgraph && !parent) return { ok: false, source, error: "父分区不存在" };

  const uniqueNodeIds = [...new Set(nodeIds)];
  const selectedNodes = uniqueNodeIds.map((nodeId) => model.nodes.find((node) => node.id === nodeId));
  if (selectedNodes.some((node) => !node)) return { ok: false, source, error: "待包裹节点不存在" };
  const expectedParentPath = parent ? [...parent.scopePath, parent.id] : [];
  if (selectedNodes.some((node) => !samePath(node!.scopePath, expectedParentPath))) {
    return { ok: false, source, error: "节点不在同一父分区内" };
  }

  const reservedIds = [...model.nodes.map((node) => node.id), ...model.subgraphs.map((subgraph) => subgraph.id)];
  const newSubgraphId = uniqueId(reservedIds, safeMermaidId(nextTitle, "subgraph"));
  const lineEnding = preferredLineEnding(source);
  const wrapperIndent = flowScopeContentIndent(source, model, parent);
  const inlineRange = findInlineSubgraphWrapRange(source, selectedNodes as FlowGraph["nodes"], uniqueNodeIds);
  if (inlineRange) {
    const header = `${wrapperIndent}subgraph ${newSubgraphId}["${safeMermaidLabel(nextTitle)}"]${lineEnding}`;
    const footerPrefix = inlineRange.endsWithLineBreak ? "" : lineEnding;
    const footer = `${footerPrefix}${wrapperIndent}end${inlineRange.endsWithLineBreak ? lineEnding : ""}`;
    const nextSource = applyEdits(source, [
      { start: inlineRange.start, end: inlineRange.start, text: header },
      { start: inlineRange.end, end: inlineRange.end, text: footer },
    ]);
    return verifyFlowSubgraphRewrite(source, nextSource, {
      subgraphId: newSubgraphId,
      nodeIds: uniqueNodeIds,
      expectedScopePath: [...expectedParentPath, newSubgraphId],
      newSubgraphId,
    });
  }

  const relocation = collectFlowNodeRelocation(source, selectedNodes as FlowGraph["nodes"]);
  if (!relocation.ok) return { ok: false, source, error: relocation.error };
  const insertionAt = parent ? flowSubgraphClosingLine(source, parent)?.start : source.length;
  if (insertionAt === undefined) return { ok: false, source, error: "父分区结束位置不可定位" };
  const declarationIndent = `${wrapperIndent}  `;
  const block = [
    `${wrapperIndent}subgraph ${newSubgraphId}["${safeMermaidLabel(nextTitle)}"]`,
    ...relocation.declarations.map((declaration) => `${declarationIndent}${declaration}`),
    `${wrapperIndent}end`,
  ].join(lineEnding) + lineEnding;
  const nextSource = applyEdits(source, [
    ...relocation.edits,
    { start: insertionAt, end: insertionAt, text: sourceInsertionPrefix(source, insertionAt) + block },
  ]);
  return verifyFlowSubgraphRewrite(source, nextSource, {
    subgraphId: newSubgraphId,
    nodeIds: uniqueNodeIds,
    expectedScopePath: [...expectedParentPath, newSubgraphId],
    newSubgraphId,
  });
}

/** 把 flowchart 节点迁入目标 subgraph；targetSubgraph=null 表示迁回根级。 */
export function moveNodeToSubgraph(
  source: string,
  nodeId: string,
  targetSubgraph: string | null,
): RewriteResult {
  const prepared = prepareFlowchartRewrite(source, "moveNodeToSubgraph");
  if (!("parsed" in prepared)) return prepared;
  source = prepared.source;
  const parsed = prepared.parsed;
  const model = parsed.model;
  const node = model.nodes.find((item) => item.id === nodeId);
  if (!node) return { ok: false, source, error: "节点不存在" };
  const target = targetSubgraph
    ? model.subgraphs.find((subgraph) => subgraph.id === targetSubgraph)
    : undefined;
  if (targetSubgraph && !target) return { ok: false, source, error: "目标分区不存在" };
  const expectedScopePath = target ? [...target.scopePath, target.id] : [];
  if (samePath(node.scopePath, expectedScopePath)) return { ok: true, source };

  const relocation = collectFlowNodeRelocation(source, [node]);
  if (!relocation.ok) return { ok: false, source, error: relocation.error };
  const insertionAt = target ? flowSubgraphClosingLine(source, target)?.start : source.length;
  if (insertionAt === undefined) return { ok: false, source, error: "目标分区结束位置不可定位" };
  const indent = flowScopeContentIndent(source, model, target);
  const lineEnding = preferredLineEnding(source);
  const declaration = relocation.declarations[0] ?? `${node.id}["${safeMermaidLabel(node.label)}"]`;
  const nextSource = applyEdits(source, [
    ...relocation.edits,
    {
      start: insertionAt,
      end: insertionAt,
      text: `${sourceInsertionPrefix(source, insertionAt)}${indent}${declaration}${lineEnding}`,
    },
  ]);
  return verifyFlowSubgraphRewrite(source, nextSource, {
    nodeIds: [nodeId],
    expectedScopePath,
  });
}

/** 只改 subgraph 声明行中的标题文本，稳定 id 保持不变。 */
export function renameSubgraph(source: string, subgraphId: string, title: string): RewriteResult {
  const prepared = prepareFlowchartRewrite(source, "renameSubgraph");
  if (!("parsed" in prepared)) return prepared;
  source = prepared.source;
  const parsed = prepared.parsed;
  const subgraph = parsed.model.subgraphs.find((item) => item.id === subgraphId);
  if (!subgraph) return { ok: false, source, error: "分区不存在" };
  const nextTitle = title.trim();
  if (!nextTitle) return { ok: false, source, error: "分区名称不能为空" };
  if (subgraph.label === nextTitle) return { ok: true, source };
  if (!isStableMermaidId(subgraph.id)) return { ok: false, source, error: "分区 id 不稳定，无法安全改名" };

  const declaration = flowSubgraphDeclarationLine(source, subgraph);
  if (!declaration) return { ok: false, source, error: "分区声明位置不可定位" };
  const labelSpan = flowSubgraphLabelSpan(declaration, subgraph.id);
  const nextSource = labelSpan
    ? applyEdits(source, [{ start: labelSpan.start, end: labelSpan.end, text: safeMermaidLabel(nextTitle) }])
    : applyEdits(source, [{
        start: declaration.bodyStart,
        end: declaration.bodyEnd,
        text: `${declaration.indent}subgraph ${subgraph.id}["${safeMermaidLabel(nextTitle)}"]`,
      }]);
  return verifyFlowSubgraphRewrite(source, nextSource, {
    subgraphId,
    expectedTitle: nextTitle,
  });
}

/**
 * 写回 flowchart 分区的 Mermaid `style` 语句。只开放填充与边框色，
 * 保留同一语句里已有的其它声明及行尾注释。
 */
export function setSubgraphStyle(
  source: string,
  subgraphId: string,
  patch: Pick<NodeStyleOverride, "fill" | "stroke">,
): RewriteResult {
  const prepared = prepareFlowchartRewrite(source, "setSubgraphStyle");
  if (!("parsed" in prepared)) return prepared;
  source = prepared.source;
  const parsed = prepared.parsed;
  if (!parsed.model.subgraphs.some((subgraph) => subgraph.id === subgraphId)) {
    return { ok: false, source, error: "分区不存在" };
  }
  if (!isStableMermaidId(subgraphId)) {
    return { ok: false, source, error: "分区 id 不稳定，无法安全改色" };
  }

  const normalizedPatch: Pick<NodeStyleOverride, "fill" | "stroke"> = {};
  if (patch.fill !== undefined) {
    const fill = sanitizeColor(patch.fill);
    if (!fill) return { ok: false, source, error: "分区填充色无效" };
    normalizedPatch.fill = fill;
  }
  if (patch.stroke !== undefined) {
    const stroke = sanitizeColor(patch.stroke);
    if (!stroke) return { ok: false, source, error: "分区边框色无效" };
    normalizedPatch.stroke = stroke;
  }
  if (Object.keys(normalizedPatch).length === 0) return { ok: true, source };

  const declarationsFor = (existing: string[] = []) => {
    const declarations = existing.filter((declaration) => {
      const property = declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();
      return !((normalizedPatch.fill !== undefined && property === "fill")
        || (normalizedPatch.stroke !== undefined && property === "stroke"));
    });
    if (normalizedPatch.fill !== undefined) declarations.push(`fill:${normalizedPatch.fill}`);
    if (normalizedPatch.stroke !== undefined) declarations.push(`stroke:${normalizedPatch.stroke}`);
    return declarations;
  };

  let nextSource = source;
  const existingLine = [...getLines(source)].reverse().find((line) => {
    const match = stripTrailingComment(line.text).trim().match(INLINE_STYLE_RE);
    return match?.[1] === subgraphId;
  });
  if (existingLine) {
    const statementSource = stripTrailingComment(existingLine.text);
    const match = statementSource.trim().match(INLINE_STYLE_RE)!;
    const indent = existingLine.text.match(/^\s*/)?.[0] ?? "";
    const suffix = existingLine.text.slice(statementSource.length);
    const suffixSeparator = suffix && !/^\s/.test(suffix) ? " " : "";
    const declarations = declarationsFor(splitStyleDeclarations(match[2]!));
    nextSource = applyEdits(source, [{
      start: existingLine.start,
      end: existingLine.bodyEnd,
      text: `${indent}style ${subgraphId} ${declarations.join(",")}${suffixSeparator}${suffix}`,
    }]);
  } else {
    const declarations = declarationsFor();
    nextSource = insertBeforeSourceEnd(source, `  style ${subgraphId} ${declarations.join(",")}\n`);
  }

  const verified = parseDiagram(nextSource);
  if (!verified.ok || verified.model.type !== "flowchart") {
    return { ok: false, source, error: verified.error ?? "分区样式写回后无法重新解析" };
  }
  const resolved = verified.model.perSubgraphStyles?.[subgraphId];
  if ((normalizedPatch.fill !== undefined && resolved?.fill !== normalizedPatch.fill)
    || (normalizedPatch.stroke !== undefined && resolved?.stroke !== normalizedPatch.stroke)) {
    return { ok: false, source, error: "分区样式写回校验失败" };
  }
  return { ok: true, source: nextSource };
}

/** 解散 subgraph，仅移除它自己的声明行和配对 end；节点/子分区自然回到父级。 */
export function dissolveSubgraph(source: string, subgraphId: string): RewriteResult {
  const prepared = prepareFlowchartRewrite(source, "dissolveSubgraph");
  if (!("parsed" in prepared)) return prepared;
  source = prepared.source;
  const parsed = prepared.parsed;
  const model = parsed.model;
  const subgraph = model.subgraphs.find((item) => item.id === subgraphId);
  if (!subgraph) return { ok: false, source, error: "分区不存在" };
  if (model.edges.some((edge) => edge.source === subgraphId || edge.target === subgraphId)) {
    return { ok: false, source, error: "分区仍被连线引用，无法安全解散" };
  }
  const declaration = flowSubgraphDeclarationLine(source, subgraph);
  const closing = flowSubgraphClosingLine(source, subgraph);
  if (!declaration || !closing) return { ok: false, source, error: "分区边界位置不可定位" };
  const expectedParentPath = subgraph.scopePath;
  const directNodeIds = model.nodes
    .filter((node) => samePath(node.scopePath, [...subgraph.scopePath, subgraph.id]))
    .map((node) => node.id);
  const nextSource = applyEdits(source, [
    { start: declaration.start, end: declaration.end, text: "" },
    { start: closing.start, end: closing.end, text: "" },
  ]);
  const verified = verifyFlowSubgraphRewrite(source, nextSource, {
    removedSubgraphId: subgraphId,
    nodeIds: directNodeIds,
    expectedScopePath: expectedParentPath,
  });
  return verified.ok ? verified : { ok: false, source, error: verified.error };
}

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

function compactOverlay(overlay: DiagramOverlay): DiagramOverlay | undefined {
  const compacted: DiagramOverlay = {
    ...(overlay.positions ? { positions: overlay.positions } : {}),
    ...(overlay.styles ? { styles: overlay.styles } : {}),
    ...(overlay.zOrders ? { zOrders: overlay.zOrders } : {}),
    ...(overlay.edgeStyles ? { edgeStyles: overlay.edgeStyles } : {}),
    ...(overlay.edgeHandles ? { edgeHandles: overlay.edgeHandles } : {}),
  };
  return emptyOverlay(compacted) ? undefined : compacted;
}

export function safeMermaidId(label: string, prefix = "n"): string {
  const normalized = label
    .trim()
    .replace(/["'`]/g, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  let id = normalized || prefix;
  if (!/^[A-Za-z_]/.test(id)) id = `${prefix}_${id}`;
  if (/^end$/i.test(id)) id = `${id}_node`;
  if (/^[ox]/i.test(id)) id = `${prefix}_${id}`;
  const truncated = truncateGraphemes(id, MAX_MERMAID_ID_GRAPHEMES);
  return isStableMermaidId(truncated) ? truncated : "n";
}

export function safeMermaidLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "<br>").trim();
}

export function safeMermaid(value: string): { id: string; label: string } {
  return { id: safeMermaidId(value), label: safeMermaidLabel(value) };
}

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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}" role="img">${svgDefs(parsed.model.themePalette)}<rect x="${bounds.minX}" y="${bounds.minY}" width="${bounds.width}" height="${bounds.height}" fill="#faf6ec"/>${clusterSvg}${edgeSvg}${nodeSvg}</svg>`;
}

function hasGraphSvgOverlay(overlay: DiagramOverlay | null | undefined): boolean {
  return !!overlay && (
    Object.keys(overlay.positions ?? {}).length > 0 ||
    Object.keys(overlay.styles ?? {}).length > 0 ||
    Object.keys(overlay.edgeStyles ?? {}).length > 0
  );
}

function makeFlowchartAdapter(): DiagramAdapter {
  return {
    type: "flowchart",
    detect: (source) => /^\s*(?:flowchart|graph)\s+/m.test(source),
    parse: parseFlowchart,
    capabilities: flowchartCapabilities,
    rewrite: rewriteFlowchart,
  };
}

function makeStateAdapter(): DiagramAdapter {
  return {
    type: "state",
    detect: (source) => /^\s*stateDiagram(?:-v2)?\b/m.test(source),
    parse: parseState,
    capabilities: stateCapabilities,
    rewrite: rewriteState,
  };
}

function makeErAdapter(): DiagramAdapter {
  return {
    type: "er",
    detect: (source) => /^\s*erDiagram\b/m.test(source),
    parse: parseEr,
    capabilities: erCapabilities,
    rewrite: rewriteEr,
  };
}

function makeClassAdapter(): DiagramAdapter {
  return {
    type: "class",
    detect: (source) => /^\s*classDiagram\b/m.test(source),
    parse: parseClass,
    capabilities: classCapabilities,
    rewrite: rewriteClass,
  };
}

function makeMindmapAdapter(): DiagramAdapter {
  return {
    type: "mindmap",
    detect: (source) => /^\s*mindmap\b/m.test(source),
    parse: parseMindmap,
    capabilities: mindmapCapabilities,
    rewrite: rewriteMindmap,
  };
}

function parseDiagramThemeMetadata(
  source: string,
  nodeIds: Iterable<string>,
  inlineNodeClasses: Map<string, string[]> = new Map(),
  edges: BaseEdge[] = [],
  subgraphIds: Iterable<string> = [],
): DiagramThemeMetadata {
  const themePalette = parseThemePalette(source);
  const { classDefinitions, nodeClasses, nodeStyles } = parseClassStyleStatements(source);
  for (const [nodeId, classNames] of inlineNodeClasses) {
    appendNodeClasses(nodeClasses, nodeId, classNames);
  }

  const perNodeStyles: Record<string, NodeStyleOverride> = {};
  for (const nodeId of nodeIds) {
    const assignedClassNames = nodeClasses.get(nodeId) ?? [];
    const classNames = classDefinitions.has("default") ? ["default", ...assignedClassNames] : assignedClassNames;
    const classStyle = classNames.reduce<NodeStyleOverride>((merged, className) => {
      const classStyle = classDefinitions.get(className);
      return classStyle ? { ...merged, ...classStyle } : merged;
    }, {});
    const style = { ...classStyle, ...(nodeStyles.get(nodeId) ?? {}) };
    if (Object.keys(style).length > 0) perNodeStyles[nodeId] = style;
  }
  const perEdgeStyles = parseLinkStyleStatements(source, edges);
  const perSubgraphStyles: Record<string, NodeStyleOverride> = {};
  for (const subgraphId of subgraphIds) {
    const assignedClassNames = nodeClasses.get(subgraphId) ?? [];
    const classNames = classDefinitions.has("default") ? ["default", ...assignedClassNames] : assignedClassNames;
    const classStyle = classNames.reduce<NodeStyleOverride>((merged, className) => {
      const classStyle = classDefinitions.get(className);
      return classStyle ? { ...merged, ...classStyle } : merged;
    }, {});
    const style = { ...classStyle, ...(nodeStyles.get(subgraphId) ?? {}) };
    if (Object.keys(style).length > 0) perSubgraphStyles[subgraphId] = style;
  }

  return {
    ...(themePalette ? { themePalette } : {}),
    ...(Object.keys(perNodeStyles).length > 0 ? { perNodeStyles } : {}),
    ...(Object.keys(perSubgraphStyles).length > 0 ? { perSubgraphStyles } : {}),
    ...(Object.keys(perEdgeStyles).length > 0 ? { perEdgeStyles } : {}),
  };
}

const REPRESENTED_THEME_VARIABLES = new Set([
  "clusterBkg",
  "clusterBorder",
  "lineColor",
  "mainBkg",
  "nodeBorder",
  "primaryBorderColor",
  "primaryColor",
  "primaryTextColor",
  "textColor",
]);
function objectKeysAtTopLevel(source: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/[\s,]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    let key = "";
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        key += source[index] ?? "";
        index += 1;
      }
      index += 1;
    } else {
      const match = source.slice(index).match(/^[\w-]+/);
      if (!match) return [];
      key = match[0];
      index += key.length;
    }
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== ":") return [];
    keys.push(key);
    index += 1;

    let braces = 0;
    let brackets = 0;
    let valueQuote: "'" | '"' | null = null;
    let escaped = false;
    while (index < source.length) {
      const char = source[index]!;
      if (valueQuote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === valueQuote) {
          valueQuote = null;
        }
      } else if (char === "'" || char === '"') {
        valueQuote = char;
      } else if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
      } else if (char === "[") {
        brackets += 1;
      } else if (char === "]") {
        brackets -= 1;
      } else if (char === "," && braces === 0 && brackets === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return keys;
}

type RepresentedStyleTarget = "node" | "edge";

function exactPixelValueInRange(
  source: string,
  min: number,
  max: number,
  integer = false,
): boolean {
  const match = source.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/i);
  if (!match) return false;
  const value = Number(match[1]);
  return (
    Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isInteger(value))
  );
}

function styleValueFullyRepresented(
  property: string,
  rawValue: string,
  target: RepresentedStyleTarget,
): boolean {
  const value = rawValue.trim().replace(/;$/, "");
  if (property === "color" || property === "stroke") {
    return sanitizeColor(value) !== null;
  }
  if (property === "stroke-dasharray") {
    return sanitizeDashArray(value) !== null;
  }
  if (property === "stroke-width") {
    return exactPixelValueInRange(value, 1, 8);
  }
  if (target === "edge") {
    // renderer 只分别实现直线和居中阶梯线；其余 Mermaid 曲线会被统一成
    // 同一条通用 Bézier，无法保真表达原始 curve 取值。
    return property === "curve" && (value === "linear" || value === "step");
  }
  if (property === "fill") return sanitizeColor(value) !== null;
  if (property === "font-size") return exactPixelValueInRange(value, 9, 28);
  if (property === "width") {
    return exactPixelValueInRange(
      value,
      GRAPH_LAYOUT_NODE_MIN_WIDTH,
      GRAPH_LAYOUT_NODE_MAX_WIDTH,
      true,
    );
  }
  if (property === "height") {
    return exactPixelValueInRange(
      value,
      GRAPH_LAYOUT_NODE_MIN_HEIGHT,
      GRAPH_LAYOUT_NODE_MAX_HEIGHT,
      true,
    );
  }
  return false;
}

function stylePropertiesFullyRepresented(
  source: string,
  target: RepresentedStyleTarget,
): boolean {
  const declarations = splitStyleDeclarations(source);
  if (declarations.length === 0) return false;
  return declarations.every((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon < 0) return false;
    return styleValueFullyRepresented(
      declaration.slice(0, colon).trim().toLowerCase(),
      declaration.slice(colon + 1),
      target,
    );
  });
}

function initDirectiveFullyRepresented(source: string): boolean {
  const initMatches = [...source.matchAll(/%%\{\s*init\s*:/gi)];
  if (initMatches.length === 0) return true;
  if (initMatches.length !== 1) return false;
  const initStart = initMatches[0]!;
  const payloadStart = initStart.index + initStart[0].length;
  const directiveEnd = /\}\s*%%/g;
  directiveEnd.lastIndex = payloadStart;
  const endMatch = directiveEnd.exec(source);
  if (!endMatch) return false;
  const payload = source.slice(payloadStart, endMatch.index);
  const objectStart = payload.indexOf("{");
  if (objectStart < 0) return false;
  const initBody = extractBalancedObjectBody(payload, objectStart);
  if (initBody === null) return false;
  const initKeys = objectKeysAtTopLevel(initBody);
  if (
    initKeys.length === 0 ||
    initKeys.some((key) => key !== "theme" && key !== "themeVariables")
  ) {
    return false;
  }
  const theme = readObjectValue(initBody, "theme");
  if (theme !== undefined && theme.toLowerCase() !== "base") return false;

  const themeVariablesKey =
    /(?:["']themeVariables["']|\bthemeVariables\b)\s*:/i.exec(initBody);
  if (!themeVariablesKey) return false;
  const variablesStart = initBody.indexOf(
    "{",
    themeVariablesKey.index + themeVariablesKey[0].length,
  );
  if (variablesStart < 0) return false;
  const variablesBody = extractBalancedObjectBody(initBody, variablesStart);
  if (variablesBody === null) return false;
  const variableKeys = objectKeysAtTopLevel(variablesBody);
  if (
    variableKeys.length === 0 ||
    variableKeys.some((key) => !REPRESENTED_THEME_VARIABLES.has(key)) ||
    variableKeys.some(
      (key) => !sanitizeColor(readObjectValue(variablesBody, key)),
    )
  ) {
    return false;
  }

  const palette = parseThemePalette(source);
  return !!(
    palette?.nodeFill &&
    palette.nodeStroke &&
    palette.lineColor &&
    palette.textColor &&
    palette.clusterFill &&
    palette.clusterStroke
  );
}

function presentationSyntaxFullyRepresented(source: string): boolean {
  if (!initDirectiveFullyRepresented(source)) return false;
  for (const line of getLines(source)) {
    const trimmed = stripTrailingComment(line.text).trim();
    const classDefinition = trimmed.match(CLASS_DEFINITION_RE);
    if (
      classDefinition &&
      !stylePropertiesFullyRepresented(
        classDefinition[2]!,
        "node",
      )
    ) {
      return false;
    }
    const inlineStyle = trimmed.match(INLINE_STYLE_RE);
    if (
      inlineStyle &&
      !stylePropertiesFullyRepresented(
        inlineStyle[2]!,
        "node",
      )
    ) {
      return false;
    }
    const linkStyle = trimmed.match(/^linkStyle\s+\S+\s+(.+?)\s*;?$/i);
    if (
      linkStyle &&
      !stylePropertiesFullyRepresented(
        linkStyle[1]!,
        "edge",
      )
    ) {
      return false;
    }
  }
  return true;
}

function parseThemePalette(source: string): ThemePalette | undefined {
  const initStart = /%%\{\s*init\s*:/i.exec(source);
  if (!initStart) return undefined;
  const payloadStart = initStart.index + initStart[0].length;
  const directiveEnd = /\}\s*%%/g;
  directiveEnd.lastIndex = payloadStart;
  const endMatch = directiveEnd.exec(source);
  if (!endMatch) return undefined;
  const payload = source.slice(payloadStart, endMatch.index);
  const themeVariablesKey = /(?:["']themeVariables["']|\bthemeVariables\b)\s*:/i.exec(payload);
  if (!themeVariablesKey) return undefined;
  const objectStart = payload.indexOf("{", themeVariablesKey.index + themeVariablesKey[0].length);
  if (objectStart < 0) return undefined;
  const themeVariables = extractBalancedObjectBody(payload, objectStart);
  if (themeVariables === null) return undefined;

  const readColor = (key: string) => sanitizeColor(readObjectValue(themeVariables, key));
  const palette: ThemePalette = {
    nodeFill: readColor("mainBkg") ?? readColor("primaryColor") ?? undefined,
    nodeStroke: readColor("nodeBorder") ?? readColor("primaryBorderColor") ?? undefined,
    lineColor: readColor("lineColor") ?? undefined,
    textColor: readColor("textColor") ?? readColor("primaryTextColor") ?? undefined,
    clusterFill: readColor("clusterBkg") ?? undefined,
    clusterStroke: readColor("clusterBorder") ?? undefined,
  };
  return Object.values(palette).some(Boolean) ? palette : undefined;
}

function extractBalancedObjectBody(source: string, objectStart: number): string | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(objectStart + 1, index);
  }
  return null;
}

function readObjectValue(source: string, key: string): string | undefined {
  const keyPattern = new RegExp(`(?:["']${key}["']|\\b${key}\\b)\\s*:`, "i");
  const match = keyPattern.exec(source);
  if (!match) return undefined;
  const valueSource = source.slice(match.index + match[0].length).trimStart();
  const quote = valueSource[0];
  if (quote === "'" || quote === '"') {
    let escaped = false;
    for (let index = 1; index < valueSource.length; index += 1) {
      const char = valueSource[index]!;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return valueSource.slice(1, index);
      }
    }
    return undefined;
  }
  return valueSource.split(/[,}]/, 1)[0]?.trim();
}

function parseClassStyleStatements(source: string): {
  classDefinitions: Map<string, NodeStyleOverride>;
  nodeClasses: Map<string, string[]>;
  nodeStyles: Map<string, NodeStyleOverride>;
} {
  const classDefinitions = new Map<string, NodeStyleOverride>();
  const nodeClasses = new Map<string, string[]>();
  const nodeStyles = new Map<string, NodeStyleOverride>();
  for (const line of getLines(source)) {
    const trimmed = stripTrailingComment(line.text).trim();
    const definition = trimmed.match(CLASS_DEFINITION_RE);
    if (definition) {
      const style = parseClassDefinitionStyle(definition[2]!);
      if (style) {
        for (const className of definition[1]!.split(",").map((value) => value.trim()).filter(Boolean)) {
          classDefinitions.set(className, style);
        }
      }
      continue;
    }
    const assignment = trimmed.match(CLASS_ASSIGNMENT_RE);
    if (assignment) {
      const className = assignment[2]!;
      for (const nodeId of assignment[1]!.split(",").map((value) => value.trim()).filter(Boolean)) {
        appendNodeClasses(nodeClasses, nodeId, [className]);
      }
      continue;
    }
    const inlineStyle = trimmed.match(INLINE_STYLE_RE);
    if (inlineStyle) {
      const style = parseClassDefinitionStyle(inlineStyle[2]!);
      if (style) nodeStyles.set(inlineStyle[1]!, { ...(nodeStyles.get(inlineStyle[1]!) ?? {}), ...style });
    }
  }
  return { classDefinitions, nodeClasses, nodeStyles };
}

function parseClassDefinitionStyle(source: string): NodeStyleOverride | undefined {
  const style: NodeStyleOverride = {};
  for (const declaration of splitStyleDeclarations(source)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim().replace(/;$/, "");
    if (property === "fill") {
      const fill = sanitizeColor(rawValue);
      if (fill) style.fill = fill;
    } else if (property === "stroke") {
      const stroke = sanitizeColor(rawValue);
      if (stroke) style.stroke = stroke;
    } else if (property === "color") {
      const textColor = sanitizeColor(rawValue);
      if (textColor) style.textColor = textColor;
    } else if (property === "stroke-width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.strokeWidth = Math.max(1, Math.min(8, width));
    } else if (property === "font-size") {
      const size = Number.parseFloat(rawValue);
      if (Number.isFinite(size) && size > 0) style.fontSize = Math.max(9, Math.min(48, size));
    } else if (property === "width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.width = clampNodeWidth(width);
    } else if (property === "height") {
      const height = Number.parseFloat(rawValue);
      if (Number.isFinite(height) && height > 0) style.height = clampNodeHeight(height);
    } else if (property === "stroke-dasharray") {
      const dashArray = sanitizeDashArray(rawValue);
      if (dashArray) style.dashArray = dashArray;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function parseEdgeStyle(source: string): EdgeStyleOverride | undefined {
  const style: EdgeStyleOverride = {};
  for (const declaration of splitStyleDeclarations(source)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim().replace(/;$/, "");
    if (property === "stroke") {
      const stroke = sanitizeColor(rawValue);
      if (stroke) style.stroke = stroke;
    } else if (property === "color") {
      const textColor = sanitizeColor(rawValue);
      if (textColor) style.textColor = textColor;
    } else if (property === "stroke-width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.strokeWidth = Math.max(1, Math.min(8, width));
    } else if (property === "stroke-dasharray") {
      const dashArray = sanitizeDashArray(rawValue);
      if (dashArray) style.dashArray = dashArray;
    } else if (property === "curve") {
      const curve = sanitizeCurve(rawValue);
      if (curve) style.curve = curve;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function parseLinkStyleStatements(source: string, edges: BaseEdge[]): Record<string, EdgeStyleOverride> {
  const out: Record<string, EdgeStyleOverride> = {};
  for (const line of getLines(source)) {
    const match = stripTrailingComment(line.text).trim().match(/^linkStyle\s+(\S+)\s+(.+?)\s*;?$/i);
    if (!match) continue;
    const style = parseEdgeStyle(match[2]!);
    if (!style) continue;
    const indexes = match[1]!.toLowerCase() === "default"
      ? edges.map((edge) => edge.orderIndex)
      : match[1]!.split(",").map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
    for (const index of indexes) {
      const edge = edges.find((item) => item.orderIndex === index);
      if (edge) out[edge.id] = { ...(out[edge.id] ?? {}), ...style };
    }
  }
  return out;
}

function splitStyleDeclarations(source: string): string[] {
  const declarations: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      parentheses += 1;
    } else if (char === ")") {
      parentheses = Math.max(0, parentheses - 1);
    } else if (char === "," && parentheses === 0) {
      declarations.push(source.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(source.slice(start));
  return declarations;
}

function appendNodeClasses(target: Map<string, string[]>, nodeId: string, classNames: string[]): void {
  if (classNames.length === 0) return;
  const current = target.get(nodeId) ?? [];
  target.set(nodeId, [...current, ...classNames]);
}

function parseFlowchart(source: string): ParseResult {
  const lines = getFlowchartStatements(source);
  const header = lines.find((line) =>
    /^\s*(?:flowchart|graph)\s+\S+\s*$/i.test(stripTrailingComment(line.text))
  );
  if (!header) return emptyParse("flowchart", "缺少 flowchart 头");
  const direction = stripTrailingComment(header.text).trim().split(/\s+/)[1] ?? "TD";
  const nodes = new Map<string, BaseNode & { shape?: string; shapeOpenSpan?: Span; shapeCloseSpan?: Span }>();
  const edges: BaseEdge[] = [];
  const protectedSpans: Span[] = [];
  const subgraphs: FlowGraph["subgraphs"] = [];
  let edgeOrder = 0;
  const nextEdgeId = createEdgeIdFactory("flow");
  const subgraphStack: { id: string; label: string; start: number; scopePath: string[]; direction?: string }[] = [];
  const inlineNodeClasses = new Map<string, string[]>();
  let hasLinkStyle = false;
  let firstUnparsedLine: LineInfo | undefined;
  let inAccDescrBlock = false;

  const ensureNode = (
    id: string,
    label: string,
    span: Span,
    declared: boolean,
    labelSpan?: Span,
    shape?: string,
    scopePath: string[] = [],
    shapeOpenSpan?: Span,
    shapeCloseSpan?: Span,
  ) => {
    const existing = nodes.get(id);
    if (existing) {
      existing.sourceRefs.push(span);
      if (declared && !existing.declared) {
        existing.declared = true;
        existing.implicit = false;
        existing.scopePath = [...scopePath];
      }
      if (label && existing.label === id) existing.label = label;
      if (labelSpan) existing.labelSpan = labelSpan;
      if (shape) existing.shape = shape;
      if (shapeOpenSpan) existing.shapeOpenSpan = shapeOpenSpan;
      if (shapeCloseSpan) existing.shapeCloseSpan = shapeCloseSpan;
      return existing;
    }
    const node: BaseNode & { shape?: string; shapeOpenSpan?: Span; shapeCloseSpan?: Span } = {
      id,
      label: label || id,
      declared,
      implicit: !declared,
      hasStableId: isStableMermaidId(id),
      scopePath: [...scopePath],
      sourceRefs: [span],
      ...(labelSpan ? { labelSpan } : {}),
      ...(shape ? { shape } : {}),
      ...(shapeOpenSpan ? { shapeOpenSpan } : {}),
      ...(shapeCloseSpan ? { shapeCloseSpan } : {}),
    };
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
    if (inAccDescrBlock) {
      protectedSpans.push(lineSpan(line));
      if (trimmed.includes("}")) inAccDescrBlock = false;
      continue;
    }
    if (/^acc(?:Title|Descr)\s*:/i.test(trimmed)) {
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (/^accDescr\s*\{/i.test(trimmed)) {
      protectedSpans.push(lineSpan(line));
      if (!trimmed.slice(trimmed.indexOf("{") + 1).includes("}")) inAccDescrBlock = true;
      continue;
    }
    if (/^subgraph\b/i.test(trimmed)) {
      const declaration = parseFlowSubgraphDeclaration(trimmed.replace(/^subgraph\s+/i, "").trim());
      subgraphStack.push({
        ...declaration,
        start: line.start,
        scopePath: subgraphStack.map((item) => item.id),
      });
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (/^end$/i.test(trimmed)) {
      const open = subgraphStack.pop();
      if (open) {
        subgraphs.push({
          id: open.id,
          label: open.label,
          span: { start: open.start, end: line.end },
          scopePath: open.scopePath,
          ...(open.direction ? { direction: open.direction } : {}),
        });
      } else {
        firstUnparsedLine ??= line;
      }
      protectedSpans.push(lineSpan(line));
      continue;
    }
    const scopedDirection = trimmed.match(/^direction\s+(TB|TD|BT|LR|RL)\s*;?$/i);
    if (scopedDirection && subgraphStack.length > 0) {
      subgraphStack[subgraphStack.length - 1]!.direction = scopedDirection[1]!.toUpperCase();
      protectedSpans.push(lineSpan(line));
      continue;
    }
    if (/^linkStyle\b/i.test(trimmed)) hasLinkStyle = true;
    if (/^(?:click|style|classDef|class|linkStyle)\b/i.test(trimmed)) {
      protectedSpans.push(lineSpan(line));
      continue;
    }

    const scopePath = subgraphStack.map((item) => item.id);
    const edgeStatement = parseFlowEdgeStatement(line, edgeOrder, scopePath, nextEdgeId);
    if (edgeStatement && "error" in edgeStatement) {
      return emptyParse("flowchart", edgeStatement.error);
    }
    if (edgeStatement) {
      edges.push(...edgeStatement.edges);
      edgeOrder += edgeStatement.edges.length;
      for (const ref of edgeStatement.refs) {
        ensureNode(ref.id, ref.label, ref.span, ref.declared, ref.labelSpan, ref.shape, scopePath, ref.shapeOpenSpan, ref.shapeCloseSpan);
        appendNodeClasses(inlineNodeClasses, ref.id, ref.classNames);
      }
      if (edgeStatement.edges.some((item) => !item.rewritable)) protectedSpans.push(lineSpan(line));
      continue;
    }

    const leading = line.text.search(/\S/);
    const nodeRef = leading >= 0 ? parseFlowNodeRef(line.text.slice(leading), line.start + leading) : null;
    if (nodeRef?.error) return emptyParse("flowchart", nodeRef.error);
    if (nodeRef && nodeRef.endOffset === line.text.trimEnd().length - leading) {
      ensureNode(nodeRef.id, nodeRef.label, nodeRef.span, true, nodeRef.labelSpan, nodeRef.shape, subgraphStack.map((item) => item.id), nodeRef.shapeOpenSpan, nodeRef.shapeCloseSpan);
      appendNodeClasses(inlineNodeClasses, nodeRef.id, nodeRef.classNames);
      if (nodeRef.unsupported) protectedSpans.push(lineSpan(line));
      continue;
    }
    protectedSpans.push(lineSpan(line));
    firstUnparsedLine ??= line;
  }
  const unclosedSubgraphCount = subgraphStack.length;
  for (const open of subgraphStack.splice(0).reverse()) {
    subgraphs.push({
      id: open.id,
      label: open.label,
      span: { start: open.start, end: source.length },
      scopePath: open.scopePath,
      ...(open.direction ? { direction: open.direction } : {}),
    });
  }

  const subgraphIds = new Set(subgraphs.map((subgraph) => subgraph.id));
  for (const subgraphId of subgraphIds) {
    const candidate = nodes.get(subgraphId);
    if (candidate?.implicit) nodes.delete(subgraphId);
  }
  const themeMetadata = parseDiagramThemeMetadata(
    source,
    nodes.keys(),
    inlineNodeClasses,
    edges,
    subgraphs.map((subgraph) => subgraph.id),
  );
  const parsedNodes = [...nodes.values()];
  const result: ParseResult = {
    ok: true,
    fullyRepresented:
      !/^\s*click\b/im.test(source)
      && presentationSyntaxFullyRepresented(source)
      && !parsedNodes.some((node) => node.shape === "icon" || node.shape === "image"),
    ...themeMetadata,
    model: {
      type: "flowchart",
      direction,
      nodes: parsedNodes,
      edges,
      subgraphs,
      hasLinkStyle,
      ...(unclosedSubgraphCount > 0 ? { unclosedSubgraphCount } : {}),
      ...themeMetadata,
    },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
  return firstUnparsedLine ? withUnparsedLineError(result, firstUnparsedLine) : result;
}

function parseFlowSubgraphDeclaration(raw: string): { id: string; label: string } {
  const explicit = raw.match(FLOW_SUBGRAPH_DECLARATION_RE);
  if (explicit) {
    return { id: explicit[1]!, label: displayMermaidLabel(stripQuotes(explicit[2]!)) };
  }
  const ref = parseFlowNodeRef(raw, 0);
  if (ref?.declared && ref.endOffset === raw.length) {
    return { id: ref.id, label: ref.label };
  }
  const title = displayMermaidLabel(stripQuotes(raw.trim()));
  return { id: raw.trim(), label: title || raw.trim() };
}

function parseFlowEdgeLine(
  line: LineInfo,
  orderIndex: number,
  scopePath: string[],
  nextEdgeId: EdgeIdFactory,
): null | {
  edge: BaseEdge;
  left: ParsedFlowNodeRef;
  right: ParsedFlowNodeRef;
} | {
  error: string;
} {
  const raw = stripTrailingComment(line.text);
  const arrowMatches = [...raw.matchAll(FLOW_ARROW_TOKEN_RE)];
  if (arrowMatches.length !== 1) return null;
  const match = arrowMatches[0]!;
  const arrow = match[0];
  const arrowSpec = parseFlowArrowToken(arrow);
  if (!arrowSpec) return null;
  const arrowIndex = match.index ?? 0;
  if (raw.includes("&")) return null;
  const before = raw.slice(0, arrowIndex);
  let after = raw.slice(arrowIndex + arrow.length);
  const arrowSpan = { start: line.start + arrowIndex, end: line.start + arrowIndex + arrow.length };
  let label: string | undefined;
  let labelSpan: Span | undefined;
  const labelMatch = after.match(/^\s*\|([^|\n]*)\|\s*/);
  if (labelMatch?.[1] !== undefined && labelMatch.index === 0) {
    const rawLabel = labelMatch[1];
    label = displayMermaidLabel(stripQuotes(rawLabel.trim()));
    const localStart = arrowIndex + arrow.length + (labelMatch[0].indexOf("|") + 1);
    labelSpan = { start: line.start + localStart, end: line.start + localStart + rawLabel.length };
    after = after.slice(labelMatch[0].length);
  }
  const leftStart = before.search(/\S/);
  if (leftStart < 0) return null;
  const left = parseFlowNodeRef(before.trim(), line.start + leftStart);
  const rightLeading = after.search(/\S/);
  if (rightLeading < 0) return null;
  const right = parseFlowNodeRef(after.trim(), line.start + arrowIndex + arrow.length + (labelMatch?.[0].length ?? 0) + rightLeading);
  if (!left || !right) return null;
  if (left.error) return { error: left.error };
  if (right.error) return { error: right.error };
  if (left.endOffset !== before.trim().length || right.endOffset !== after.trim().length) return null;
  const inSubgraph = scopePath.length > 0;
  const safeRewrite = isSafeFlowEdgeRewrite(line, inSubgraph, raw, left, right, before);
  const id = nextEdgeId({ source: left.id, target: right.id, syntaxKind: arrow, label: label || undefined });
  return {
    left,
    right,
    edge: {
      id,
      source: left.id,
      target: right.id,
      ...(label ? { label } : {}),
      ...(labelSpan ? { labelSpan } : {}),
      syntaxKind: arrow,
      syntaxSpan: arrowSpan,
      direction: arrowSpec.direction,
      lineStyle: arrowSpec.lineStyle,
      minLength: flowLinkMinLength(arrow),
      orderIndex,
      scopePath: [...scopePath],
      rewritable: safeRewrite,
      stmt: lineSpan(line),
    },
  };
}

function isSafeFlowEdgeRewrite(
  line: LineInfo,
  inSubgraph: boolean,
  raw: string,
  left: ParsedFlowNodeRef,
  right: ParsedFlowNodeRef,
  before: string,
): boolean {
  return isWholeLineStatement(line) &&
    !inSubgraph &&
    !left.unsupported &&
    !right.unsupported &&
    !/:::/i.test(raw) &&
    !/\[[^\]]*\]\s*[^\s-]/.test(before.trim().replace(left.raw, ""));
}

type ParsedFlowLink = {
  token: string;
  tokenStart: number;
  tokenEnd: number;
  endOffset: number;
  label?: string;
  labelStart?: number;
  labelEnd?: number;
  edgeId?: string;
  direction: EdgeDirection;
  lineStyle: EdgeLineStyle;
  sourceMarker: EdgeMarkerKind;
  targetMarker: EdgeMarkerKind;
};

const FLOW_DIRECT_LINK_TOKENS = [
  "<-.->",
  "<-->",
  "<==>",
  "<---",
  "<===",
  "o--o",
  "x--x",
  "o--x",
  "x--o",
  "o-->",
  "x-->",
  "<--o",
  "<--x",
  "-.->",
  "<-.-",
  "==>",
  "<==",
  "-->",
  "<--",
  "--o",
  "--x",
  "---",
  "-.-",
  "===",
  "~~~",
] as const;

function parseFlowEdgeStatement(
  line: LineInfo,
  orderIndex: number,
  scopePath: string[],
  nextEdgeId: EdgeIdFactory,
): { edges: BaseEdge[]; refs: ParsedFlowNodeRef[] } | { error: string } | null {
  const legacy = parseFlowEdgeLine(line, orderIndex, scopePath, nextEdgeId);
  if (legacy && "error" in legacy) return legacy;
  if (legacy) return { edges: [legacy.edge], refs: [legacy.left, legacy.right] };

  const raw = stripTrailingComment(line.text);
  let cursor = raw.search(/\S/);
  if (cursor < 0) return null;
  const first = parseFlowNodeSet(raw, cursor, line.start);
  if (!first) return null;
  if ("error" in first) return first;
  cursor = first.endOffset;
  let sources = first.refs;
  const refs = [...first.refs];
  const edges: BaseEdge[] = [];

  while (cursor < raw.length) {
    const link = parseFlowLinkAt(raw, cursor);
    if (!link) return null;
    const targets = parseFlowNodeSet(raw, link.endOffset, line.start);
    if (!targets) return null;
    if ("error" in targets) return targets;
    refs.push(...targets.refs);
    const cartesianCount = sources.length * targets.refs.length;
    for (const source of sources) {
      for (const target of targets.refs) {
        const currentOrder = orderIndex + edges.length;
        const providedId = link.edgeId && cartesianCount === 1 && edges.length === 0 ? link.edgeId : undefined;
        edges.push({
          id: providedId ?? nextEdgeId({ source: source.id, target: target.id, syntaxKind: link.token, label: link.label }),
          source: source.id,
          target: target.id,
          ...(link.label ? { label: link.label } : {}),
          ...(link.labelStart !== undefined && link.labelEnd !== undefined
            ? { labelSpan: { start: line.start + link.labelStart, end: line.start + link.labelEnd } }
            : {}),
          syntaxKind: link.token,
          syntaxSpan: { start: line.start + link.tokenStart, end: line.start + link.tokenEnd },
          direction: link.direction,
          lineStyle: link.lineStyle,
          sourceMarker: link.sourceMarker,
          targetMarker: link.targetMarker,
          minLength: flowLinkMinLength(link.token),
          orderIndex: currentOrder,
          scopePath: [...scopePath],
          rewritable: false,
          stmt: lineSpan(line),
        });
      }
    }
    cursor = targets.endOffset;
    sources = targets.refs;
    const tail = raw.slice(cursor);
    if (!tail.trim()) break;
  }
  if (edges.length === 1 && refs.length === 2) {
    const onlyEdge = edges[0]!;
    const before = raw.slice(0, (onlyEdge.syntaxSpan?.start ?? line.start) - line.start);
    onlyEdge.rewritable = isSafeFlowEdgeRewrite(
      line,
      scopePath.length > 0,
      raw,
      refs[0]!,
      refs[1]!,
      before,
    );
  }
  return edges.length > 0 ? { edges, refs } : null;
}

function parseFlowNodeSet(
  raw: string,
  offset: number,
  absoluteLineStart: number,
): { refs: ParsedFlowNodeRef[]; endOffset: number } | { error: string } | null {
  const refs: ParsedFlowNodeRef[] = [];
  let cursor = skipWhitespace(raw, offset);
  while (cursor < raw.length) {
    const ref = parseFlowNodeRef(raw.slice(cursor), absoluteLineStart + cursor);
    if (!ref) return refs.length > 0 ? { refs, endOffset: cursor } : null;
    if (ref.error) return { error: ref.error };
    refs.push(ref);
    cursor += ref.endOffset;
    const next = skipWhitespace(raw, cursor);
    if (raw[next] !== "&") return { refs, endOffset: next };
    cursor = skipWhitespace(raw, next + 1);
  }
  return refs.length > 0 ? { refs, endOffset: cursor } : null;
}

function parseFlowLinkAt(raw: string, offset: number): ParsedFlowLink | null {
  const start = skipWhitespace(raw, offset);
  const source = raw.slice(start);
  const edgeIdMatch = source.match(FLOW_EDGE_ID_RE);
  const edgeId = edgeIdMatch?.[1];
  const prefixLength = edgeIdMatch?.[0].length ?? 0;
  const linkSource = source.slice(prefixLength);

  const embeddedPatterns: Array<{ re: RegExp; token: string; trailingArrow: string; lineStyle: EdgeLineStyle }> = [
    { re: /^--\s+(.+?)\s+-->\s*/s, token: "-->", trailingArrow: "-->", lineStyle: "solid" },
    { re: /^-\.\s+(.+?)\s+\.->\s*/s, token: "-.->", trailingArrow: ".->", lineStyle: "dotted" },
    { re: /^==\s+(.+?)\s+==>\s*/s, token: "==>", trailingArrow: "==>", lineStyle: "thick" },
  ];
  for (const pattern of embeddedPatterns) {
    const match = linkSource.match(pattern.re);
    if (!match?.[1]) continue;
    const rawLabel = match[1];
    const localLabelStart = linkSource.indexOf(rawLabel);
    const trailingArrowStart = match[0].lastIndexOf(pattern.trailingArrow);
    const tokenStart = start + prefixLength + trailingArrowStart;
    return {
      token: pattern.token,
      tokenStart,
      tokenEnd: tokenStart + pattern.trailingArrow.length,
      endOffset: start + prefixLength + match[0].length,
      label: displayMermaidLabel(stripQuotes(rawLabel.trim())),
      labelStart: start + prefixLength + localLabelStart,
      labelEnd: start + prefixLength + localLabelStart + rawLabel.length,
      ...(edgeId ? { edgeId } : {}),
      direction: "forward",
      lineStyle: pattern.lineStyle,
      sourceMarker: "none",
      targetMarker: "arrow",
    };
  }

  const token = linkSource.match(/^(?:[ox]|<)?(?:-\.+-|={2,}|-{3,})(?:[ox]|>)?/)?.[0]
    ?? FLOW_DIRECT_LINK_TOKENS.find((candidate) => linkSource.startsWith(candidate));
  if (!token) return null;
  const spec = parseFlowArrowToken(token);
  if (!spec) return null;
  const tokenStart = start + prefixLength;
  let endOffset = tokenStart + token.length;
  let label: string | undefined;
  let labelStart: number | undefined;
  let labelEnd: number | undefined;
  const afterToken = raw.slice(endOffset);
  const pipeLabel = afterToken.match(/^\s*\|((?:\\.|[^|])*)\|\s*/s);
  if (pipeLabel?.[1] !== undefined) {
    const rawLabel = pipeLabel[1];
    const pipeOffset = pipeLabel[0].indexOf("|");
    labelStart = endOffset + pipeOffset + 1;
    labelEnd = labelStart + rawLabel.length;
    label = displayMermaidLabel(stripQuotes(rawLabel.trim()));
    endOffset += pipeLabel[0].length;
  }
  const markers = flowEdgeMarkers(token, spec.direction);
  return {
    token,
    tokenStart,
    tokenEnd: tokenStart + token.length,
    endOffset,
    ...(label ? { label } : {}),
    ...(labelStart !== undefined ? { labelStart } : {}),
    ...(labelEnd !== undefined ? { labelEnd } : {}),
    ...(edgeId ? { edgeId } : {}),
    ...spec,
    ...markers,
  };
}

function skipWhitespace(value: string, offset: number): number {
  let cursor = offset;
  while (cursor < value.length && /\s/.test(value[cursor]!)) cursor += 1;
  return cursor;
}

function flowEdgeMarkers(token: string, direction: EdgeDirection): { sourceMarker: EdgeMarkerKind; targetMarker: EdgeMarkerKind } {
  const sourceMarker: EdgeMarkerKind = token.startsWith("o") ? "circle"
    : token.startsWith("x") ? "cross"
    : direction === "backward" || direction === "both" ? "arrow"
    : "none";
  const targetMarker: EdgeMarkerKind = token.endsWith("o") ? "circle"
    : token.endsWith("x") ? "cross"
    : direction === "forward" || direction === "both" ? "arrow"
    : "none";
  return { sourceMarker, targetMarker };
}

function flowLinkMinLength(token: string): number {
  if (token === "~~~") return 1;
  if (token.includes(".")) return Math.max(1, (token.match(/\./g) ?? []).length);
  if (token.includes("=")) {
    const count = (token.match(/=/g) ?? []).length;
    return Math.max(1, count - (token.endsWith(">") ? 1 : 2));
  }
  const count = (token.match(/-/g) ?? []).length;
  return Math.max(1, count - (token.endsWith(">") ? 1 : 2));
}

function flowchartCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as FlowGraph;
  const hasLinkStyle = model.hasLinkStyle === true;
  const edge = target?.edgeId ? model.edges.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.nodes.find((n) => n.id === target.nodeId) : undefined;
  const deleteNodeReason = flowDeleteNodeReason(model, node);
  return [
    cap("connectEdge", !hasLinkStyle, hasLinkStyle ? "source 含 linkStyle,拒绝维护边序号" : undefined),
    cap("deleteEdge", !!edge && edge.rewritable && !hasLinkStyle, edgeReason(edge, hasLinkStyle)),
    cap("reconnectEdge", !!edge && edge.rewritable && !hasLinkStyle, edgeReason(edge, hasLinkStyle)),
    cap("addNode", true),
    cap("deleteNode", !!node && !deleteNodeReason, deleteNodeReason),
    cap("relabelNode", !!node && node.hasStableId && !!node.labelSpan, node?.labelSpan ? undefined : "节点没有可回写 label span"),
    cap(
      "setNodeShape",
      !!node && node.hasStableId && !!node.labelSpan && !!node.shapeOpenSpan && !!node.shapeCloseSpan,
      node?.labelSpan && node.shapeOpenSpan && node.shapeCloseSpan ? undefined : "节点没有可回写形状 span",
    ),
    cap("setEdgeLabel", !!edge && edge.rewritable, edge?.rewritable ? undefined : "该边不是简单单行语法"),
    cap("setEdgeArrow", !!edge && edge.rewritable && !!edge.syntaxSpan, edge?.rewritable && edge.syntaxSpan ? undefined : "该边没有可回写箭头 token"),
    cap("moveNode", false, "flowchart 不支持节点改父"),
  ];
}

function rewriteFlowchart(source: string, p: ParseResult, op: EditOp): RewriteResult {
  const model = p.model as FlowGraph;
  const ensure = ensureCapability(
    p,
    op,
    op.kind === "deleteEdge" || op.kind === "reconnectEdge" || op.kind === "setEdgeLabel" || op.kind === "setEdgeArrow"
      ? { edgeId: op.edgeId }
      : "nodeId" in op
        ? { nodeId: op.nodeId }
        : undefined,
  );
  if (!ensure.ok) return { ok: false, source, error: ensure.error };
  if (op.kind === "connectEdge") {
    const endpointError = connectEndpointError(model.nodes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    return { ok: true, source: insertBeforeSourceEnd(source, `  ${op.source} -->${op.label ? `|${safeMermaidLabel(op.label)}|` : ""} ${op.target}\n`) };
  }
  if (op.kind === "deleteEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const edits = [{ ...lineRemovalSpan(source, edge.stmt), text: "" }];
    // 端点节点若只在这条语句里声明(无论带不带标签),删掉整行会把两端节点一起带走
    // = 只想删一条连线却丢了两个节点。这里先把它们补成独立声明再删边。
    return {
      ok: true,
      source: applyFlowchartEditsPreservingInlineLabels(source, edits, [edge.stmt], {
        preserveMissingEndpoints: true,
      }),
    };
  }
  if (op.kind === "reconnectEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const endpointError = reconnectEndpointError(model.nodes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    const line = source.slice(edge.stmt.start, edge.stmt.end);
    const nextSource = op.newSource ?? edge.source;
    const nextTarget = op.newTarget ?? edge.target;
    const replacement = `  ${nextSource} ${edge.syntaxKind}${edge.label ? `|${safeMermaidLabel(edge.label)}|` : ""} ${nextTarget}${line.endsWith("\n") ? "\n" : ""}`;
    return edgeRewriteResult(
      source,
      applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: replacement }]),
      model.type,
      edge,
    );
  }
  if (op.kind === "setEdgeLabel") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const nextLabel = op.label.trim();
    const validationError = validateFlowEdgeLabel(nextLabel);
    if (validationError) return { ok: false, source, error: validationError };
    const rewrite = rewriteFlowEdgeLabel(source, edge, nextLabel);
    return rewrite ? edgeRewriteResult(source, rewrite, model.type, edge) : { ok: false, source, error: "边标签无法干净回写" };
  }
  if (op.kind === "setEdgeArrow") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    if (!edge.syntaxSpan) return { ok: false, source, error: "边箭头无法干净回写" };
    const nextLineStyle = op.lineStyle ?? edge.lineStyle ?? "solid";
    const nextToken = flowArrowToken(op.direction, nextLineStyle);
    const embeddedLinkSpan = flowEmbeddedEdgeLinkSpan(source, edge);
    const nextSource = embeddedLinkSpan && edge.label
      ? applyEdits(source, [{
          start: embeddedLinkSpan.start,
          end: embeddedLinkSpan.end,
          text: `${nextToken}|${safeMermaidLabel(edge.label).replace(/\|/g, "&#124;")}|`,
        }])
      : applyEdits(source, [{ start: edge.syntaxSpan.start, end: edge.syntaxSpan.end, text: nextToken }]);
    return edgeRewriteResult(
      source,
      nextSource,
      model.type,
      edge,
      (nextModel, nextEdge) =>
        nextModel.type === "flowchart" &&
        nextModel.edges.length === model.edges.length &&
        nextEdge.source === edge.source &&
        nextEdge.target === edge.target &&
        (nextEdge.label ?? "") === (edge.label ?? "") &&
        nextEdge.direction === op.direction &&
        nextEdge.lineStyle === nextLineStyle,
    );
  }
  if (op.kind === "addNode") {
    const reservedIds = [
      ...model.nodes.map((node) => node.id),
      ...model.subgraphs.map((subgraph) => subgraph.id),
    ];
    const id = boundedUniqueMermaidId(reservedIds, safeMermaidId(op.label));
    const newSource = insertBeforeSourceEnd(source, `  ${id}["${safeMermaidLabel(op.label)}"]\n`);
    const reparsed = parseFlowchart(newSource);
    if (!reparsed.ok || reparsed.model.type !== "flowchart") {
      return { ok: false, source, error: reparsed.error ?? "新节点写回后无法重新解析" };
    }
    const allIds = [
      ...reparsed.model.nodes.map((node) => node.id),
      ...reparsed.model.subgraphs.map((subgraph) => subgraph.id),
    ];
    if (new Set(allIds).size !== allIds.length) {
      return { ok: false, source, error: "节点与分区 ID 写回后仍有冲突" };
    }
    return addedNodeRewriteResult(source, newSource, "flowchart", id);
  }
  if (op.kind === "deleteNode") {
    const node = model.nodes.find((n) => n.id === op.nodeId)!;
    const reason = flowDeleteNodeReason(model, node);
    if (reason) return { ok: false, source, error: reason };
    const edits: Edit[] = [];
    for (const ref of node.sourceRefs) {
      if (!model.edges.some((e) => spanContains(e.stmt, ref))) edits.push({ ...lineRemovalSpan(source, ref), text: "" });
    }
    for (const edge of model.edges.filter((e) => e.source === op.nodeId || e.target === op.nodeId)) {
      if (!edge.rewritable) return { ok: false, source, error: "节点关联不可回写边,拒绝删除" };
      edits.push({ ...lineRemovalSpan(source, edge.stmt), text: "" });
    }
    return { ok: true, source: applyFlowchartEditsPreservingInlineLabels(source, dedupeEdits(edits), model.edges.filter((e) => e.source === op.nodeId || e.target === op.nodeId).map((e) => e.stmt), { excludeIds: new Set([op.nodeId]), preserveMissingEndpoints: true }) };
  }
  if (op.kind === "relabelNode") {
    const node = model.nodes.find((n) => n.id === op.nodeId)!;
    return { ok: true, source: applyEdits(source, [{ start: node.labelSpan!.start, end: node.labelSpan!.end, text: safeMermaidLabel(op.label) }]) };
  }
  if (op.kind === "setNodeShape") {
    const node = model.nodes.find((n) => n.id === op.nodeId)!;
    const syntax = flowShapeSyntax(op.shape);
    if (!syntax || !node.shapeOpenSpan || !node.shapeCloseSpan) {
      return { ok: false, source, error: "节点形状无法干净回写" };
    }
    return {
      ok: true,
      source: applyEdits(source, [
        { start: node.shapeOpenSpan.start, end: node.shapeOpenSpan.end, text: syntax.open },
        { start: node.shapeCloseSpan.start, end: node.shapeCloseSpan.end, text: syntax.close },
      ]),
    };
  }
  return unsupportedRewrite(source, op.kind);
}

function applyFlowchartEditsPreservingInlineLabels(
  source: string,
  edits: Edit[],
  removedEdgeSpans: Span[],
  opts: { excludeIds?: Set<string>; preserveMissingEndpoints?: boolean } = {},
): string {
  // 要"保住被带走的端点"时,连裸 id 端点(A --> B 里的 A/B)也得进候选:它们同样只靠这条语句存在。
  const candidates = collectRemovedFlowInlineLabels(source, removedEdgeSpans, {
    includeBareIds: opts.preserveMissingEndpoints === true,
  });
  const nextSource = applyEdits(source, edits);
  if (candidates.size === 0) return nextSource;
  const reparsed = parseFlowchart(nextSource);
  if (!reparsed.ok) return nextSource;
  const nextModel = reparsed.model as FlowGraph;
  const declarations: string[] = [];
  for (const candidate of candidates.values()) {
    if (opts.excludeIds?.has(candidate.id)) continue; // 不复活被删的节点本身
    const node = nextModel.nodes.find((item) => item.id === candidate.id);
    if (!node) {
      // 端点随被删语句一起消失了。删一条边/一个节点都不该连带删掉只在该语句里声明过的端点,
      // 补回为孤立节点声明(否则删 `A[开始] --> B[结束]` 这条边会把两个节点一起丢掉)。
      if (opts.preserveMissingEndpoints) declarations.push(`  ${formatFlowNodeDeclaration(candidate)}\n`);
      continue;
    }
    if (candidate.label === candidate.id) continue; // 节点还在,裸 id 没有可补的标签
    if (node.label !== node.id) continue; // 节点还在且标签没丢,无需补
    declarations.push(`  ${formatFlowNodeDeclaration(candidate)}\n`);
  }
  return declarations.length > 0 ? insertBeforeSourceEnd(nextSource, declarations.join("")) : nextSource;
}

function collectRemovedFlowInlineLabels(
  source: string,
  spans: Span[],
  opts: { includeBareIds?: boolean } = {},
): Map<string, ParsedFlowNodeRef> {
  const out = new Map<string, ParsedFlowNodeRef>();
  const nextEdgeId = createEdgeIdFactory("flow");
  for (const span of spans) {
    const raw = source.slice(span.start, span.end);
    const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const line: LineInfo = {
      text,
      start: span.start,
      end: span.end,
      bodyEnd: raw.endsWith("\n") ? span.end - 1 : span.end,
      index: 0,
    };
    const parsed = parseFlowEdgeStatement(line, 0, [], nextEdgeId);
    if (!parsed || "error" in parsed) continue;
    for (const ref of parsed.refs) {
      const bare = !ref.labelSpan || ref.label === ref.id;
      if (bare && !opts.includeBareIds) continue;
      if (!bare && !ref.declared) continue;
      out.set(ref.id, ref);
    }
  }
  return out;
}

function formatFlowNodeDeclaration(node: ParsedFlowNodeRef): string {
  const label = safeMermaidLabel(node.label);
  // 裸 id 端点补回时仍写成裸 id,不给它凭空造一个标签。
  if (node.label === node.id && (!node.shape || node.shape === "[")) return node.id;
  if (!node.shape || node.shape === "[") return `${node.id}["${label}"]`;
  const syntax = flowShapeSyntax(normalizeFlowShapeName(node.shape));
  return syntax ? `${node.id}${syntax.open}${label}${syntax.close}` : `${node.id}["${label}"]`;
}

function flowShapeSyntax(shape: FlowNodeShape): { open: string; close: string } | null {
  if (shape === "rect") return { open: "[", close: "]" };
  if (shape === "round") return { open: "(", close: ")" };
  if (shape === "stadium") return { open: "([", close: "])" };
  if (shape === "subroutine") return { open: "[[", close: "]]" };
  if (shape === "cylinder") return { open: "[(", close: ")]" };
  if (shape === "diamond") return { open: "{", close: "}" };
  if (shape === "circle") return { open: "((", close: "))" };
  if (shape === "doublecircle") return { open: "(((", close: ")))" };
  if (shape === "asymmetric") return { open: ">", close: "]" };
  if (shape === "hexagon") return { open: "{{", close: "}}" };
  if (shape === "parallelogram") return { open: "[/", close: "/]" };
  if (shape === "parallelogram-alt") return { open: "[\\", close: "\\]" };
  if (shape === "trapezoid") return { open: "[/", close: "\\]" };
  if (shape === "trapezoid-alt") return { open: "[\\", close: "/]" };
  return null;
}

const FLOW_SHAPE_ALIASES: Record<string, FlowNodeShape> = {
  "": "rect",
  "[": "rect",
  rect: "rect",
  rectangle: "rect",
  proc: "rect",
  process: "rect",
  square: "rect",
  "(": "round",
  round: "round",
  rounded: "round",
  event: "round",
  "([": "stadium",
  stadium: "stadium",
  pill: "stadium",
  terminal: "stadium",
  "[[": "subroutine",
  "fr-rect": "subroutine",
  framed: "subroutine",
  "framed-rectangle": "subroutine",
  subprocess: "subroutine",
  subproc: "subroutine",
  subroutine: "subroutine",
  "[(": "cylinder",
  cyl: "cylinder",
  cylinder: "cylinder",
  database: "cylinder",
  db: "cylinder",
  "((": "circle",
  circle: "circle",
  circ: "circle",
  "(((": "doublecircle",
  "dbl-circ": "doublecircle",
  "double-circle": "doublecircle",
  doublecircle: "doublecircle",
  ">": "asymmetric",
  asymmetric: "asymmetric",
  "{": "diamond",
  diam: "diamond",
  diamond: "diamond",
  decision: "diamond",
  question: "diamond",
  "{{": "hexagon",
  hex: "hexagon",
  hexagon: "hexagon",
  prepare: "hexagon",
  "[/": "parallelogram",
  parallelogram: "parallelogram",
  "lean-r": "parallelogram",
  "lean-right": "parallelogram",
  "in-out": "parallelogram",
  "[\\": "parallelogram-alt",
  "parallelogram-alt": "parallelogram-alt",
  "lean-l": "parallelogram-alt",
  "lean-left": "parallelogram-alt",
  "out-in": "parallelogram-alt",
  trapezoid: "trapezoid",
  "trap-b": "trapezoid",
  priority: "trapezoid",
  "trapezoid-bottom": "trapezoid",
  "trapezoid-alt": "trapezoid-alt",
  "trap-t": "trapezoid-alt",
  "inv-trapezoid": "trapezoid-alt",
  manual: "trapezoid-alt",
  "trapezoid-top": "trapezoid-alt",
  card: "notch-rect",
  "notched-rectangle": "notch-rect",
  collate: "hourglass",
  "com-link": "bolt",
  "lightning-bolt": "bolt",
  "brace-l": "brace",
  comment: "brace",
  "data-store": "datastore",
  "half-rounded-rectangle": "delay",
  das: "h-cyl",
  "horizontal-cylinder": "h-cyl",
  disk: "lin-cyl",
  "lined-cylinder": "lin-cyl",
  display: "curv-trap",
  "curved-trapezoid": "curv-trap",
  "div-proc": "div-rect",
  "divided-process": "div-rect",
  "divided-rectangle": "div-rect",
  document: "doc",
  extract: "tri",
  triangle: "tri",
  join: "fork",
  "internal-storage": "win-pane",
  "window-pane": "win-pane",
  "filled-circle": "f-circ",
  junction: "f-circ",
  "lined-document": "lin-doc",
  "lin-proc": "lin-rect",
  "lined-process": "lin-rect",
  "lined-rectangle": "lin-rect",
  "shaded-process": "lin-rect",
  "loop-limit": "notch-pent",
  "notched-pentagon": "notch-pent",
  "flipped-triangle": "flip-tri",
  "manual-file": "flip-tri",
  "manual-input": "sl-rect",
  "sloped-rectangle": "sl-rect",
  documents: "docs",
  "st-doc": "docs",
  "stacked-document": "docs",
  processes: "st-rect",
  procs: "st-rect",
  "stacked-rectangle": "st-rect",
  "paper-tape": "flag",
  "bow-tie-rectangle": "bow-rect",
  "stored-data": "bow-rect",
  summary: "cross-circ",
  "crossed-circle": "cross-circ",
  "tagged-document": "tag-doc",
  "tag-proc": "tag-rect",
  "tagged-process": "tag-rect",
  "tagged-rectangle": "tag-rect",
  "small-circle": "sm-circ",
  start: "sm-circ",
  "framed-circle": "fr-circ",
  stop: "fr-circ",
};

export function normalizeFlowShapeName(raw: string | null | undefined): FlowNodeShape {
  const value = (raw ?? "").trim().toLowerCase();
  return FLOW_SHAPE_ALIASES[value] ?? ((
    [
      "bang", "notch-rect", "cloud", "hourglass", "bolt", "brace", "brace-r", "braces",
      "datastore", "delay", "h-cyl", "lin-cyl", "curv-trap", "div-rect", "doc", "tri", "fork",
      "win-pane", "f-circ", "lin-doc", "lin-rect", "notch-pent", "flip-tri", "sl-rect",
      "docs", "st-rect", "odd", "flag", "sm-circ", "fr-circ", "bow-rect", "cross-circ",
      "tag-doc", "tag-rect", "text",
    ] as string[]
  ).includes(value) ? value as FlowNodeShape : "rect");
}

export function getFlowShapeGeometry(raw: string | null | undefined): FlowShapeGeometry {
  const shape = normalizeFlowShapeName(raw);
  const rect = "M0 0 H160 V72 H0 Z";
  const round = "M11 1 H149 Q159 1 159 11 V61 Q159 71 149 71 H11 Q1 71 1 61 V11 Q1 1 11 1 Z";
  const stadium = "M36 1 H124 A35 35 0 0 1 124 71 H36 A35 35 0 0 1 36 1 Z";
  const circle = "M80 1 A35 35 0 1 1 79.99 1 Z";
  if (shape === "rect") return { outlinePath: rect, detailPaths: [] };
  if (shape === "round") return { outlinePath: round, detailPaths: [] };
  if (shape === "stadium") return { outlinePath: stadium, detailPaths: [] };
  if (shape === "subroutine") return { outlinePath: rect, detailPaths: ["M20 1 V71", "M140 1 V71"] };
  if (shape === "cylinder") {
    return {
      outlinePath: "M1 12 C1 6 36 1 80 1 C124 1 159 6 159 12 V60 C159 66 124 71 80 71 C36 71 1 66 1 60 Z",
      detailPaths: ["M1 12 C1 18 36 23 80 23 C124 23 159 18 159 12"],
    };
  }
  if (shape === "circle") return { outlinePath: circle, detailPaths: [] };
  if (shape === "doublecircle") return { outlinePath: circle, detailPaths: ["M80 7 A29 29 0 1 1 79.99 7 Z"] };
  if (shape === "asymmetric") return { outlinePath: "M1 1 H137 L159 36 L137 71 H1 L20 36 Z", detailPaths: [] };
  if (shape === "diamond") return { outlinePath: "M80 1 L159 36 L80 71 L1 36 Z", detailPaths: [] };
  if (shape === "hexagon") return { outlinePath: "M34 1 H126 L159 36 L126 71 H34 L1 36 Z", detailPaths: [] };
  if (shape === "parallelogram") return { outlinePath: "M23 1 H159 L137 71 H1 Z", detailPaths: [] };
  if (shape === "parallelogram-alt") return { outlinePath: "M1 1 H137 L159 71 H23 Z", detailPaths: [] };
  if (shape === "trapezoid") return { outlinePath: "M25 1 H135 L159 71 H1 Z", detailPaths: [] };
  if (shape === "trapezoid-alt") return { outlinePath: "M1 1 H159 L135 71 H25 Z", detailPaths: [] };
  if (shape === "bang") return { outlinePath: "M80 1 L94 20 L122 8 L119 31 L159 36 L119 41 L122 64 L94 52 L80 71 L66 52 L38 64 L41 41 L1 36 L41 31 L38 8 L66 20 Z", detailPaths: [] };
  if (shape === "notch-rect") return { outlinePath: "M1 1 H139 L159 21 V71 H1 Z", detailPaths: ["M139 1 V21 H159"] };
  if (shape === "cloud") return { outlinePath: "M35 64 C15 64 6 52 15 39 C4 26 18 12 38 17 C47 2 73 0 86 15 C101 3 126 8 128 25 C151 22 164 39 151 52 C143 63 128 65 112 62 C91 75 58 73 35 64 Z", detailPaths: [] };
  if (shape === "hourglass") return { outlinePath: "M1 1 H159 L104 36 L159 71 H1 L56 36 Z", detailPaths: [] };
  if (shape === "bolt") return { outlinePath: "M91 1 L35 42 H70 L60 71 L125 28 H88 Z", detailPaths: [] };
  if (shape === "brace") return { outlinePath: "M124 1 C94 1 104 28 80 32 C104 36 94 71 124 71", detailPaths: [], open: true };
  if (shape === "brace-r") return { outlinePath: "M36 1 C66 1 56 28 80 32 C56 36 66 71 36 71", detailPaths: [], open: true };
  if (shape === "braces") return { outlinePath: "M45 1 C15 1 25 28 1 32 C25 36 15 71 45 71 M115 1 C145 1 135 28 159 32 C135 36 145 71 115 71", detailPaths: [], open: true };
  if (shape === "datastore") return { outlinePath: rect, detailPaths: ["M1 10 H159", "M1 62 H159"] };
  if (shape === "delay") return { outlinePath: "M1 1 H124 A35 35 0 0 1 124 71 H1 Z", detailPaths: [] };
  if (shape === "h-cyl") return { outlinePath: "M16 1 H144 C164 1 164 71 144 71 H16 C-4 71 -4 1 16 1 Z", detailPaths: ["M16 1 C36 1 36 71 16 71"] };
  if (shape === "lin-cyl") return { outlinePath: "M1 12 C1 6 36 1 80 1 C124 1 159 6 159 12 V60 C159 66 124 71 80 71 C36 71 1 66 1 60 Z", detailPaths: ["M1 12 C1 18 36 23 80 23 C124 23 159 18 159 12", "M1 20 C1 26 36 31 80 31 C124 31 159 26 159 20"] };
  if (shape === "curv-trap") return { outlinePath: "M20 1 H140 Q159 36 140 71 H20 Q1 36 20 1 Z", detailPaths: [] };
  if (shape === "div-rect") return { outlinePath: rect, detailPaths: ["M1 50 H159"] };
  if (shape === "doc") return { outlinePath: "M1 1 H159 V61 C125 78 101 50 80 64 C55 79 31 51 1 66 Z", detailPaths: [] };
  if (shape === "tri") return { outlinePath: "M80 1 L159 71 H1 Z", detailPaths: [] };
  if (shape === "fork") return { outlinePath: "M1 27 H159 V45 H1 Z", detailPaths: [] };
  if (shape === "win-pane") return { outlinePath: rect, detailPaths: ["M24 1 V71", "M1 20 H159"] };
  if (shape === "f-circ") return { outlinePath: "M80 23 A13 13 0 1 1 79.99 23 Z", detailPaths: [] };
  if (shape === "lin-doc") return { outlinePath: "M1 1 H159 V61 C125 78 101 50 80 64 C55 79 31 51 1 66 Z", detailPaths: ["M1 12 H159"] };
  if (shape === "lin-rect") return { outlinePath: rect, detailPaths: ["M10 1 V71", "M150 1 V71"] };
  if (shape === "notch-pent") return { outlinePath: "M25 1 H135 L159 22 V71 H1 V22 Z", detailPaths: [] };
  if (shape === "flip-tri") return { outlinePath: "M1 1 H159 L80 71 Z", detailPaths: [] };
  if (shape === "sl-rect") return { outlinePath: "M18 1 H159 L142 71 H1 Z", detailPaths: [] };
  if (shape === "docs") return { outlinePath: "M13 1 H159 V58 C128 72 105 51 85 62 C62 74 38 54 13 65 Z", detailPaths: ["M7 7 H153", "M1 13 H147"] };
  if (shape === "st-rect") return { outlinePath: "M13 1 H159 V59 H13 Z", detailPaths: ["M7 7 H153 V65 H7", "M1 13 H147 V71 H1"] };
  if (shape === "odd") return { outlinePath: "M1 1 H139 L159 36 L139 71 H1 L18 36 Z", detailPaths: [] };
  if (shape === "flag") return { outlinePath: "M1 8 C45 -6 66 21 104 8 C127 0 143 3 159 9 V64 C122 78 96 50 58 64 C35 72 17 69 1 63 Z", detailPaths: [] };
  if (shape === "sm-circ") return { outlinePath: "M80 26 A10 10 0 1 1 79.99 26 Z", detailPaths: [] };
  if (shape === "fr-circ") return { outlinePath: circle, detailPaths: ["M80 8 A28 28 0 1 1 79.99 8 Z"] };
  if (shape === "bow-rect") return { outlinePath: "M1 1 H159 L139 36 L159 71 H1 L21 36 Z", detailPaths: [] };
  if (shape === "cross-circ") return { outlinePath: circle, detailPaths: ["M56 12 L104 60", "M104 12 L56 60"] };
  if (shape === "tag-doc") return { outlinePath: "M1 1 H139 L159 21 V61 C125 78 101 50 80 64 C55 79 31 51 1 66 Z", detailPaths: ["M139 1 V21 H159"] };
  if (shape === "tag-rect") return { outlinePath: "M1 1 H139 L159 21 V71 H1 Z", detailPaths: ["M139 1 V21 H159"] };
  if (shape === "text") {
    return {
      outlinePath: "M1 1 H159 V71 H1 Z",
      detailPaths: [],
      open: true,
      outlineVisible: false,
    };
  }
  return { outlinePath: rect, detailPaths: [] };
}

function validateFlowEdgeLabel(label: string): string | null {
  if (/[|\r\n]/.test(label)) return "边标签不能包含竖线或换行";
  return null;
}

function rewriteFlowEdgeLabel(source: string, edge: BaseEdge, label: string): string | null {
  if (edge.labelSpan) {
    if (label) {
      return applyEdits(source, [{ start: edge.labelSpan.start, end: edge.labelSpan.end, text: safeMermaidLabel(label) }]);
    }
    const pipeStart = edge.labelSpan.start - 1;
    const pipeEnd = edge.labelSpan.end + 1;
    if (pipeStart < edge.stmt.start || pipeEnd > edge.stmt.end || source[pipeStart] !== "|" || source[edge.labelSpan.end] !== "|") {
      return null;
    }
    return applyEdits(source, [{ start: pipeStart, end: pipeEnd, text: "" }]);
  }
  if (!label) return source;
  const stmtText = source.slice(edge.stmt.start, edge.stmt.end);
  const raw = stripTrailingComment(stmtText);
  const arrow = [...raw.matchAll(FLOW_ARROW_TOKEN_RE)][0];
  if (!arrow || arrow.index === undefined) return null;
  const insertAt = edge.stmt.start + arrow.index + arrow[0].length;
  return applyEdits(source, [{ start: insertAt, end: insertAt, text: `|${safeMermaidLabel(label)}|` }]);
}

function flowEmbeddedEdgeLinkSpan(source: string, edge: BaseEdge): Span | null {
  if (!edge.labelSpan || !edge.syntaxSpan || edge.labelSpan.end > edge.syntaxSpan.start) return null;
  const beforeLabel = source.slice(edge.stmt.start, edge.labelSpan.start);
  const prefix = beforeLabel.match(/(?:--|-\.|==)\s*$/);
  if (!prefix || prefix.index === undefined) return null;
  return {
    start: edge.stmt.start + prefix.index,
    end: edge.syntaxSpan.end,
  };
}

function parseFlowArrowToken(token: string): { direction: EdgeDirection; lineStyle: EdgeLineStyle } | null {
  if (token === "~~~") return { direction: "none", lineStyle: "invisible" };
  if (/^[ox]--[ox]$/.test(token)) return { direction: "none", lineStyle: "solid" };
  if (/^[ox]-->$/.test(token)) return { direction: "forward", lineStyle: "solid" };
  if (/^<--[ox]$/.test(token)) return { direction: "backward", lineStyle: "solid" };
  if (/^--[ox]$/.test(token)) return { direction: "none", lineStyle: "solid" };
  if (token === "-->") return { direction: "forward", lineStyle: "solid" };
  if (token === "<--") return { direction: "backward", lineStyle: "solid" };
  if (token === "<---") return { direction: "backward", lineStyle: "solid" };
  if (token === "<-->") return { direction: "both", lineStyle: "solid" };
  if (token === "---") return { direction: "none", lineStyle: "solid" };
  if (token === "-.->") return { direction: "forward", lineStyle: "dotted" };
  if (token === "<-.-") return { direction: "backward", lineStyle: "dotted" };
  if (token === "<-.->") return { direction: "both", lineStyle: "dotted" };
  if (token === "-.-") return { direction: "none", lineStyle: "dotted" };
  if (token === "==>") return { direction: "forward", lineStyle: "thick" };
  if (token === "<==") return { direction: "backward", lineStyle: "thick" };
  if (token === "<===") return { direction: "backward", lineStyle: "thick" };
  if (token === "<==>") return { direction: "both", lineStyle: "thick" };
  if (token === "===") return { direction: "none", lineStyle: "thick" };
  if (/^(?:[ox]|<)?(?:-\.+-|={2,}|-{3,})(?:[ox]|>)?$/.test(token)) {
    const lineStyle: EdgeLineStyle = token.includes(".") ? "dotted" : token.includes("=") ? "thick" : "solid";
    const backward = token.startsWith("<");
    const forward = token.endsWith(">");
    const direction: EdgeDirection = backward && forward ? "both" : backward ? "backward" : forward ? "forward" : "none";
    return { direction, lineStyle };
  }
  return null;
}

function flowArrowToken(direction: EdgeDirection, lineStyle: EdgeLineStyle): string {
  if (lineStyle === "dotted") {
    if (direction === "forward") return "-.->";
    if (direction === "backward") return "<-.-";
    if (direction === "both") return "<-.->";
    return "-.-";
  }
  if (lineStyle === "thick") {
    if (direction === "forward") return "==>";
    // 反向粗线用长形 `<===`:短形 `<==|label|` Mermaid 解析失败,长形带不带 label 都合法。
    if (direction === "backward") return "<===";
    if (direction === "both") return "<==>";
    return "===";
  }
  if (direction === "forward") return "-->";
  // 反向实线用长形 `<---`:短形 `<--|label|` Mermaid 解析失败,长形带不带 label 都合法。
  if (direction === "backward") return "<---";
  if (direction === "both") return "<-->";
  return "---";
}

function parseState(source: string): ParseResult {
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

function stateCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
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

function rewriteState(source: string, p: ParseResult, op: EditOp): RewriteResult {
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

function parseEr(source: string): ParseResult {
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

function erCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
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

function rewriteEr(source: string, p: ParseResult, op: EditOp): RewriteResult {
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

function parseClass(source: string): ParseResult {
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

function classCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
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

function rewriteClass(source: string, p: ParseResult, op: EditOp): RewriteResult {
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

// 解析 mindmap 节点的形状语法,剥出 id 与显示文本。Mermaid mindmap 节点写法:
// `id((文本))` 圆形 / `id(文本)` 圆角 / `id[文本]` 方形 / `id))文本((` bang /
// `id)文本(` 云 / `id{{文本}}` 六边形;无包裹则整串既是 id 也是 label。
// 不剥离会导致根节点显示成字面量 `root((中心))`(见 e2e R1 Lane C 发现)。
function unwrapMindmapNode(text: string): {
  id: string;
  label: string;
  open: string;
  close: string;
  wrapped: boolean;
} {
  const pairs: Array<[RegExp, string, string]> = [
    [/^([^\s()[\]{}]*?)\(\((.+)\)\)$/, "((", "))"], // 圆形
    [/^([^\s()[\]{}]*?)\)\)(.+)\(\($/, "))", "(("], // bang
    [/^([^\s()[\]{}]*?)\{\{(.+)\}\}$/, "{{", "}}"], // 六边形
    [/^([^\s()[\]{}]*?)\[(.+)\]$/, "[", "]"], // 方形
    [/^([^\s()[\]{}]*?)\((.+)\)$/, "(", ")"], // 圆角
    [/^([^\s()[\]{}]*?)\)(.+)\($/, ")", "("], // 云
  ];
  for (const [re, open, close] of pairs) {
    const m = text.match(re);
    if (m) return { id: m[1] ?? "", label: m[2]!, open, close, wrapped: true };
  }
  return { id: text, label: text, open: "", close: "", wrapped: false };
}

function safeMindmapLabel(label: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
    "\\": "&#92;",
    "[": "&#91;",
    "]": "&#93;",
    "(": "&#40;",
    ")": "&#41;",
    "{": "&#123;",
    "}": "&#125;",
    "<": "&lt;",
    ">": "&gt;",
    "#": "&#35;",
    ":": "&#58;",
    "%": "&#37;",
    "\r": "&#13;",
    "\n": "<br>",
  };
  const encoded = label.replace(/[&"'\\[\](){}<>#:%\r\n]/g, (char) => entities[char]!);
  return encoded.replace(/^\s+|\s+$/g, (whitespace) =>
    [...whitespace].map((char) => `&#${char.codePointAt(0)};`).join("")
  );
}

function displayMindmapLabel(value: string): string {
  // 先还原编码器生成的真实换行，再解实体；这样用户输入的字面量 `<br>`
  // 会以 `&lt;br&gt;` 往返，不会被误解码成换行。
  return decodeMermaidEntities(value.replace(/<br\s*\/?>/gi, "\n"));
}

function parseMindmap(source: string): ParseResult {
  const lines = getLines(source);
  const header = lines.find((line) => /^\s*mindmap\b/.test(line.text));
  if (!header) return emptyParse("mindmap", "缺少 mindmap 头");
  const protectedSpans: Span[] = [];
  const stack: MindNode[] = [];
  let root: MindNode | null = null;
  let fullyRepresented = true;
  const siblingCounters = new Map<string, Map<string, number>>();
  for (const line of lines) {
    if (line === header) continue;
    const raw = line.text.replace(/\s+$/, "");
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("%%")) {
      protectedSpans.push(lineSpan(line));
      continue;
    }
    // ::class / #id::class / icon(...) 这类装饰语法仍不支持;形状包裹(`((..))` 等)
    // 现在能解析,不再标记为 unsupported(否则圆形根节点变只读且显示字面量)。
    const decorationProbe = trimmed.replace(/&#(?:\d+|x[0-9a-f]+);/gi, "");
    const unsupported = /::|#|^icon\(/i.test(decorationProbe);
    if (unsupported) {
      protectedSpans.push(lineSpan(line));
      fullyRepresented = false;
    }
    const parts = unwrapMindmapNode(trimmed);
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const parentKey = parent?.id ?? "root";
    const counters = siblingCounters.get(parentKey) ?? new Map<string, number>();
    siblingCounters.set(parentKey, counters);
    const occ = (counters.get(trimmed) ?? 0) + 1;
    counters.set(trimmed, occ);
    const path = [...(parent?.scopePath ?? []), `${trimmed}#${occ}`];
    const id = `mind-${hashText(path.join("/"))}`;
    const node: MindNode = {
      id,
      label: displayMindmapLabel(parts.label),
      line: lineSpan(line),
      indent,
      children: [],
      hasStableId: !unsupported,
      parentId: parent?.id ?? null,
      scopePath: path,
      sourceRefs: [lineSpan(line)],
    };
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    else {
      root.children.push(node);
      node.parentId = root.id;
    }
    stack.push(node);
  }
  if (!root) {
    root = { id: "mind-root", label: "mindmap", line: lineSpan(header), indent: 0, children: [], hasStableId: false, parentId: null, scopePath: ["mindmap"], sourceRefs: [] };
  }
  const themeMetadata = parseDiagramThemeMetadata(source, flattenMindmap(root).map((node) => node.id));
  return {
    ok: true,
    fullyRepresented:
      fullyRepresented && presentationSyntaxFullyRepresented(source),
    ...themeMetadata,
    model: { type: "mindmap", root, ...themeMetadata },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
}

function mindmapCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as MindmapTree;
  const nodes = flattenMindmap(model.root);
  const node = target?.nodeId ? nodes.find((n) => n.id === target.nodeId) : undefined;
  return [
    cap("connectEdge", false, "mindmap 不支持任意连边"),
    cap("deleteEdge", false, "mindmap 没有独立边"),
    cap("reconnectEdge", false, "mindmap 用 moveNode 改父"),
    cap("addNode", !target?.nodeId || !!node?.hasStableId, node?.hasStableId === false ? "该节点语法只读" : undefined),
    cap("deleteNode", !!node && node.hasStableId && node.parentId !== null, node?.parentId === null ? "根节点不可删除" : undefined),
    cap("relabelNode", !!node && node.hasStableId, node?.hasStableId ? undefined : "该节点语法只读"),
    cap("setNodeShape", false, "mindmap 节点形状由层级语义决定"),
    cap("setEdgeLabel", false, "mindmap 没有独立边标签"),
    cap("moveNode", !!node && node.hasStableId && node.parentId !== null, node?.parentId === null ? "根节点不可改父" : undefined),
  ];
}

function rewriteMindmap(source: string, p: ParseResult, op: EditOp): RewriteResult {
  const model = p.model as MindmapTree;
  const nodes = flattenMindmap(model.root);
  const node = "nodeId" in op ? nodes.find((n) => n.id === op.nodeId) : undefined;
  const ensure = ensureCapability(p, op, node ? { nodeId: node.id } : undefined);
  if (!ensure.ok) return { ok: false, source, error: ensure.error };
  if (op.kind === "addNode") {
    const parent = op.parentId ? nodes.find((n) => n.id === op.parentId) : model.root;
    if (!parent) return { ok: false, source, error: "父节点不存在" };
    const insertAt = subtreeEnd(source, parent);
    const indent = " ".repeat(parent.indent + 2);
    const text = `${indent}${safeMindmapLabel(op.label)}\n`;
    const beforeIds = new Set(nodes.map((item) => item.id));
    const newSource = insertAtLineBoundary(source, insertAt, text);
    const reparsed = parseMindmap(newSource);
    if (!reparsed.ok || reparsed.model.type !== "mindmap") {
      return { ok: false, source, error: reparsed.error ?? "mindmap 改写后无法重新解析" };
    }
    const reparsedTree = reparsed.model as MindmapTree;
    const newNode = flattenMindmap(reparsedTree.root).find((n) => !beforeIds.has(n.id) && n.label === op.label && n.parentId === parent.id);
    if (!newNode) return { ok: false, source, error: "mindmap 新节点标签无法完整往返" };
    return { ok: true, newNodeId: newNode?.id, source: newSource };
  }
  if (op.kind === "deleteNode") {
    const end = subtreeEnd(source, node!);
    const start = node!.line.start;
    const newSource = applyEdits(source, [{ start, end, text: "" }]);
    return mindmapRewriteResult(source, model, newSource, (oldLineStart) => {
      if (oldLineStart >= start && oldLineStart < end) return null;
      return oldLineStart >= end ? oldLineStart - (end - start) : oldLineStart;
    });
  }
  if (op.kind === "relabelNode") {
    const lineText = source.slice(node!.line.start, node!.line.end);
    const leading = lineText.match(/^\s*/)?.[0] ?? "";
    const newline = lineText.endsWith("\n") ? "\n" : "";
    // 保留原节点的 id 与形状包裹,只替换内部文本(否则改名会丢掉圆形/方形等形状)。
    const parts = unwrapMindmapNode(lineText.trim());
    const body = parts.wrapped
      ? `${parts.id}${parts.open}${safeMindmapLabel(op.label)}${parts.close}`
      : safeMindmapLabel(op.label);
    const replacement = `${leading}${body}${newline}`;
    const newSource = applyEdits(source, [{ start: node!.line.start, end: node!.line.end, text: replacement }]);
    const reparsed = parseMindmap(newSource);
    const renamedNode = reparsed.ok && reparsed.model.type === "mindmap"
      ? flattenMindmap(reparsed.model.root).find((item) => item.line.start === node!.line.start)
      : undefined;
    if (renamedNode?.label !== op.label) {
      return { ok: false, source, error: "mindmap 节点标签无法完整往返" };
    }
    const lengthDelta = replacement.length - (node!.line.end - node!.line.start);
    return mindmapRewriteResult(source, model, newSource, (oldLineStart) => {
      if (oldLineStart === node!.line.start) return node!.line.start;
      return oldLineStart >= node!.line.end ? oldLineStart + lengthDelta : oldLineStart;
    });
  }
  if (op.kind === "moveNode") {
    const parent = nodes.find((n) => n.id === op.newParentId);
    if (!parent) return { ok: false, source, error: "新父节点不存在" };
    if (node!.id === parent.id || isMindmapDescendant(parent, node!)) return { ok: false, source, error: "不能移动到自身或子孙下面" };
    const oldStart = node!.line.start;
    const oldEnd = subtreeEnd(source, node!);
    const block = source.slice(oldStart, oldEnd);
    const delta = parent.indent + 2 - node!.indent;
    const shifted = block
      .split(/(?<=\n)/)
      .map((line) => (line.trim() ? `${" ".repeat(Math.max(0, (line.match(/^\s*/)?.[0].length ?? 0) + delta))}${line.trimStart()}` : line))
      .join("");
    const without = source.slice(0, oldStart) + source.slice(oldEnd);
    // 派生 id 会随同名兄弟的序号变化；删除后不再用旧 id 回找父节点，而按删除前记录的
    // 源码位置校正偏移。显式 Mermaid id/形状文本原样保留，也走同一稳定源码位置。
    const removedLength = oldEnd - oldStart;
    const parentStart = parent.line.start >= oldEnd ? parent.line.start - removedLength : parent.line.start;
    const parentAtAdjustedPosition: MindNode = {
      ...parent,
      line: { start: parentStart, end: parentStart + (parent.line.end - parent.line.start) },
    };
    const insertAt = subtreeEnd(without, parentAtAdjustedPosition);
    const leadingLength = insertAt > 0 && without[insertAt - 1] !== "\n" ? 1 : 0;
    const trailingLength = insertAt < without.length && shifted.length > 0 && !shifted.endsWith("\n") ? 1 : 0;
    const insertedLength = leadingLength + shifted.length + trailingLength;
    const movedLineStarts = new Map<number, number>();
    const oldBlockLines = getLines(block);
    const shiftedBlockLines = getLines(shifted);
    for (let i = 0; i < oldBlockLines.length; i++) {
      const oldLine = oldBlockLines[i];
      const shiftedLine = shiftedBlockLines[i];
      if (oldLine && shiftedLine) {
        movedLineStarts.set(oldStart + oldLine.start, insertAt + leadingLength + shiftedLine.start);
      }
    }
    const newSource = insertAtLineBoundary(without, insertAt, shifted);
    return mindmapRewriteResult(source, model, newSource, (oldLineStart) => {
      if (oldLineStart >= oldStart && oldLineStart < oldEnd) {
        return movedLineStarts.get(oldLineStart) ?? null;
      }
      let adjusted = oldLineStart >= oldEnd ? oldLineStart - removedLength : oldLineStart;
      if (adjusted >= insertAt) adjusted += insertedLength;
      return adjusted;
    });
  }
  return unsupportedRewrite(source, op.kind);
}

function mindmapRewriteResult(
  originalSource: string,
  oldModel: MindmapTree,
  newSource: string,
  mapLineStart: (oldLineStart: number) => number | null,
): RewriteResult {
  const reparsed = parseMindmap(newSource);
  if (!reparsed.ok || reparsed.model.type !== "mindmap") {
    return { ok: false, source: originalSource, error: reparsed.error ?? "mindmap 改写后无法重新解析" };
  }

  const oldNodes = flattenMindmap(oldModel.root);
  const newModel = reparsed.model;
  const newNodesByLineStart = new Map(flattenMindmap(newModel.root).map((node) => [node.line.start, node]));
  const resolvedNodeIds: Record<string, string> = {};
  const changedNodeIds: Record<string, string> = {};
  for (const oldNode of oldNodes) {
    const newLineStart = mapLineStart(oldNode.line.start);
    if (newLineStart === null) continue;
    const newNode = newNodesByLineStart.get(newLineStart);
    if (!newNode) continue;
    resolvedNodeIds[oldNode.id] = newNode.id;
    if (oldNode.id !== newNode.id) changedNodeIds[oldNode.id] = newNode.id;
  }

  const newEdges = modelEdges(newModel);
  const changedEdgeIds: Record<string, string> = {};
  for (const oldEdge of modelEdges(oldModel)) {
    const newSourceId = resolvedNodeIds[oldEdge.source];
    const newTargetId = resolvedNodeIds[oldEdge.target];
    if (!newSourceId || !newTargetId) continue;
    const newEdge = newEdges.find((edge) =>
      edge.source === newSourceId &&
      edge.target === newTargetId &&
      edge.syntaxKind === oldEdge.syntaxKind
    );
    if (newEdge && newEdge.id !== oldEdge.id) changedEdgeIds[oldEdge.id] = newEdge.id;
  }

  const nodes = Object.keys(changedNodeIds).length > 0 ? changedNodeIds : undefined;
  const edges = Object.keys(changedEdgeIds).length > 0 ? changedEdgeIds : undefined;
  return nodes || edges
    ? { ok: true, source: newSource, idMap: { nodes, edges } }
    : { ok: true, source: newSource };
}

interface ParsedFlowNodeRef {
  id: string;
  raw: string;
  label: string;
  span: Span;
  labelSpan?: Span;
  shape?: string;
  shapeOpenSpan?: Span;
  shapeCloseSpan?: Span;
  declared: boolean;
  unsupported: boolean;
  endOffset: number;
  error?: string;
  classNames: string[];
}

const FLOW_NODE_SHAPE_SYNTAX: Array<{ open: string; close: string }> = [
  { open: "(((", close: ")))" },
  { open: "[[", close: "]]" },
  { open: "[(", close: ")]" },
  { open: "((", close: "))" },
  { open: "([", close: "])" },
  { open: "{{", close: "}}" },
  { open: "[/", close: "\\]" },
  { open: "[\\", close: "/]" },
  { open: "[/", close: "/]" },
  { open: "[\\", close: "\\]" },
  { open: ">", close: "]" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
  { open: "{", close: "}" },
];

function parseFlowNodeRef(rawInput: string, absoluteStart: number): ParsedFlowNodeRef | null {
  const raw = rawInput.trim();
  const match = raw.match(FLOW_NODE_REF_RE);
  if (!match) return null;
  let id = match[1]!;
  let rest = match[2] ?? "";
  // Mermaid 允许节点 ID 含连字符，但也允许边 token 紧贴 ID（A-->B）。
  // 贪婪 ID 正则会把箭头开头的 `--` 吞进 ID；以真实 link parser 找到最早合法边界。
  for (let cursor = 1; cursor < id.length; cursor += 1) {
    if (!parseFlowLinkAt(raw, cursor)) continue;
    // Mermaid 把 `x-o-->B` 中紧跟连字符的 o/x 归入节点 ID，后续 `-->` 才是边。
    if ((raw[cursor] === "o" || raw[cursor] === "x") && raw[cursor - 1] === "-") continue;
    id = raw.slice(0, cursor);
    rest = raw.slice(cursor);
    break;
  }
  let label = id;
  let labelSpan: Span | undefined;
  let shape: string | undefined;
  let shapeOpenSpan: Span | undefined;
  let shapeCloseSpan: Span | undefined;
  let unsupported = false;
  let endOffset = id.length;
  let declared = false;
  const classNames: string[] = [];
  if (rest.trim()) {
    const restLeading = rest.search(/\S/);
    const r = rest.trim();
    const attribute = parseFlowAttributeShape(r);
    const bracket = attribute ? null : parseFlowShapeContent(r);
    const startsWithShape = FLOW_NODE_SHAPE_SYNTAX.some((syntax) => r.startsWith(syntax.open));
    if (!attribute && !bracket && startsWithShape) {
      return {
        id,
        raw,
        label,
        span: { start: absoluteStart, end: absoluteStart + id.length },
        declared: false,
        unsupported: false,
        endOffset: id.length,
        classNames: [],
        error: `节点 ${id} 的形状未闭合`,
      };
    }
    if (attribute) {
      shape = normalizeFlowShapeName(attribute.shape);
      label = displayMermaidLabel(attribute.label ?? id);
      endOffset = id.length + restLeading + attribute.totalLength;
      declared = true;
      unsupported = true;
    } else if (bracket) {
      const rawLabel = stripQuotes(bracket.content);
      label = displayMermaidLabel(rawLabel);
      const leadingWhitespace = bracket.content.length - bracket.content.trimStart().length;
      const trailingWhitespace = bracket.content.length - bracket.content.trimEnd().length;
      const quoteOffset = isQuoted(bracket.content) ? 1 : 0;
      const localOpenStart = id.length + restLeading;
      const localContentStart = localOpenStart + bracket.open.length;
      const localLabelStart = localContentStart + leadingWhitespace + quoteOffset;
      const localLabelEnd = Math.max(
        localLabelStart,
        localContentStart + bracket.content.length - trailingWhitespace - quoteOffset,
      );
      const localCloseStart = localOpenStart + bracket.closeStart;
      labelSpan = { start: absoluteStart + localLabelStart, end: absoluteStart + localLabelEnd };
      shapeOpenSpan = { start: absoluteStart + localOpenStart, end: absoluteStart + localOpenStart + bracket.open.length };
      shapeCloseSpan = { start: absoluteStart + localCloseStart, end: absoluteStart + localCloseStart + bracket.close.length };
      shape = flowBracketShapeKey(bracket.open, bracket.close);
      endOffset = id.length + restLeading + bracket.totalLength;
      declared = true;
    }
    const inlineClassStart = Math.max(0, endOffset - id.length);
    const inlineClassSource = rest.slice(inlineClassStart);
    for (const classMatch of inlineClassSource.matchAll(INLINE_CLASS_RE)) {
      classNames.push(classMatch[1]!);
      endOffset = Math.max(endOffset, id.length + inlineClassStart + (classMatch.index ?? 0) + classMatch[0].length);
    }
    if (/:::|@\{|class\b|click\b/.test(rest)) unsupported = true;
  }
  return {
    id,
    raw,
    label,
    span: { start: absoluteStart, end: absoluteStart + endOffset },
    ...(labelSpan ? { labelSpan } : {}),
    ...(shape ? { shape } : {}),
    ...(shapeOpenSpan ? { shapeOpenSpan } : {}),
    ...(shapeCloseSpan ? { shapeCloseSpan } : {}),
    declared,
    unsupported,
    endOffset,
    classNames,
  };
}

function flowBracketShapeKey(open: string, close: string): string {
  if (open === "[/" && close === "\\]") return "trapezoid";
  if (open === "[\\" && close === "/]") return "trapezoid-alt";
  return open;
}

function parseFlowShapeContent(raw: string): { open: string; close: string; content: string; closeStart: number; totalLength: number } | null {
  for (const syntax of FLOW_NODE_SHAPE_SYNTAX) {
    if (!raw.startsWith(syntax.open)) continue;
    const closeStart = findFlowShapeClose(raw, syntax.open.length, syntax.close);
    if (closeStart < 0) continue;
    return {
      open: syntax.open,
      close: syntax.close,
      content: raw.slice(syntax.open.length, closeStart),
      closeStart,
      totalLength: closeStart + syntax.close.length,
    };
  }
  return null;
}

function findFlowShapeClose(raw: string, start: number, close: string): number {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = start; index <= raw.length - close.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (raw.startsWith(close, index)) return index;
  }
  return -1;
}

function parseFlowAttributeShape(raw: string): { shape: string; label?: string; totalLength: number } | null {
  if (!raw.startsWith("@{")) return null;
  const bodyEnd = findBalancedBraceEnd(raw, 1);
  if (bodyEnd < 0) return null;
  const body = raw.slice(2, bodyEnd);
  const shapeMatch = body.match(/\bshape\s*:\s*["']?([A-Za-z][\w-]*)["']?/i);
  const imageMatch = body.match(/\bimg\s*:/i);
  const iconMatch = body.match(/\bicon\s*:/i);
  const shape = shapeMatch?.[1] ?? (imageMatch ? "image" : iconMatch ? "icon" : "rect");
  const labelMatch = body.match(/\blabel\s*:\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^,}]+))/i);
  const label = labelMatch ? (labelMatch[1] ?? labelMatch[2] ?? labelMatch[3])?.trim() : undefined;
  return {
    shape,
    ...(label ? { label: stripQuotes(label) } : {}),
    totalLength: bodyEnd + 1,
  };
}

function findBalancedBraceEnd(raw: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = openIndex; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isQuoted(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
}

function ensureCapability(p: ParseResult, op: EditOp, target?: { nodeId?: string; edgeId?: string }): { ok: true } | { ok: false; error: string } {
  const caps = registry[p.model.type].capabilities(p, target);
  const found = caps.find((c) => c.op === op.kind);
  if (found?.enabled) return { ok: true };
  return { ok: false, error: found?.reason ?? `${op.kind} 不可用于当前元素` };
}

function connectEndpointError(existingIds: Iterable<string>, op: Extract<EditOp, { kind: "connectEdge" }>): string | null {
  const ids = new Set(existingIds);
  if (endpointMissing(ids, op.source) || endpointMissing(ids, op.target)) return "连接端点节点不存在";
  return null;
}

function reconnectEndpointError(existingIds: Iterable<string>, op: Extract<EditOp, { kind: "reconnectEdge" }>): string | null {
  const ids = new Set(existingIds);
  if (op.newSource !== undefined && endpointMissing(ids, op.newSource)) return "重连目标节点不存在";
  if (op.newTarget !== undefined && endpointMissing(ids, op.newTarget)) return "重连目标节点不存在";
  return null;
}

function endpointMissing(ids: Set<string>, value: string): boolean {
  return value.trim().length === 0 || !ids.has(value);
}

function parseErAttr(text: string, span: Span): { type: string; name: string; keys?: string[]; span: Span } | null {
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

const STATE_ENDPOINT_RE = String.raw`(?:\[\*\]|[\p{L}\p{N}_][\p{L}\p{N}_-]*)`;

function matchStateTransition(text: string): { from: string; to: string; label?: string } | null {
  const match = text.match(new RegExp(String.raw`^\s*(${STATE_ENDPOINT_RE})\s*-->\s*(${STATE_ENDPOINT_RE})(?:\s*:\s*(.*?))?\s*$`, "u"));
  if (!match) return null;
  return { from: match[1]!, to: match[2]!, ...(match[3] !== undefined ? { label: match[3] } : {}) };
}

function matchStateBare(text: string): { id: string } | null {
  const match = text.match(new RegExp(String.raw`^\s*(${STATE_ENDPOINT_RE})\s*$`, "u"));
  if (!match || match[1] === "[*]") return null;
  return { id: match[1]! };
}

function stateEndpoint(raw: string, role: "source" | "target"): {
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

function cap(op: EditOp["kind"], enabled: boolean, reason?: string): Capability {
  return enabled ? { op, enabled } : { op, enabled, reason: reason ?? "不可回写为 Mermaid 最小增量" };
}

function edgeReason(edge: BaseEdge | undefined, hasLinkStyle: boolean): string | undefined {
  if (hasLinkStyle) return "source 含 linkStyle,拒绝维护边序号";
  if (!edge) return "边不存在";
  return edge.rewritable ? undefined : "该边不是简单单行语法";
}

function flowDeleteNodeReason(model: FlowGraph, node: (BaseNode & { shape?: string }) | undefined): string | undefined {
  if (!node) return "节点不存在";
  if (!node.hasStableId) return "节点 id 不稳定";
  if (flowNodeTouchesSubgraph(model, node)) return "subgraph 内节点不做语义编辑";
  const relatedEdges = model.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  if (relatedEdges.some((edge) => !edge.rewritable)) return "节点关联不可回写边,拒绝删除";
  if (model.hasLinkStyle && relatedEdges.length > 0) return "source 含 linkStyle,拒绝维护边序号";
  return undefined;
}

function flowNodeTouchesSubgraph(model: FlowGraph, node: BaseNode): boolean {
  return node.sourceRefs.some((ref) => model.subgraphs.some((subgraph) => spanContains(subgraph.span, ref)));
}

function emptyParse(type: DiagramType, error: string): ParseResult {
  const model =
    type === "state"
      ? ({ type: "state", nodes: [], edges: [] } as StateGraph)
      : type === "er"
        ? ({ type: "er", entities: [], rels: [] } as ErGraph)
        : type === "class"
          ? ({ type: "class", classes: [], rels: [] } as ClassGraph)
          : type === "mindmap"
            ? ({ type: "mindmap", root: { id: "mind-root", label: "", line: { start: 0, end: 0 }, indent: 0, children: [], hasStableId: true, parentId: null, scopePath: [], sourceRefs: [] } } as MindmapTree)
            : ({ type: "flowchart", direction: "TD", nodes: [], edges: [], subgraphs: [] } as FlowGraph);
  return { ok: false, fullyRepresented: false, error, model, spanMap: { directives: [], protectedSpans: [] } };
}

function withUnparsedLineError(result: ParseResult, line: LineInfo): ParseResult {
  const sourceText = line.text.trim();
  return {
    ...result,
    ok: false,
    fullyRepresented: false,
    error: `无法解析第 ${line.index + 1} 行: ${sourceText}`,
    errorSpan: { start: line.start, end: line.bodyEnd },
  };
}

function getLines(source: string): LineInfo[] {
  const out: LineInfo[] = [];
  let start = 0;
  let index = 0;
  for (const part of source.split(/(?<=\n)/)) {
    if (!part && start >= source.length) continue;
    const end = start + part.length;
    const bodyEnd = part.endsWith("\n") ? end - 1 : end;
    out.push({ text: part.endsWith("\n") ? part.slice(0, -1) : part, start, end, bodyEnd, index });
    start = end;
    index += 1;
  }
  if (source.length === 0) out.push({ text: "", start: 0, end: 0, bodyEnd: 0, index: 0 });
  return out;
}

// Mermaid 的换行总是语句边界；分号只在节点形状、引号、边标签和注释之外切分。
// 每条语句保留绝对 offset 及分隔符，供节点/边 overlay 与安全回写判断使用。
function getFlowchartStatements(source: string): LineInfo[] {
  const out: LineInfo[] = [];
  let start = 0;
  let index = 0;
  let quote: "'" | '"' | null = null;
  const bracketClosers: string[] = [];
  let inPipeLabel = false;
  let inComment = false;

  const push = (separatorIndex: number, separatorLength: number) => {
    const end = separatorIndex + separatorLength;
    out.push({
      text: source.slice(start, separatorIndex),
      start,
      end,
      bodyEnd: separatorIndex,
      index,
      startsLine: start === 0 || source[start - 1] === "\n",
      separator: source[separatorIndex] === ";" ? ";" : "\n",
    });
    start = end;
    index += 1;
  };

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const char = source[cursor]!;
    const next = source[cursor + 1];
    if (inComment) {
      if (char === "\n") {
        push(cursor, 1);
        quote = null;
        bracketClosers.length = 0;
        inPipeLabel = false;
        inComment = false;
      }
      continue;
    }
    if (char === "\n") {
      push(cursor, 1);
      quote = null;
      bracketClosers.length = 0;
      inPipeLabel = false;
      inComment = false;
      continue;
    }
    if (!quote && char === "%" && next === "%") {
      inComment = true;
      cursor += 1;
      continue;
    }
    if (quote) {
      if (char === quote && source[cursor - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const bracketCloser = flowBracketCloser(char);
    if (bracketCloser) {
      bracketClosers.push(bracketCloser);
      continue;
    }
    if (char === "]" || char === ")" || char === "}") {
      closeFlowBracket(bracketClosers, char);
      continue;
    }
    if (bracketClosers.length === 0 && char === "|") {
      inPipeLabel = !inPipeLabel;
      continue;
    }
    if (!inPipeLabel && bracketClosers.length === 0 && char === ";") {
      push(cursor, 1);
      quote = null;
      bracketClosers.length = 0;
      inPipeLabel = false;
      inComment = false;
    }
  }
  if (start < source.length || source.length === 0) {
    out.push({
      text: source.slice(start),
      start,
      end: source.length,
      bodyEnd: source.length,
      index,
      startsLine: start === 0 || source[start - 1] === "\n",
    });
  }
  return out;
}

function flowBracketCloser(char: string): "]" | ")" | "}" | null {
  if (char === "[") return "]";
  if (char === "(") return ")";
  if (char === "{") return "}";
  return null;
}

function closeFlowBracket(closers: string[], char: string): void {
  const matchingOpen = closers.lastIndexOf(char);
  if (matchingOpen >= 0) closers.length = matchingOpen;
}

function lineSpan(line: LineInfo): Span {
  return { start: line.start, end: line.end };
}

function isWholeLineStatement(statement: LineInfo): boolean {
  return statement.startsLine !== false && statement.separator !== ";";
}

function lineRemovalSpan(source: string, span: Span): Span {
  let start = span.start;
  let end = span.end;
  while (start > 0 && source[start - 1] !== "\n") start -= 1;
  if (end < source.length && source[end] === "\n") end += 1;
  return { start, end };
}

function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

type FlowSourceLine = LineInfo & {
  indent: string;
  bodyStart: number;
  bodyEnd: number;
};

type FlowNodeRelocation =
  | { ok: true; edits: Edit[]; declarations: string[] }
  | { ok: false; error: string };

function preferredLineEnding(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function completeOpenFlowSubgraphs(source: string, model: FlowGraph): string {
  const count = model.unclosedSubgraphCount ?? 0;
  if (count === 0) return source;
  const lineEnding = preferredLineEnding(source);
  const prefix = source.endsWith("\n") ? "" : lineEnding;
  const closings = Array.from(
    { length: count },
    (_, index) => `${"  ".repeat(count - index)}end`,
  ).join(lineEnding);
  return `${source}${prefix}${closings}${lineEnding}`;
}

function sourceInsertionPrefix(source: string, insertionAt: number): string {
  if (insertionAt <= 0 || source[insertionAt - 1] === "\n") return "";
  return preferredLineEnding(source);
}

function sourceLineAt(lines: LineInfo[], offset: number): LineInfo | undefined {
  return lines.find((line) => offset >= line.start && offset < Math.max(line.end, line.start + 1));
}

function flowSourceLine(line: LineInfo): FlowSourceLine {
  const indent = line.text.match(/^\s*/)?.[0].replace(/\r$/, "") ?? "";
  const bodyEnd = line.text.endsWith("\r") ? line.bodyEnd - 1 : line.bodyEnd;
  return { ...line, indent, bodyStart: line.start, bodyEnd };
}

function parseFlowNodeRefAtSource(source: string, lines: LineInfo[], ref: Span): {
  line: FlowSourceLine;
  parsed: ParsedFlowNodeRef;
  standalone: boolean;
} | null {
  const line = sourceLineAt(lines, ref.start);
  if (!line) return null;
  const sourceLine = flowSourceLine(line);
  const parsed = parseFlowNodeRef(source.slice(ref.start, sourceLine.bodyEnd), ref.start);
  if (!parsed) return null;
  const before = source.slice(sourceLine.bodyStart, ref.start);
  const after = source.slice(parsed.span.end, sourceLine.bodyEnd);
  return {
    line: sourceLine,
    parsed,
    standalone: before.trim().length === 0 && after.trim().length === 0,
  };
}

function collectFlowNodeRelocation(source: string, nodes: FlowGraph["nodes"]): FlowNodeRelocation {
  const lines = getLines(source);
  const edits: Edit[] = [];
  const declarations: string[] = [];
  const removedLineStarts = new Set<number>();
  const removedShapeSpans = new Set<string>();

  for (const node of nodes) {
    let declaration: string | undefined;
    for (const ref of node.sourceRefs) {
      const located = parseFlowNodeRefAtSource(source, lines, ref);
      if (!located || located.parsed.id !== node.id || !located.parsed.declared) continue;
      const { line, parsed, standalone } = located;
      if (!parsed.shapeOpenSpan || !parsed.shapeCloseSpan) {
        return { ok: false, error: `节点 ${node.id} 使用了无法安全迁移的声明语法` };
      }
      const inlineClassSuffix = source.slice(parsed.shapeCloseSpan.end, parsed.span.end).replace(/\s+/g, "");
      const hasOnlyInlineClasses = parsed.classNames.length > 0 &&
        inlineClassSuffix === parsed.classNames.map((className) => `:::${className}`).join("");
      declaration ??= source.slice(
        ref.start,
        hasOnlyInlineClasses ? parsed.span.end : parsed.shapeCloseSpan.end,
      );
      if (standalone && (
        (parsed.classNames.length === 0 && !parsed.unsupported) ||
        hasOnlyInlineClasses
      )) {
        if (!removedLineStarts.has(line.start)) {
          edits.push({ start: line.start, end: line.end, text: "" });
          removedLineStarts.add(line.start);
        }
        continue;
      }
      const shapeSpan = { start: parsed.shapeOpenSpan.start, end: parsed.shapeCloseSpan.end };
      const key = `${shapeSpan.start}:${shapeSpan.end}`;
      if (!removedShapeSpans.has(key)) {
        edits.push({ ...shapeSpan, text: "" });
        removedShapeSpans.add(key);
      }
    }
    declarations.push(declaration ?? formatFlowModelNodeDeclaration(node));
  }
  return { ok: true, edits, declarations };
}

function formatFlowModelNodeDeclaration(node: FlowGraph["nodes"][number]): string {
  const syntax = flowShapeSyntax(normalizeFlowShapeName(node.shape));
  const label = `"${safeMermaidLabel(node.label)}"`;
  return syntax
    ? `${node.id}${syntax.open}${label}${syntax.close}`
    : `${node.id}[${label}]`;
}

function findInlineSubgraphWrapRange(
  source: string,
  nodes: FlowGraph["nodes"],
  selectedNodeIds: string[],
): { start: number; end: number; endsWithLineBreak: boolean } | null {
  if (nodes.length === 0) return null;
  const lines = getLines(source);
  const selected = new Set(selectedNodeIds);
  const declarationByLine = new Map<number, string>();

  for (const node of nodes) {
    const declaredRefs = node.sourceRefs
      .map((ref) => parseFlowNodeRefAtSource(source, lines, ref))
      .filter((located): located is NonNullable<typeof located> =>
        !!located && located.parsed.id === node.id && located.parsed.declared,
      );
    if (declaredRefs.length !== 1 || !declaredRefs[0]!.standalone) return null;
    declarationByLine.set(declaredRefs[0]!.line.start, node.id);
  }

  const declarationLines = [...declarationByLine.keys()].sort((left, right) => left - right);
  const start = declarationLines[0];
  const lastStart = declarationLines.at(-1);
  if (start === undefined || lastStart === undefined) return null;
  const lastLine = lines.find((line) => line.start === lastStart);
  if (!lastLine) return null;
  const end = lastLine.end;
  for (const line of lines) {
    if (line.start < start || line.start >= end) continue;
    const nodeId = declarationByLine.get(line.start);
    const trimmed = line.text.trim();
    if (nodeId ? selected.has(nodeId) : trimmed.length === 0 || trimmed.startsWith("%%")) continue;
    return null;
  }
  return {
    start,
    end,
    endsWithLineBreak: source.slice(lastLine.start, lastLine.end).endsWith("\n"),
  };
}

function flowSubgraphDeclarationLine(source: string, subgraph: FlowSubgraph): FlowSourceLine | null {
  const line = sourceLineAt(getLines(source), subgraph.span.start);
  if (!line || !/^\s*subgraph\b/i.test(line.text)) return null;
  return flowSourceLine(line);
}

function flowSubgraphClosingLine(source: string, subgraph: FlowSubgraph): FlowSourceLine | null {
  const lines = getLines(source)
    .filter((line) => line.start >= subgraph.span.start && line.end <= subgraph.span.end)
    .reverse();
  const line = lines.find((candidate) => /^\s*end\s*$/i.test(candidate.text));
  return line ? flowSourceLine(line) : null;
}

function flowSubgraphLabelSpan(line: FlowSourceLine, subgraphId: string): Span | null {
  const body = line.text.replace(/\r$/, "");
  const keyword = body.match(/^(\s*subgraph\s+)/i);
  if (!keyword) return null;
  const restStart = keyword[0].length;
  const rest = body.slice(restStart);
  const idMatch = rest.match(MERMAID_ID_PREFIX_RE);
  if (!idMatch || idMatch[1] !== subgraphId) return null;
  let cursor = restStart + idMatch[0].length;
  while (cursor < body.length && /\s/.test(body[cursor]!)) cursor += 1;
  if (body[cursor] !== "[") return null;
  const close = body.lastIndexOf("]");
  if (close <= cursor) return null;
  let labelStart = cursor + 1;
  let labelEnd = close;
  while (labelStart < labelEnd && /\s/.test(body[labelStart]!)) labelStart += 1;
  while (labelEnd > labelStart && /\s/.test(body[labelEnd - 1]!)) labelEnd -= 1;
  const quote = body[labelStart];
  if ((quote === '"' || quote === "'" || quote === "`") && body[labelEnd - 1] === quote) {
    labelStart += 1;
    labelEnd -= 1;
  }
  return { start: line.start + labelStart, end: line.start + labelEnd };
}

function flowScopeContentIndent(
  source: string,
  model: FlowGraph,
  parent: FlowSubgraph | undefined,
): string {
  if (parent) {
    const declaration = flowSubgraphDeclarationLine(source, parent);
    return `${declaration?.indent ?? ""}  `;
  }
  const header = getLines(source).find((line) => /^\s*(?:flowchart|graph)\s+/i.test(line.text));
  const indent = header?.text.match(/^\s*/)?.[0].replace(/\r$/, "") ?? "";
  void model;
  return `${indent}  `;
}

function verifyFlowSubgraphRewrite(
  originalSource: string,
  nextSource: string,
  expected: {
    subgraphId?: string;
    removedSubgraphId?: string;
    expectedTitle?: string;
    nodeIds?: string[];
    expectedScopePath?: string[];
    newSubgraphId?: string;
  },
): RewriteResult {
  const reparsed = parseDiagram(nextSource);
  if (!reparsed.ok || reparsed.model.type !== "flowchart") {
    return { ok: false, source: originalSource, error: reparsed.error ?? "分区改写后无法重新解析" };
  }
  const preserved = verifyFlowSubgraphsPreserved(
    originalSource,
    { ok: true, source: nextSource },
    expected.removedSubgraphId ? new Set([expected.removedSubgraphId]) : undefined,
  );
  if (!preserved.ok) return preserved;
  if (expected.removedSubgraphId && reparsed.model.subgraphs.some((item) => item.id === expected.removedSubgraphId)) {
    return { ok: false, source: originalSource, error: "分区解散后仍残留声明" };
  }
  if (expected.subgraphId) {
    const subgraph = reparsed.model.subgraphs.find((item) => item.id === expected.subgraphId);
    if (!subgraph) return { ok: false, source: originalSource, error: "分区改写后未能重新定位" };
    if (expected.expectedTitle !== undefined && subgraph.label !== expected.expectedTitle) {
      return { ok: false, source: originalSource, error: "分区标题改写后未能 round-trip" };
    }
  }
  if (expected.nodeIds && expected.expectedScopePath) {
    for (const nodeId of expected.nodeIds) {
      const node = reparsed.model.nodes.find((item) => item.id === nodeId);
      if (!node || !samePath(node.scopePath, expected.expectedScopePath)) {
        return { ok: false, source: originalSource, error: `节点 ${nodeId} 的分区归属改写失败` };
      }
    }
  }
  return {
    ok: true,
    source: nextSource,
    ...(expected.newSubgraphId ? { newSubgraphId: expected.newSubgraphId } : {}),
  };
}

/**
 * 所有 Mermaid 增量写回都必须保留源码里已有的 subgraph。
 * 唯一例外是 dissolveSubgraph 明确传入的目标；这样即使后续新增了按节点重建源码的路径，
 * 空分区也不会因为“没有成员行”而被静默吞掉。
 */
function verifyFlowSubgraphsPreserved(
  originalSource: string,
  result: RewriteResult,
  allowedRemovedIds: Set<string> = new Set(),
): RewriteResult {
  if (!result.ok) return result;
  const before = parseDiagram(originalSource);
  const after = parseDiagram(result.source);
  if (
    !before.ok ||
    before.model.type !== "flowchart" ||
    !after.ok ||
    after.model.type !== "flowchart"
  ) {
    return after.ok
      ? result
      : { ok: false, source: originalSource, error: after.error ?? "分区改写后无法重新解析" };
  }
  const afterIds = new Set(after.model.subgraphs.map((subgraph) => subgraph.id));
  const missing = before.model.subgraphs
    .map((subgraph) => subgraph.id)
    .filter((id) => !allowedRemovedIds.has(id) && !afterIds.has(id));
  return missing.length === 0
    ? result
    : {
        ok: false,
        source: originalSource,
        error: `改写不得静默删除分区：${missing.join("、")}`,
      };
}

function dedupeEdits(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function insertBeforeSourceEnd(source: string, text: string): string {
  if (!source.endsWith("\n")) return `${source}\n${text}`;
  return `${source}${text}`;
}

function unsupportedRewrite(source: string, op: string): RewriteResult {
  return { ok: false, source, error: `${op} 不支持当前图类型` };
}

function edgeRewriteResult(
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

function createEdgeIdFactory(prefix: string): EdgeIdFactory {
  const seen = new Map<string, number>();
  return (input) => {
    const key = edgeIdentityKey(input);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return edgeId(prefix, input, occurrence);
  };
}

function edgeIdentityKey(input: EdgeIdInput): string {
  return JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null]);
}

function edgeId(prefix: string, input: EdgeIdInput, occurrence: number): string {
  return `${prefix}-edge-${hashText(JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null, occurrence]))}`;
}

function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function displayMermaidLabel(value: string): string {
  return decodeMermaidEntities(value)
    .replace(/\\+(["'\\])/g, "$1")
    .replace(/^`([\s\S]*)`$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n");
}

function decodeMermaidEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal) {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return name ? named[name.toLowerCase()] ?? match : match;
  });
}

function stripTrailingComment(value: string): string {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "%" && value[index + 1] === "%") return value.slice(0, index);
  }
  return value;
}

function isStableMermaidId(id: string): boolean {
  return MERMAID_ID_RE.test(id);
}

function isStableStateId(id: string): boolean {
  return MERMAID_ID_RE.test(id);
}

function uniqueId(existing: Iterable<string>, base: string): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function boundedUniqueMermaidId(
  existing: Iterable<string>,
  base: string,
): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let index = 2;
  while (true) {
    const suffix = `_${index}`;
    const baseLimit = MAX_MERMAID_ID_GRAPHEMES - countGraphemes(suffix);
    const candidate = `${truncateGraphemes(base, baseLimit)}${suffix}`;
    if (!used.has(candidate)) return candidate;
    index += 1;
  }
}

function spanContains(container: Span, inner: Span): boolean {
  return container.start <= inner.start && inner.end <= container.end;
}

function modelNodes(model: DiagramModel): BaseNode[] {
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

function addedNodeRewriteResult(
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

function modelEdges(model: DiagramModel): BaseEdge[] {
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

function flattenMindmap(root: MindNode): MindNode[] {
  const out: MindNode[] = [];
  const walk = (node: MindNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

function subtreeEnd(source: string, node: MindNode): number {
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

function insertAtLineBoundary(source: string, index: number, text: string): string {
  const leading = index > 0 && source[index - 1] !== "\n" ? "\n" : "";
  const trailing = index < source.length && text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  return source.slice(0, index) + leading + text + trailing + source.slice(index);
}

function isMindmapDescendant(candidate: MindNode, ancestor: MindNode): boolean {
  return candidate.scopePath.length > ancestor.scopePath.length && ancestor.scopePath.every((part, index) => candidate.scopePath[index] === part);
}

function filterRecord<T>(record: Record<string, T> | undefined, allowed: Set<string>): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function remapRecord<T>(
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

function emptyOverlay(overlay: DiagramOverlay): boolean {
  return !overlay.positions && !overlay.styles && !overlay.zOrders && !overlay.edgeStyles && !overlay.edgeHandles;
}

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}

export const GRAPH_LAYOUT_NODE_WIDTH = 160;
export const GRAPH_LAYOUT_NODE_HEIGHT = 72;
export const GRAPH_LAYOUT_NODE_MIN_WIDTH = 96;
export const GRAPH_LAYOUT_NODE_MIN_HEIGHT = 48;
export const GRAPH_LAYOUT_NODE_MAX_WIDTH = 640;
export const GRAPH_LAYOUT_NODE_MAX_HEIGHT = 480;

const GRAPH_LAYOUT_NODE_GAP = 70;
const GRAPH_LAYOUT_LAYER_GAP = 86;
const GRAPH_LAYOUT_ROOT_OFFSET = 40;
const GRAPH_CLUSTER_SIDE_PADDING = 30;
const GRAPH_CLUSTER_TITLE_HEIGHT = 46;
const GRAPH_CLUSTER_BOTTOM_PADDING = 28;

type LayoutDirection = "TB" | "BT" | "LR" | "RL";
type LayoutItem = {
  id: string;
  width: number;
  height: number;
  nodeRects: Record<string, GraphLayoutRect>;
  clusters: GraphLayoutCluster[];
};
type LayoutLink = { source: string; target: string; minLength: number };

function clampNodeWidth(width: number): number {
  return Math.max(GRAPH_LAYOUT_NODE_MIN_WIDTH, Math.min(GRAPH_LAYOUT_NODE_MAX_WIDTH, Math.round(width)));
}

function clampNodeHeight(height: number): number {
  return Math.max(GRAPH_LAYOUT_NODE_MIN_HEIGHT, Math.min(GRAPH_LAYOUT_NODE_MAX_HEIGHT, Math.round(height)));
}

function graphLayoutNodeSize(
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

function graphModelDirection(model: DiagramModel): LayoutDirection {
  if (model.type === "flowchart") return normalizeLayoutDirection(model.direction);
  if (model.type === "mindmap") return "LR";
  return "TB";
}

function normalizeLayoutDirection(value: string | undefined): LayoutDirection {
  const direction = (value ?? "").trim().toUpperCase().replace(/;$/, "");
  if (direction === "LR" || direction === "RL" || direction === "BT") return direction;
  return "TB";
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function arrangeLayoutItems(
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

function translateLayoutItems(
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

function applyOverlayPositions(
  nodes: Record<string, GraphLayoutRect>,
  overlay: DiagramOverlay | null | undefined,
): void {
  for (const [id, position] of Object.entries(overlay?.positions ?? {})) {
    if (!nodes[id] || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    nodes[id] = { ...nodes[id]!, x: position.x, y: position.y };
  }
}

function applyOverlayClusterPositions(
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

function refitClustersToContents(
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

function svgDefs(themePalette: ThemePalette | undefined): string {
  const lineColor = sanitizeColor(themePalette?.lineColor) ?? "#8d7447";
  return `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="${lineColor}"/></marker><marker id="circle-edge" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth"><circle cx="5" cy="5" r="3.2" fill="#faf6ec" stroke="${lineColor}" stroke-width="1.5"/></marker><marker id="cross-edge" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M2 2 L8 8 M8 2 L2 8" stroke="${lineColor}" stroke-width="1.8"/></marker></defs>`;
}

const SVG_NODE_WIDTH = GRAPH_LAYOUT_NODE_WIDTH;
const SVG_NODE_HEIGHT = GRAPH_LAYOUT_NODE_HEIGHT;
const SVG_PADDING = 32;
// 导出会在无网络的 server Chromium 中直接绘制 SVG。VPS 的 fonts-noto-cjk 注册名是
// "Noto * CJK SC"，并不提供 "Noto Serif SC" / "Songti SC"；旧字体栈最终落到缺少中文
// 字形的 generic serif，PDF 与 PNG 只剩框线。与 generateSvg 已验证路径一致，交给系统
// sans-serif 做平台字体回退；作为 presentation attribute 内联到每个 text，不依赖宿主 CSS。
const SVG_TEXT_FONT_FAMILY = "sans-serif";

type SvgBounds = { minX: number; minY: number; maxX: number; maxY: number };

function textWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, char) => width + (/[\u0000-\u00ff]/.test(char) ? fontSize * (char === " " ? 0.35 : 0.62) : fontSize), 0);
}

function wrapNodeLabel(label: string, fontSize: number, nodeWidth = SVG_NODE_WIDTH): string[] {
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

function edgeGeometry(from: GraphLayoutRect, to: GraphLayoutRect) {
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

function rectBoundaryPoint(rect: GraphLayoutRect, toward: { x: number; y: number }): { x: number; y: number } {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: rect.y + rect.height };
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.width / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.height / 2) / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function graphSvgBounds(
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

function renderSvgNode(
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
  const fontSizeSource = overlayStyle?.fontSize ?? sourceStyle?.fontSize;
  const fontSize = typeof fontSizeSource === "number" ? Math.max(9, Math.min(28, fontSizeSource)) : 14;
  const lines = wrapNodeLabel(node.label, fontSize, pos.width);
  const lineHeight = Math.max(16, Math.round(fontSize * 1.3));
  const firstBaseline = pos.y + pos.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.36;
  const text = lines.map((line, index) => `<tspan x="${pos.x + pos.width / 2}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`).join("");
  const geometry = getFlowShapeGeometry((node as BaseNode & { shape?: string }).shape);
  const normalizedShape = normalizeFlowShapeName((node as BaseNode & { shape?: string }).shape);
  const dashArray = overlayStyle?.dashArray ?? sourceStyle?.dashArray;
  const layoutAttributes = ` data-layout-x="${pos.x}" data-layout-y="${pos.y}" data-layout-width="${pos.width}" data-layout-height="${pos.height}"`;
  const shape = normalizedShape === "rect"
    ? `<rect x="${pos.x}" y="${pos.y}" width="${pos.width}" height="${pos.height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${layoutAttributes}${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}/>`
    : `<g transform="translate(${pos.x} ${pos.y}) scale(${pos.width / SVG_NODE_WIDTH} ${pos.height / SVG_NODE_HEIGHT})"${layoutAttributes}><path d="${geometry.outlinePath}" fill="${geometry.open ? "none" : fill}" stroke="${geometry.outlineVisible === false ? "none" : stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}/>${geometry.detailPaths.map((path) => `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"/>`).join("")}</g>`;
  return `<g data-node-id="${escapeXml(node.id)}">${shape}<text text-anchor="middle" font-size="${fontSize}" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${text}</text></g>`;
}

function renderSvgEdge(
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
  const label = edge.label && !invisible
    ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="12" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${escapeXml(edge.label)}</text>`
    : "";
  const sourceMarker = edge.sourceMarker ?? (edge.direction === "backward" || edge.direction === "both" ? "arrow" : "none");
  const targetMarker = edge.targetMarker ?? (edge.direction === "forward" || edge.direction === "both" || edge.direction === undefined ? "arrow" : "none");
  const markerUrl = (marker: EdgeMarkerKind) => marker === "arrow" ? "url(#arrow)" : marker === "circle" ? "url(#circle-edge)" : marker === "cross" ? "url(#cross-edge)" : null;
  const markerStart = markerUrl(sourceMarker);
  const markerEnd = markerUrl(targetMarker);
  const dashArray = style?.dashArray ?? (edge.lineStyle === "dotted" ? "4 6" : undefined);
  return `<g data-edge-id="${escapeXml(edge.id)}" data-line-style="${edge.lineStyle ?? "solid"}"><path d="${pathData}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashArray ? ` stroke-dasharray="${escapeXml(dashArray)}"` : ""}${markerStart && !invisible ? ` marker-start="${markerStart}"` : ""}${markerEnd && !invisible ? ` marker-end="${markerEnd}"` : ""}${invisible ? ' visibility="hidden"' : ""}/>${label}</g>`;
}

function renderSvgCluster(
  cluster: GraphLayoutCluster,
  themePalette: ThemePalette | undefined,
  style: NodeStyleOverride | undefined,
): string {
  const fill = sanitizeColor(style?.fill) ?? sanitizeColor(themePalette?.clusterFill) ?? "#f3ecdd";
  const stroke = sanitizeColor(style?.stroke) ?? sanitizeColor(themePalette?.clusterStroke) ?? "#cdbfa3";
  const text = sanitizeColor(themePalette?.textColor) ?? "#2f2a22";
  const emptyHint = cluster.empty
    ? `<text x="${cluster.x + cluster.width / 2}" y="${cluster.y + cluster.height / 2 + 12}" text-anchor="middle" font-size="12" fill="${text}" fill-opacity="0.58" font-family="${SVG_TEXT_FONT_FAMILY}">拖入节点</text>`
    : "";
  return `<g data-cluster-id="${escapeXml(cluster.id)}" data-layout-x="${cluster.x}" data-layout-y="${cluster.y}" data-layout-width="${cluster.width}" data-layout-height="${cluster.height}" data-direction="${cluster.direction}" data-empty="${cluster.empty}"><rect x="${cluster.x}" y="${cluster.y}" width="${cluster.width}" height="${cluster.height}" fill="${fill}" fill-opacity="0.72" stroke="${stroke}" stroke-width="1.5"${cluster.empty ? ' stroke-dasharray="6 5"' : ""}/><text x="${cluster.x + cluster.width / 2}" y="${cluster.y + 27}" text-anchor="middle" font-size="14" font-weight="600" fill="${text}" font-family="${SVG_TEXT_FONT_FAMILY}">${escapeXml(cluster.label)}</text>${emptyHint}</g>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeColor(value: string | undefined): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{3,8}$/.test(value)
    || /^rgba?\([0-9.%+,\s-]+\)$/.test(value)
    ? value
    : null;
}

function sanitizeDashArray(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\,/g, ",").trim();
  return /^(?:\d+(?:\.\d+)?(?:px)?)(?:[\s,]+(?:\d+(?:\.\d+)?(?:px)?))*$/.test(normalized) ? normalized : null;
}

function sanitizeCurve(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^(?:basis|bumpX|bumpY|cardinal|catmullRom|linear|monotoneX|monotoneY|natural|step|stepAfter|stepBefore)$/.test(normalized)
    ? normalized
    : null;
}
