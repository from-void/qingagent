import { applyEdits, lineSpan } from "./flowchart.js";

import { flattenMindmap, insertAtLineBoundary, isMindmapDescendant, modelEdges, subtreeEnd } from "./overlay.js";

import { cap, decodeMermaidEntities, emptyParse, ensureCapability, getLines, hashText, unsupportedRewrite } from "./shared.js";

import { parseDiagramThemeMetadata, presentationSyntaxFullyRepresented } from "./theme.js";

import { Capability, EditOp, MindNode, MindmapTree, ParseResult, RewriteResult, Span } from "./types.js";



// 解析 mindmap 节点的形状语法,剥出 id 与显示文本。Mermaid mindmap 节点写法:
// `id((文本))` 圆形 / `id(文本)` 圆角 / `id[文本]` 方形 / `id))文本((` bang /
// `id)文本(` 云 / `id{{文本}}` 六边形;无包裹则整串既是 id 也是 label。
// 不剥离会导致根节点显示成字面量 `root((中心))`(见 e2e R1 Lane C 发现)。
export function unwrapMindmapNode(text: string): {
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

export function safeMindmapLabel(label: string): string {
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

export function displayMindmapLabel(value: string): string {
  // 先还原编码器生成的真实换行，再解实体；这样用户输入的字面量 `<br>`
  // 会以 `&lt;br&gt;` 往返，不会被误解码成换行。
  return decodeMermaidEntities(value.replace(/<br\s*\/?>/gi, "\n"));
}

export function parseMindmap(source: string): ParseResult {
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

export function mindmapCapabilities(p: ParseResult, target?: { nodeId?: string; edgeId?: string }): Capability[] {
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

export function rewriteMindmap(source: string, p: ParseResult, op: EditOp): RewriteResult {
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

export function mindmapRewriteResult(
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
