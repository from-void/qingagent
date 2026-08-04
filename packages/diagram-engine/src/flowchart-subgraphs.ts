import { parseDiagram } from "./parser.js";

import { ParsedFlowNodeRef, applyEdits, flowShapeSyntax, normalizeFlowShapeName, parseFlowNodeRef, parseFlowchart } from "./flowchart.js";

import { safeMermaidId, safeMermaidLabel } from "./mermaid.js";

import { Edit, INLINE_STYLE_RE, LineInfo, MERMAID_ID_PREFIX_RE, getLines, insertBeforeSourceEnd, isStableMermaidId, stripTrailingComment, uniqueId, unsupportedRewrite } from "./shared.js";

import { samePath, sanitizeColor } from "./presentation.js";

import { splitStyleDeclarations } from "./theme.js";

import { FlowGraph, FlowSubgraph, NodeStyleOverride, ParseResult, RewriteResult, Span } from "./types.js";



export type PreparedFlowchartRewrite = {
  source: string;
  parsed: ParseResult & { model: FlowGraph };
};

export function prepareFlowchartRewrite(source: string, operation: string): PreparedFlowchartRewrite | RewriteResult {
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

export type FlowSourceLine = LineInfo & {
  indent: string;
  bodyStart: number;
  bodyEnd: number;
};

export type FlowNodeRelocation =
  | { ok: true; edits: Edit[]; declarations: string[] }
  | { ok: false; error: string };

export function preferredLineEnding(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

export function completeOpenFlowSubgraphs(source: string, model: FlowGraph): string {
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

export function sourceInsertionPrefix(source: string, insertionAt: number): string {
  if (insertionAt <= 0 || source[insertionAt - 1] === "\n") return "";
  return preferredLineEnding(source);
}

export function sourceLineAt(lines: LineInfo[], offset: number): LineInfo | undefined {
  return lines.find((line) => offset >= line.start && offset < Math.max(line.end, line.start + 1));
}

export function flowSourceLine(line: LineInfo): FlowSourceLine {
  const indent = line.text.match(/^\s*/)?.[0].replace(/\r$/, "") ?? "";
  const bodyEnd = line.text.endsWith("\r") ? line.bodyEnd - 1 : line.bodyEnd;
  return { ...line, indent, bodyStart: line.start, bodyEnd };
}

export function parseFlowNodeRefAtSource(source: string, lines: LineInfo[], ref: Span): {
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

export function collectFlowNodeRelocation(source: string, nodes: FlowGraph["nodes"]): FlowNodeRelocation {
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

export function formatFlowModelNodeDeclaration(node: FlowGraph["nodes"][number]): string {
  const syntax = flowShapeSyntax(normalizeFlowShapeName(node.shape));
  const label = `"${safeMermaidLabel(node.label)}"`;
  return syntax
    ? `${node.id}${syntax.open}${label}${syntax.close}`
    : `${node.id}[${label}]`;
}

export function findInlineSubgraphWrapRange(
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

export function flowSubgraphDeclarationLine(source: string, subgraph: FlowSubgraph): FlowSourceLine | null {
  const line = sourceLineAt(getLines(source), subgraph.span.start);
  if (!line || !/^\s*subgraph\b/i.test(line.text)) return null;
  return flowSourceLine(line);
}

export function flowSubgraphClosingLine(source: string, subgraph: FlowSubgraph): FlowSourceLine | null {
  const lines = getLines(source)
    .filter((line) => line.start >= subgraph.span.start && line.end <= subgraph.span.end)
    .reverse();
  const line = lines.find((candidate) => /^\s*end\s*$/i.test(candidate.text));
  return line ? flowSourceLine(line) : null;
}

export function flowSubgraphLabelSpan(line: FlowSourceLine, subgraphId: string): Span | null {
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

export function flowScopeContentIndent(
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

export function verifyFlowSubgraphRewrite(
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

export /**
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
