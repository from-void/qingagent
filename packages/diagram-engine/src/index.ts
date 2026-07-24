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
  orderIndex: number;
  cardinality?: string;
  scopePath: string[];
  rewritable: boolean;
  stmt: Span;
}

export type EdgeDirection = "forward" | "backward" | "both" | "none";
export type EdgeLineStyle = "solid" | "dotted" | "thick";

export type FlowNodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "hexagon"
  | "parallelogram";

export interface FlowGraph {
  type: "flowchart";
  direction: string;
  nodes: (BaseNode & { shape?: string; shapeOpenSpan?: Span; shapeCloseSpan?: Span })[];
  edges: BaseEdge[];
  subgraphs: { id: string; span: Span; scopePath: string[] }[];
  hasLinkStyle?: boolean;
}

export interface StateGraph {
  type: "state";
  nodes: (BaseNode & { kind: "state" | "start" | "end" | "choice" | "fork" | "composite" })[];
  edges: BaseEdge[];
}

export interface ErGraph {
  type: "er";
  entities: (BaseNode & { attrs: { type: string; name: string; keys?: string[]; span: Span }[] })[];
  rels: (BaseEdge & { leftCard: string; rightCard: string })[];
}

export interface ClassGraph {
  type: "class";
  classes: (BaseNode & { members: { raw: string; span: Span }[]; generics?: string })[];
  rels: (BaseEdge & { relKind: string })[];
}

export interface MindmapTree {
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

export interface ParseResult {
  model: DiagramModel;
  spanMap: SpanMap;
  ok: boolean;
  error?: string;
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
}

export interface EdgeStyleOverride {
  stroke?: string;
  textColor?: string;
  strokeWidth?: number;
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
const FLOW_ARROW_TOKEN_AT_RE = new RegExp(FLOW_ARROW_TOKEN_RE.source, "y");

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
  return registry[parsed.model.type].rewrite(source, parsed, op);
}

export function getStableElementIds(model: DiagramModel): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const node of modelNodes(model)) {
    if (node.id) nodes.add(node.id);
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
  const edgeStyles = filterRecord(overlay.edgeStyles, ids.edges);
  const edgeHandles = filterRecord(overlay.edgeHandles, ids.edges);
  return emptyOverlay({ positions, styles, edgeStyles, edgeHandles }) ? undefined : { positions, styles, edgeStyles, edgeHandles };
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
  const edgeStyles = remapRecord(oldOverlay.edgeStyles, newIds.edges, edges, idMap?.edges);
  const edgeHandles = remapRecord(oldOverlay.edgeHandles, newIds.edges, edges, idMap?.edges);
  return emptyOverlay({ positions, styles, edgeStyles, edgeHandles }) ? undefined : { positions, styles, edgeStyles, edgeHandles };
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
  return id.slice(0, 64);
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
  const edges = modelEdges(parsed.model);
  const flattened = modelNodes(parsed.model);
  if (flattened.length === 0) return null;
  const layout = layoutNodes(flattened, edges, overlay);
  const bounds = graphSvgBounds(flattened, edges, layout, overlay);
  const nodeSvg = flattened
    .map((node) => renderSvgNode(node.id, node.label, layout[node.id] ?? { x: 24, y: 24 }, overlay?.styles?.[node.id]))
    .join("");
  const edgeSvg = edges
    .filter((edge) => layout[edge.source] && layout[edge.target])
    .map((edge) => renderSvgEdge(edge, layout[edge.source]!, layout[edge.target]!, overlay?.edgeStyles?.[edge.id]))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}" role="img">${svgDefs()}<rect x="${bounds.minX}" y="${bounds.minY}" width="${bounds.width}" height="${bounds.height}" fill="#faf6ec"/>${edgeSvg}${nodeSvg}</svg>`;
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

function parseFlowchart(source: string): ParseResult {
  const statements = getFlowchartStatements(source);
  const header = statements.find((statement) => /^\s*(?:flowchart|graph)\s+\S+\s*$/i.test(stripTrailingComment(statement.text)));
  if (!header) return emptyParse("flowchart", "缺少 flowchart 头");
  const direction = stripTrailingComment(header.text).trim().split(/\s+/)[1] ?? "TD";
  const nodes = new Map<string, BaseNode & { shape?: string; shapeOpenSpan?: Span; shapeCloseSpan?: Span }>();
  const edges: BaseEdge[] = [];
  const protectedSpans: Span[] = [];
  const subgraphs: FlowGraph["subgraphs"] = [];
  let edgeOrder = 0;
  const nextEdgeId = createEdgeIdFactory("flow");
  const subgraphStack: { id: string; start: number; scopePath: string[] }[] = [];
  let hasLinkStyle = false;

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
      if (declared && !existing.declared) existing.declared = true;
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

  for (const statement of statements) {
    const trimmed = statement.text.trim();
    if (!trimmed || statement === header) continue;
    if (trimmed.startsWith("%%")) {
      protectedSpans.push(lineSpan(statement));
      continue;
    }
    if (/^subgraph\b/i.test(trimmed)) {
      const id = trimmed.replace(/^subgraph\s+/i, "").trim();
      subgraphStack.push({ id, start: statement.start, scopePath: subgraphStack.map((item) => item.id) });
      protectedSpans.push(lineSpan(statement));
      continue;
    }
    if (/^end$/i.test(trimmed)) {
      const open = subgraphStack.pop();
      if (open) subgraphs.push({ id: open.id, span: { start: open.start, end: statement.end }, scopePath: open.scopePath });
      protectedSpans.push(lineSpan(statement));
      continue;
    }
    if (/^linkStyle\b/i.test(trimmed)) hasLinkStyle = true;
    if (/^(?:click|style|classDef|class|linkStyle)\b/i.test(trimmed)) {
      protectedSpans.push(lineSpan(statement));
      continue;
    }

    const scopePath = subgraphStack.map((item) => item.id);
    const edgeStatement = parseFlowEdgeStatement(statement, edgeOrder, scopePath, nextEdgeId);
    if (edgeStatement?.kind === "error") return emptyParse("flowchart", edgeStatement.error);
    if (edgeStatement?.kind === "parsed") {
      edges.push(...edgeStatement.edges);
      edgeOrder += edgeStatement.edges.length;
      for (const nodeRef of edgeStatement.nodeRefs) {
        ensureNode(nodeRef.id, nodeRef.label, nodeRef.span, nodeRef.declared, nodeRef.labelSpan, nodeRef.shape, scopePath, nodeRef.shapeOpenSpan, nodeRef.shapeCloseSpan);
      }
      if (edgeStatement.edges.some((edge) => !edge.rewritable)) protectedSpans.push(lineSpan(statement));
      continue;
    }

    const leading = statement.text.search(/\S/);
    const nodeRef = leading >= 0 ? parseFlowNodeRef(statement.text.slice(leading), statement.start + leading) : null;
    if (nodeRef?.error) return emptyParse("flowchart", nodeRef.error);
    if (nodeRef && nodeRef.endOffset === statement.text.trimEnd().length - leading) {
      ensureNode(nodeRef.id, nodeRef.label, nodeRef.span, true, nodeRef.labelSpan, nodeRef.shape, subgraphStack.map((item) => item.id), nodeRef.shapeOpenSpan, nodeRef.shapeCloseSpan);
      if (nodeRef.unsupported) protectedSpans.push(lineSpan(statement));
      continue;
    }
    protectedSpans.push(lineSpan(statement));
  }
  for (const open of subgraphStack.splice(0).reverse()) {
    subgraphs.push({ id: open.id, span: { start: open.start, end: source.length }, scopePath: open.scopePath });
  }

  return {
    ok: true,
    model: { type: "flowchart", direction, nodes: [...nodes.values()], edges, subgraphs, hasLinkStyle },
    spanMap: { directives: [lineSpan(header)], protectedSpans },
  };
}

function parseFlowEdgeStatement(
  statement: LineInfo,
  orderIndex: number,
  scopePath: string[],
  nextEdgeId: EdgeIdFactory,
): null | {
  kind: "parsed";
  edges: BaseEdge[];
  nodeRefs: ParsedFlowNodeRef[];
} | {
  kind: "error";
  error: string;
} {
  const raw = stripTrailingComment(statement.text);
  const arrowMatches = findTopLevelFlowArrows(raw);
  if (arrowMatches.length === 0) return null;
  const firstArrow = arrowMatches[0]!;
  const leftGroup = parseFlowNodeGroup(raw.slice(0, firstArrow.index), statement.start);
  if (leftGroup?.kind === "error") return { kind: "error", error: leftGroup.error };
  if (!leftGroup) return null;

  const nodeRefs = [...leftGroup.refs];
  const edgeInputs: Array<{
    left: ParsedFlowNodeRef[];
    right: ParsedFlowNodeRef[];
    arrow: string;
    arrowSpan: Span;
    label?: string;
    labelSpan?: Span;
  }> = [];
  let previous = leftGroup.refs;
  for (let index = 0; index < arrowMatches.length; index += 1) {
    const match = arrowMatches[index]!;
    const next = arrowMatches[index + 1];
    const arrowSpec = parseFlowArrowToken(match.arrow);
    if (!arrowSpec) return null;
    const afterStart = match.index + match.arrow.length;
    const afterEnd = next?.index ?? raw.length;
    const after = raw.slice(afterStart, afterEnd);
    const labelMatch = after.match(/^\s*\|([^|\n]*)\|\s*/);
    const labelPrefixLength = labelMatch?.[0].length ?? 0;
    const rightGroup = parseFlowNodeGroup(after.slice(labelPrefixLength), statement.start + afterStart + labelPrefixLength);
    if (rightGroup?.kind === "error") return { kind: "error", error: rightGroup.error };
    if (!rightGroup) return null;
    const rawLabel = labelMatch?.[1];
    const labelLocalStart = rawLabel === undefined ? -1 : afterStart + labelMatch![0].indexOf("|") + 1;
    edgeInputs.push({
      left: previous,
      right: rightGroup.refs,
      arrow: match.arrow,
      arrowSpan: { start: statement.start + match.index, end: statement.start + match.index + match.arrow.length },
      ...(rawLabel ? { label: displayMermaidLabel(rawLabel) } : {}),
      ...(labelLocalStart >= 0 ? { labelSpan: { start: statement.start + labelLocalStart, end: statement.start + labelLocalStart + rawLabel!.length } } : {}),
    });
    nodeRefs.push(...rightGroup.refs);
    previous = rightGroup.refs;
  }

  const expandedEdgeCount = edgeInputs.reduce((count, input) => count + input.left.length * input.right.length, 0);
  const inSubgraph = scopePath.length > 0;
  // 链式边/多目标共享同一 stmt；现有回写按整条 stmt 操作，必须保持只读以免改一边误伤其余边。
  const safeRewriteStatement =
    expandedEdgeCount === 1 &&
    isWholeLineStatement(statement) &&
    !inSubgraph &&
    nodeRefs.every((nodeRef) => !nodeRef.unsupported) &&
    !/:::/i.test(raw) &&
    !/\[[^\]]*\]\s*[^\s-]/.test(raw.slice(0, firstArrow.index).trim().replace(leftGroup.refs[0]?.raw ?? "", ""));
  const edges: BaseEdge[] = [];
  for (const input of edgeInputs) {
    const arrowSpec = parseFlowArrowToken(input.arrow)!;
    for (const left of input.left) {
      for (const right of input.right) {
        const id = nextEdgeId({ source: left.id, target: right.id, syntaxKind: input.arrow, label: input.label || undefined });
        edges.push({
          id,
          source: left.id,
          target: right.id,
          ...(input.label ? { label: input.label } : {}),
          ...(input.labelSpan ? { labelSpan: input.labelSpan } : {}),
          syntaxKind: input.arrow,
          syntaxSpan: input.arrowSpan,
          direction: arrowSpec.direction,
          lineStyle: arrowSpec.lineStyle,
          orderIndex: orderIndex + edges.length,
          scopePath: [...scopePath],
          rewritable: safeRewriteStatement,
          stmt: lineSpan(statement),
        });
      }
    }
  }
  return {
    kind: "parsed",
    edges,
    nodeRefs,
  };
}

function findTopLevelFlowArrows(raw: string): Array<{ arrow: string; index: number }> {
  const arrows: Array<{ arrow: string; index: number }> = [];
  let quote: "'" | '"' | null = null;
  const bracketClosers: string[] = [];
  let inPipeLabel = false;
  for (let cursor = 0; cursor < raw.length; cursor += 1) {
    const char = raw[cursor]!;
    if (quote) {
      if (char === quote && raw[cursor - 1] !== "\\") quote = null;
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
    if (bracketClosers.length > 0 || inPipeLabel) continue;
    FLOW_ARROW_TOKEN_AT_RE.lastIndex = cursor;
    const match = FLOW_ARROW_TOKEN_AT_RE.exec(raw);
    if (!match) continue;
    arrows.push({ arrow: match[0], index: cursor });
    cursor += match[0].length - 1;
  }
  FLOW_ARROW_TOKEN_AT_RE.lastIndex = 0;
  return arrows;
}

function parseFlowNodeGroup(raw: string, absoluteStart: number): null | {
  kind: "parsed";
  refs: ParsedFlowNodeRef[];
} | {
  kind: "error";
  error: string;
} {
  const ranges: Array<{ start: number; end: number }> = [];
  let rangeStart = 0;
  let quote: "'" | '"' | null = null;
  const bracketClosers: string[] = [];
  for (let cursor = 0; cursor < raw.length; cursor += 1) {
    const char = raw[cursor]!;
    if (quote) {
      if (char === quote && raw[cursor - 1] !== "\\") quote = null;
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
    if (char === "&" && bracketClosers.length === 0) {
      ranges.push({ start: rangeStart, end: cursor });
      rangeStart = cursor + 1;
    }
  }
  ranges.push({ start: rangeStart, end: raw.length });

  const refs: ParsedFlowNodeRef[] = [];
  for (const range of ranges) {
    const part = raw.slice(range.start, range.end);
    const leading = part.search(/\S/);
    if (leading < 0) return null;
    const ref = parseFlowNodeRef(part.slice(leading), absoluteStart + range.start + leading);
    if (!ref) return null;
    if (ref.error) return { kind: "error", error: ref.error };
    refs.push(ref);
  }
  return refs.length > 0 ? { kind: "parsed", refs } : null;
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
    const sourceNode = model.nodes.find((n) => n.id === op.source);
    const targetNode = model.nodes.find((n) => n.id === op.target);
    if ((sourceNode && flowNodeTouchesSubgraph(model, sourceNode)) || (targetNode && flowNodeTouchesSubgraph(model, targetNode))) {
      return { ok: false, source, error: "subgraph 内节点连边不做语义编辑" };
    }
    return { ok: true, source: insertBeforeSourceEnd(source, `  ${op.source} -->${op.label ? `|${safeMermaidLabel(op.label)}|` : ""} ${op.target}\n`) };
  }
  if (op.kind === "deleteEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const edits = [{ ...lineRemovalSpan(source, edge.stmt), text: "" }];
    return { ok: true, source: applyFlowchartEditsPreservingInlineLabels(source, edits, [edge.stmt]) };
  }
  if (op.kind === "reconnectEdge") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const endpointError = reconnectEndpointError(model.nodes.map((n) => n.id), op);
    if (endpointError) return { ok: false, source, error: endpointError };
    const line = source.slice(edge.stmt.start, edge.stmt.end);
    const nextSource = op.newSource ?? edge.source;
    const nextTarget = op.newTarget ?? edge.target;
    const replacement = `  ${nextSource} ${edge.syntaxKind}${edge.label ? `|${safeMermaidLabel(edge.label)}|` : ""} ${nextTarget}${line.endsWith("\n") ? "\n" : ""}`;
    return { ok: true, source: applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: replacement }]) };
  }
  if (op.kind === "setEdgeLabel") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    const nextLabel = op.label.trim();
    const validationError = validateFlowEdgeLabel(nextLabel);
    if (validationError) return { ok: false, source, error: validationError };
    const rewrite = rewriteFlowEdgeLabel(source, edge, nextLabel);
    return rewrite ? { ok: true, source: rewrite } : { ok: false, source, error: "边标签无法干净回写" };
  }
  if (op.kind === "setEdgeArrow") {
    const edge = model.edges.find((e) => e.id === op.edgeId)!;
    if (!edge.syntaxSpan) return { ok: false, source, error: "边箭头无法干净回写" };
    const nextToken = flowArrowToken(op.direction, op.lineStyle ?? edge.lineStyle ?? "solid");
    return { ok: true, source: applyEdits(source, [{ start: edge.syntaxSpan.start, end: edge.syntaxSpan.end, text: nextToken }]) };
  }
  if (op.kind === "addNode") {
    const id = uniqueId(model.nodes.map((n) => n.id), safeMermaidId(op.label));
    return { ok: true, newNodeId: id, source: insertBeforeSourceEnd(source, `  ${id}["${safeMermaidLabel(op.label)}"]\n`) };
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
  const candidates = collectRemovedFlowInlineLabels(source, removedEdgeSpans);
  const nextSource = applyEdits(source, edits);
  if (candidates.size === 0) return nextSource;
  const reparsed = parseFlowchart(nextSource);
  if (!reparsed.ok) return nextSource;
  const nextModel = reparsed.model as FlowGraph;
  const declarations: string[] = [];
  for (const candidate of candidates.values()) {
    if (opts.excludeIds?.has(candidate.id)) continue; // 不复活被删的节点本身
    if (candidate.label === candidate.id) continue; // 没有可保留的 inline 标签
    const node = nextModel.nodes.find((item) => item.id === candidate.id);
    if (!node) {
      // 端点在"删节点"时随它的关联连边一起被带走了。删一个节点不应连带删掉
      // 只在被删连边里 inline 声明过的邻居节点,补回为孤立节点声明(否则删 B 会让
      // 只写在 `A-->B` 里的 A 一起消失 = 数据丢失,见 e2e R2 Lane B)。
      if (opts.preserveMissingEndpoints) declarations.push(`  ${formatFlowNodeDeclaration(candidate)}\n`);
      continue;
    }
    if (node.label !== node.id) continue; // 节点还在且标签没丢,无需补
    declarations.push(`  ${formatFlowNodeDeclaration(candidate)}\n`);
  }
  return declarations.length > 0 ? insertBeforeSourceEnd(nextSource, declarations.join("")) : nextSource;
}

function collectRemovedFlowInlineLabels(source: string, spans: Span[]): Map<string, ParsedFlowNodeRef> {
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
    if (!parsed || parsed.kind === "error") continue;
    for (const ref of parsed.nodeRefs) {
      if (!ref.declared || !ref.labelSpan || ref.label === ref.id) continue;
      out.set(ref.id, ref);
    }
  }
  return out;
}

function formatFlowNodeDeclaration(node: ParsedFlowNodeRef): string {
  const label = safeMermaidLabel(node.label);
  if (!node.shape || node.shape === "[") return `${node.id}["${label}"]`;
  const close = flowShapeClose(node.shape);
  return close ? `${node.id}${node.shape}${label}${close}` : `${node.id}["${label}"]`;
}

function flowShapeClose(open: string): string | null {
  if (open === "[[") return "]]";
  if (open === "[(") return ")]";
  if (open === "((") return "))";
  if (open === "([") return "])";
  if (open === "{{") return "}}";
  if (open === "[/") return "/]";
  if (open === "[\\") return "\\]";
  if (open === "(") return ")";
  if (open === "{") return "}";
  if (open === "[") return "]";
  return null;
}

function flowShapeSyntax(shape: FlowNodeShape): { open: string; close: string } | null {
  if (shape === "rect") return { open: "[", close: "]" };
  if (shape === "round") return { open: "(", close: ")" };
  if (shape === "stadium") return { open: "([", close: "])" };
  if (shape === "diamond") return { open: "{", close: "}" };
  if (shape === "circle") return { open: "((", close: "))" };
  if (shape === "hexagon") return { open: "{{", close: "}}" };
  if (shape === "parallelogram") return { open: "[/", close: "/]" };
  return null;
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

function parseFlowArrowToken(token: string): { direction: EdgeDirection; lineStyle: EdgeLineStyle } | null {
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
  let edgeOrder = 0;
  const nextEdgeId = createEdgeIdFactory("state");
  let inComposite = false;
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
    if (/^note\b|^state\s+\S+\s*\{|^state\s+\S+\s*<</i.test(trimmed) || /<<(?:choice|fork|join)>>/i.test(trimmed)) {
      protectedSpans.push(lineSpan(line));
      if (/\{/.test(trimmed)) inComposite = true;
      continue;
    }
    if (/^}$/.test(trimmed)) {
      inComposite = false;
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
        rewritable: !inComposite && !from.pseudo && !to.pseudo,
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
  }
  return { ok: true, model: { type: "state", nodes: [...nodes.values()], edges }, spanMap: { directives: [lineSpan(header)], protectedSpans } };
}

function stateCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as StateGraph;
  const edge = target?.edgeId ? model.edges.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.nodes.find((n) => n.id === target.nodeId) : undefined;
  return [
    cap("connectEdge", true),
    cap("deleteEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "transition 不可回写"),
    cap("reconnectEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "transition 不可回写"),
    cap("addNode", true),
    cap("deleteNode", !!node && node.hasStableId && node.kind === "state", "仅普通 state 可删除"),
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
    return { ok: true, source: applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: `  ${op.newSource ?? edge.source} --> ${op.newTarget ?? edge.target}${edge.label ? ` : ${edge.label}` : ""}${line.endsWith("\n") ? "\n" : ""}` }]) };
  }
  if (op.kind === "addNode") {
    const id = uniqueId(model.nodes.map((n) => n.id), safeMermaidId(op.label, "state"));
    return { ok: true, newNodeId: id, source: insertBeforeSourceEnd(source, `  state "${safeMermaidLabel(op.label)}" as ${id}\n`) };
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
  }
  return { ok: true, model: { type: "er", entities: [...entities.values()], rels }, spanMap: { directives: [lineSpan(header)], protectedSpans } };
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
    return { ok: true, source: applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: `  ${op.newSource ?? edge.source} ${edge.syntaxKind} ${op.newTarget ?? edge.target}${edge.label ? ` : ${edge.label}` : ""}${line.endsWith("\n") ? "\n" : ""}` }]) };
  }
  if (op.kind === "addNode") {
    const id = uniqueId(model.entities.map((n) => n.id), safeMermaidId(op.label, "entity").toUpperCase());
    return { ok: true, newNodeId: id, source: insertBeforeSourceEnd(source, `  ${id}\n`) };
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
  let order = 0;
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
  }
  return { ok: true, model: { type: "class", classes: [...classes.values()], rels }, spanMap: { directives: [lineSpan(header)], protectedSpans } };
}

function classCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
  const model = p.model as ClassGraph;
  const edge = target?.edgeId ? model.rels.find((e) => e.id === target.edgeId) : undefined;
  const node = target?.nodeId ? model.classes.find((n) => n.id === target.nodeId) : undefined;
  return [
    cap("connectEdge", true),
    cap("deleteEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("reconnectEdge", !!edge && edge.rewritable, edge?.rewritable ? undefined : "relationship 不可回写"),
    cap("addNode", true),
    cap("deleteNode", !!node && node.hasStableId && node.members.length === 0, node?.members.length ? "成员块 class 只读" : undefined),
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
    return { ok: true, source: applyEdits(source, [{ start: edge.stmt.start, end: edge.stmt.end, text: `  ${op.newSource ?? edge.source} ${edge.syntaxKind} ${op.newTarget ?? edge.target}${edge.label ? ` : ${edge.label}` : ""}${line.endsWith("\n") ? "\n" : ""}` }]) };
  }
  if (op.kind === "addNode") {
    const id = uniqueId(model.classes.map((n) => n.id), safeMermaidId(op.label, "Class"));
    return { ok: true, newNodeId: id, source: insertBeforeSourceEnd(source, `  class ${id}\n`) };
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

function parseMindmap(source: string): ParseResult {
  const lines = getLines(source);
  const header = lines.find((line) => /^\s*mindmap\b/.test(line.text));
  if (!header) return emptyParse("mindmap", "缺少 mindmap 头");
  const protectedSpans: Span[] = [];
  const stack: MindNode[] = [];
  let root: MindNode | null = null;
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
    const unsupported = /::|#|^icon\(/i.test(trimmed);
    if (unsupported) protectedSpans.push(lineSpan(line));
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
      label: parts.label,
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
    root = { id: "mind-root", label: "mindmap", line: lineSpan(header), indent: 0, children: [], hasStableId: true, parentId: null, scopePath: ["mindmap"], sourceRefs: [] };
  }
  return { ok: true, model: { type: "mindmap", root }, spanMap: { directives: [lineSpan(header)], protectedSpans } };
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
    const text = `${indent}${safeMermaidLabel(op.label)}\n`;
    const beforeIds = new Set(nodes.map((item) => item.id));
    const newSource = insertAtLineBoundary(source, insertAt, text);
    const reparsed = parseMindmap(newSource);
    const reparsedTree = reparsed.model as MindmapTree;
    const newNode = flattenMindmap(reparsedTree.root).find((n) => !beforeIds.has(n.id) && n.label === op.label && n.parentId === parent.id);
    return { ok: true, newNodeId: newNode?.id, source: newSource };
  }
  if (op.kind === "deleteNode") {
    const end = subtreeEnd(source, node!);
    const start = node!.line.start;
    const newSource = applyEdits(source, [{ start, end, text: "" }]);
    return mindmapRewriteResult(model, newSource, (oldLineStart) => {
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
      ? `${parts.id}${parts.open}${safeMermaidLabel(op.label)}${parts.close}`
      : safeMermaidLabel(op.label);
    const replacement = `${leading}${body}${newline}`;
    const newSource = applyEdits(source, [{ start: node!.line.start, end: node!.line.end, text: replacement }]);
    const lengthDelta = replacement.length - (node!.line.end - node!.line.start);
    return mindmapRewriteResult(model, newSource, (oldLineStart) => {
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
    return mindmapRewriteResult(model, newSource, (oldLineStart) => {
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
  oldModel: MindmapTree,
  newSource: string,
  mapLineStart: (oldLineStart: number) => number | null,
): RewriteResult {
  const reparsed = parseMindmap(newSource);
  if (!reparsed.ok || reparsed.model.type !== "mindmap") return { ok: true, source: newSource };

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
}

const FLOW_NODE_SHAPE_SYNTAX: Array<{ open: string; close: string }> = [
  { open: "[[", close: "]]" },
  { open: "[(", close: ")]" },
  { open: "((", close: "))" },
  { open: "([", close: "])" },
  { open: "{{", close: "}}" },
  { open: "[/", close: "/]" },
  { open: "[\\", close: "\\]" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
  { open: "{", close: "}" },
];

function parseFlowNodeRef(rawInput: string, absoluteStart: number): ParsedFlowNodeRef | null {
  const raw = rawInput.trim();
  const match = raw.match(/^([A-Za-z_][\p{L}\p{N}_-]*)(.*)$/u);
  if (!match) return null;
  const id = match[1]!;
  const rest = match[2] ?? "";
  let label = id;
  let labelSpan: Span | undefined;
  let shape: string | undefined;
  let shapeOpenSpan: Span | undefined;
  let shapeCloseSpan: Span | undefined;
  let unsupported = false;
  let endOffset = id.length;
  if (rest.trim()) {
    const restLeading = rest.search(/\S/);
    const r = rest.trim();
    const bracket = parseFlowShapeContent(r);
    const startsWithShape = FLOW_NODE_SHAPE_SYNTAX.some((syntax) => r.startsWith(syntax.open));
    if (!bracket && startsWithShape) {
      return {
        id,
        raw,
        label,
        span: { start: absoluteStart, end: absoluteStart + id.length },
        declared: false,
        unsupported: false,
        endOffset: id.length,
        error: `节点 ${id} 的形状未闭合`,
      };
    }
    if (bracket) {
      const rawLabel = stripQuotes(bracket.content);
      label = displayMermaidLabel(rawLabel);
      const quoteOffset = isQuoted(bracket.content) ? 1 : 0;
      const localOpenStart = id.length + restLeading;
      const localLabelStart = localOpenStart + bracket.open.length + quoteOffset;
      const localLabelEnd = localLabelStart + rawLabel.length;
      const localCloseStart = localOpenStart + bracket.closeStart;
      labelSpan = { start: absoluteStart + localLabelStart, end: absoluteStart + localLabelEnd };
      shapeOpenSpan = { start: absoluteStart + localOpenStart, end: absoluteStart + localOpenStart + bracket.open.length };
      shapeCloseSpan = { start: absoluteStart + localCloseStart, end: absoluteStart + localCloseStart + bracket.close.length };
      shape = bracket.open;
      endOffset = id.length + restLeading + bracket.totalLength;
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
    declared: !!labelSpan,
    unsupported,
    endOffset,
  };
}

function parseFlowShapeContent(raw: string): { open: string; close: string; content: string; closeStart: number; totalLength: number } | null {
  for (const syntax of FLOW_NODE_SHAPE_SYNTAX) {
    if (!raw.startsWith(syntax.open)) continue;
    const closeStart = raw.indexOf(syntax.close, syntax.open.length);
    if (closeStart < 0) return null;
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
  return { ok: false, error, model, spanMap: { directives: [], protectedSpans: [] } };
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
  return value.replace(/<br\s*\/?>/gi, "\n");
}

function stripTrailingComment(value: string): string {
  const idx = value.indexOf("%%");
  return idx >= 0 ? value.slice(0, idx) : value;
}

function isStableMermaidId(id: string): boolean {
  return /^[A-Za-z_][\p{L}\p{N}_-]*$/u.test(id);
}

function isStableStateId(id: string): boolean {
  return new RegExp(String.raw`^[\p{L}_][\p{L}\p{N}_-]*$`, "u").test(id);
}

function uniqueId(existing: Iterable<string>, base: string): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
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
  return !overlay.positions && !overlay.styles && !overlay.edgeStyles && !overlay.edgeHandles;
}

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}

function layoutNodes(nodes: BaseNode[], edges: BaseEdge[], overlay: DiagramOverlay | null | undefined): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  const roots = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  const ordered = roots.length ? [...roots, ...nodes.filter((node) => !roots.includes(node))] : nodes;
  ordered.forEach((node, index) => {
    const over = overlay?.positions?.[node.id];
    if (over && Number.isFinite(over.x) && Number.isFinite(over.y)) {
      out[node.id] = { x: over.x, y: over.y };
      return;
    }
    out[node.id] = { x: 40 + (index % 3) * 220, y: 36 + Math.floor(index / 3) * 130 };
  });
  return out;
}

function svgDefs(): string {
  return `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#8d7447"/></marker></defs>`;
}

const SVG_NODE_WIDTH = 160;
const SVG_NODE_HEIGHT = 64;
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

function wrapNodeLabel(label: string, fontSize: number): string[] {
  const maxWidth = SVG_NODE_WIDTH - 16;
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

function edgeGeometry(from: { x: number; y: number }, to: { x: number; y: number }) {
  const x1 = from.x + SVG_NODE_WIDTH;
  const y1 = from.y + SVG_NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + SVG_NODE_HEIGHT / 2;
  return { x1, y1, x2, y2, c1x: x1 + 40, c2x: x2 - 40 };
}

function graphSvgBounds(
  nodes: BaseNode[],
  edges: BaseEdge[],
  layout: Record<string, { x: number; y: number }>,
  overlay: DiagramOverlay | null | undefined,
): { minX: number; minY: number; width: number; height: number } {
  const bounds: SvgBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (minX: number, minY: number, maxX: number, maxY: number) => {
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minY = Math.min(bounds.minY, minY);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxY = Math.max(bounds.maxY, maxY);
  };
  for (const node of nodes) {
    const pos = layout[node.id]!;
    const stroke = typeof overlay?.styles?.[node.id]?.strokeWidth === "number" ? Math.max(1, Math.min(8, overlay.styles[node.id]!.strokeWidth!)) : 1.5;
    include(pos.x - stroke / 2, pos.y - stroke / 2, pos.x + SVG_NODE_WIDTH + stroke / 2, pos.y + SVG_NODE_HEIGHT + stroke / 2);
  }
  for (const edge of edges) {
    const from = layout[edge.source];
    const to = layout[edge.target];
    if (!from || !to) continue;
    const path = edgeGeometry(from, to);
    include(Math.min(path.x1, path.x2, path.c1x, path.c2x), Math.min(path.y1, path.y2), Math.max(path.x1, path.x2, path.c1x, path.c2x), Math.max(path.y1, path.y2));
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

function renderSvgNode(id: string, label: string, pos: { x: number; y: number }, style: NodeStyleOverride | undefined): string {
  const fill = sanitizeColor(style?.fill) ?? "#efe3cc";
  const stroke = sanitizeColor(style?.stroke) ?? "#b08a3e";
  const textColor = sanitizeColor(style?.textColor) ?? "#2f2a22";
  const strokeWidth = typeof style?.strokeWidth === "number" ? Math.max(1, Math.min(8, style.strokeWidth)) : 1.5;
  const fontSize = typeof style?.fontSize === "number" ? Math.max(9, Math.min(28, style.fontSize)) : 14;
  const lines = wrapNodeLabel(label, fontSize);
  const firstBaseline = pos.y + (lines.length === 1 ? 38 : 28);
  const text = lines.map((line, index) => `<tspan x="${pos.x + SVG_NODE_WIDTH / 2}" y="${firstBaseline + index * 18}">${escapeXml(line)}</tspan>`).join("");
  return `<g data-node-id="${escapeXml(id)}"><rect x="${pos.x}" y="${pos.y}" width="${SVG_NODE_WIDTH}" height="${SVG_NODE_HEIGHT}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/><text text-anchor="middle" font-size="${fontSize}" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${text}</text></g>`;
}

function renderSvgEdge(edge: BaseEdge, from: { x: number; y: number }, to: { x: number; y: number }, style: EdgeStyleOverride | undefined): string {
  const stroke = sanitizeColor(style?.stroke) ?? "#8d7447";
  const textColor = sanitizeColor(style?.textColor) ?? "#5c5346";
  const strokeWidth = typeof style?.strokeWidth === "number" ? Math.max(1, Math.min(8, style.strokeWidth)) : 1.4;
  const { x1, y1, x2, y2, c1x, c2x } = edgeGeometry(from, to);
  const label = edge.label
    ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="12" fill="${textColor}" font-family="${SVG_TEXT_FONT_FAMILY}">${escapeXml(edge.label)}</text>`
    : "";
  return `<g data-edge-id="${escapeXml(edge.id)}"><path d="M${x1} ${y1} C${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="url(#arrow)"/>${label}</g>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeColor(value: string | undefined): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{3,8}$/.test(value) || /^rgba?\([0-9.,\s]+\)$/.test(value) ? value : null;
}
