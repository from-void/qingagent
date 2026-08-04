import { safeMermaidId, safeMermaidLabel } from "./mermaid.js";

import { addedNodeRewriteResult, edgeRewriteResult } from "./overlay.js";

import { EdgeIdFactory, Edit, FLOW_ARROW_TOKEN_RE, FLOW_EDGE_ID_RE, FLOW_NODE_REF_RE, FLOW_SUBGRAPH_DECLARATION_RE, INLINE_CLASS_RE, LineInfo, boundedUniqueMermaidId, cap, connectEndpointError, createEdgeIdFactory, dedupeEdits, displayMermaidLabel, edgeReason, emptyParse, ensureCapability, flowDeleteNodeReason, insertBeforeSourceEnd, isQuoted, isStableMermaidId, reconnectEndpointError, spanContains, stripQuotes, stripTrailingComment, unsupportedRewrite, withUnparsedLineError } from "./shared.js";

import { appendNodeClasses, parseDiagramThemeMetadata, presentationSyntaxFullyRepresented } from "./theme.js";

import { BaseEdge, BaseNode, Capability, EdgeDirection, EdgeLineStyle, EdgeMarkerKind, EditOp, FlowGraph, FlowNodeShape, FlowShapeGeometry, ParseResult, RewriteResult, Span } from "./types.js";



export function parseFlowchart(source: string): ParseResult {
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

export function parseFlowSubgraphDeclaration(raw: string): { id: string; label: string } {
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

export function parseFlowEdgeLine(
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

export function isSafeFlowEdgeRewrite(
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

export type ParsedFlowLink = {
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

export const FLOW_DIRECT_LINK_TOKENS = [
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

export function parseFlowEdgeStatement(
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

export function parseFlowNodeSet(
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

export function parseFlowLinkAt(raw: string, offset: number): ParsedFlowLink | null {
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

export function skipWhitespace(value: string, offset: number): number {
  let cursor = offset;
  while (cursor < value.length && /\s/.test(value[cursor]!)) cursor += 1;
  return cursor;
}

export function flowEdgeMarkers(token: string, direction: EdgeDirection): { sourceMarker: EdgeMarkerKind; targetMarker: EdgeMarkerKind } {
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

export function flowLinkMinLength(token: string): number {
  if (token === "~~~") return 1;
  if (token.includes(".")) return Math.max(1, (token.match(/\./g) ?? []).length);
  if (token.includes("=")) {
    const count = (token.match(/=/g) ?? []).length;
    return Math.max(1, count - (token.endsWith(">") ? 1 : 2));
  }
  const count = (token.match(/-/g) ?? []).length;
  return Math.max(1, count - (token.endsWith(">") ? 1 : 2));
}

export function flowchartCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
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

export function rewriteFlowchart(source: string, p: ParseResult, op: EditOp): RewriteResult {
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

export function applyFlowchartEditsPreservingInlineLabels(
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

export function collectRemovedFlowInlineLabels(
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

export function formatFlowNodeDeclaration(node: ParsedFlowNodeRef): string {
  const label = safeMermaidLabel(node.label);
  // 裸 id 端点补回时仍写成裸 id,不给它凭空造一个标签。
  if (node.label === node.id && (!node.shape || node.shape === "[")) return node.id;
  if (!node.shape || node.shape === "[") return `${node.id}["${label}"]`;
  const syntax = flowShapeSyntax(normalizeFlowShapeName(node.shape));
  return syntax ? `${node.id}${syntax.open}${label}${syntax.close}` : `${node.id}["${label}"]`;
}

export function flowShapeSyntax(shape: FlowNodeShape): { open: string; close: string } | null {
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

export const FLOW_SHAPE_ALIASES: Record<string, FlowNodeShape> = {
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

export function validateFlowEdgeLabel(label: string): string | null {
  if (/[|\r\n]/.test(label)) return "边标签不能包含竖线或换行";
  return null;
}

export function rewriteFlowEdgeLabel(source: string, edge: BaseEdge, label: string): string | null {
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

export function flowEmbeddedEdgeLinkSpan(source: string, edge: BaseEdge): Span | null {
  if (!edge.labelSpan || !edge.syntaxSpan || edge.labelSpan.end > edge.syntaxSpan.start) return null;
  const beforeLabel = source.slice(edge.stmt.start, edge.labelSpan.start);
  const prefix = beforeLabel.match(/(?:--|-\.|==)\s*$/);
  if (!prefix || prefix.index === undefined) return null;
  return {
    start: edge.stmt.start + prefix.index,
    end: edge.syntaxSpan.end,
  };
}

export function parseFlowArrowToken(token: string): { direction: EdgeDirection; lineStyle: EdgeLineStyle } | null {
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

export function flowArrowToken(direction: EdgeDirection, lineStyle: EdgeLineStyle): string {
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

export interface ParsedFlowNodeRef {
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

export const FLOW_NODE_SHAPE_SYNTAX: Array<{ open: string; close: string }> = [
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

export function parseFlowNodeRef(rawInput: string, absoluteStart: number): ParsedFlowNodeRef | null {
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

export function flowBracketShapeKey(open: string, close: string): string {
  if (open === "[/" && close === "\\]") return "trapezoid";
  if (open === "[\\" && close === "/]") return "trapezoid-alt";
  return open;
}

export function parseFlowShapeContent(raw: string): { open: string; close: string; content: string; closeStart: number; totalLength: number } | null {
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

export function findFlowShapeClose(raw: string, start: number, close: string): number {
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

export function parseFlowAttributeShape(raw: string): { shape: string; label?: string; totalLength: number } | null {
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

export function findBalancedBraceEnd(raw: string, openIndex: number): number {
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

// Mermaid 的换行总是语句边界；分号只在节点形状、引号、边标签和注释之外切分。
// 每条语句保留绝对 offset 及分隔符，供节点/边 overlay 与安全回写判断使用。
export function getFlowchartStatements(source: string): LineInfo[] {
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

export function flowBracketCloser(char: string): "]" | ")" | "}" | null {
  if (char === "[") return "]";
  if (char === "(") return ")";
  if (char === "{") return "}";
  return null;
}

export function closeFlowBracket(closers: string[], char: string): void {
  const matchingOpen = closers.lastIndexOf(char);
  if (matchingOpen >= 0) closers.length = matchingOpen;
}

export function lineSpan(line: LineInfo): Span {
  return { start: line.start, end: line.end };
}

export function isWholeLineStatement(statement: LineInfo): boolean {
  return statement.startsLine !== false && statement.separator !== ";";
}

export function lineRemovalSpan(source: string, span: Span): Span {
  let start = span.start;
  let end = span.end;
  while (start > 0 && source[start - 1] !== "\n") start -= 1;
  if (end < source.length && source[end] === "\n") end += 1;
  return { start, end };
}

export function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
