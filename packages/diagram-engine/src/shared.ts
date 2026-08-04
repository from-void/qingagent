import { countGraphemes, truncateGraphemes } from "@qingagent/contract-ts";

import { registry } from "./registry.js";

import { BaseEdge, BaseNode, Capability, ClassGraph, DiagramModel, DiagramType, EditOp, ErGraph, FlowGraph, MindmapTree, ParseResult, RewriteResult, Span, StateGraph } from "./types.js";



export type LineInfo = {
  text: string;
  start: number;
  end: number;
  bodyEnd: number;
  index: number;
  startsLine?: boolean;
  separator?: "\n" | ";";
};

export type Edit = { start: number; end: number; text: string };

export type EdgeIdInput = { source: string; target: string; syntaxKind: string; label?: string };

export type EdgeIdFactory = (input: EdgeIdInput) => string;

// 注意:`<---`/`<===` 必须排在 `<--`/`<==` 之前,否则会被短 token 先吃掉。
// 反向实线/粗线带 `|label|` 时,Mermaid 11 只接受 3 段长形(`<---`/`<===`),
// 短形 `<--|x|`/`<==|x|` 直接解析失败(已实测),故反向回写一律用长形(见 flowArrowToken)。
export const FLOW_ARROW_TOKEN_RE = /(?:<-.->|<-->|<==>|<---|<===|<-.-|<==|<--|-.->|==>|---|-.-|===|-->)/g;

export const MERMAID_ID_SOURCE = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_-]*`;

export const MAX_MERMAID_ID_GRAPHEMES = 64;

export const MERMAID_ID_LIST_SOURCE = String.raw`${MERMAID_ID_SOURCE}(?:\s*,\s*${MERMAID_ID_SOURCE})*`;

export const MERMAID_ID_RE = new RegExp(String.raw`^${MERMAID_ID_SOURCE}$`, "u");

export const FLOW_NODE_REF_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})(.*)$`, "u");

export const FLOW_SUBGRAPH_DECLARATION_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})\s*\[\s*(.*?)\s*\]\s*$`, "u");

export const CLASS_DEFINITION_RE = new RegExp(String.raw`^classDef\s+(${MERMAID_ID_LIST_SOURCE})\s+(.+?)\s*;?$`, "iu");

export const CLASS_ASSIGNMENT_RE = new RegExp(String.raw`^class\s+(${MERMAID_ID_LIST_SOURCE})\s+(${MERMAID_ID_SOURCE})\s*;?$`, "iu");

export const INLINE_STYLE_RE = new RegExp(String.raw`^style\s+(${MERMAID_ID_SOURCE})\s+(.+?)\s*;?$`, "iu");

export const INLINE_CLASS_RE = new RegExp(String.raw`:::(${MERMAID_ID_SOURCE})`, "gu");

export const FLOW_EDGE_ID_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})@`, "u");

export const MERMAID_ID_PREFIX_RE = new RegExp(String.raw`^(${MERMAID_ID_SOURCE})`, "u");

export const EDGE_OPS: EditOp["kind"][] = ["connectEdge", "deleteEdge", "reconnectEdge", "setEdgeLabel", "setEdgeArrow"];

export const NODE_OPS: EditOp["kind"][] = ["addNode", "deleteNode", "relabelNode", "setNodeShape"];

export const MINDMAP_OPS: EditOp["kind"][] = ["addNode", "deleteNode", "relabelNode", "moveNode", "setNodeShape", "setEdgeLabel"];

export function isQuoted(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
}

export function ensureCapability(p: ParseResult, op: EditOp, target?: { nodeId?: string; edgeId?: string }): { ok: true } | { ok: false; error: string } {
  const caps = registry[p.model.type].capabilities(p, target);
  const found = caps.find((c) => c.op === op.kind);
  if (found?.enabled) return { ok: true };
  return { ok: false, error: found?.reason ?? `${op.kind} 不可用于当前元素` };
}

export function connectEndpointError(existingIds: Iterable<string>, op: Extract<EditOp, { kind: "connectEdge" }>): string | null {
  const ids = new Set(existingIds);
  if (endpointMissing(ids, op.source) || endpointMissing(ids, op.target)) return "连接端点节点不存在";
  return null;
}

export function reconnectEndpointError(existingIds: Iterable<string>, op: Extract<EditOp, { kind: "reconnectEdge" }>): string | null {
  const ids = new Set(existingIds);
  if (op.newSource !== undefined && endpointMissing(ids, op.newSource)) return "重连目标节点不存在";
  if (op.newTarget !== undefined && endpointMissing(ids, op.newTarget)) return "重连目标节点不存在";
  return null;
}

export function endpointMissing(ids: Set<string>, value: string): boolean {
  return value.trim().length === 0 || !ids.has(value);
}

export function cap(op: EditOp["kind"], enabled: boolean, reason?: string): Capability {
  return enabled ? { op, enabled } : { op, enabled, reason: reason ?? "不可回写为 Mermaid 最小增量" };
}

export function edgeReason(edge: BaseEdge | undefined, hasLinkStyle: boolean): string | undefined {
  if (hasLinkStyle) return "source 含 linkStyle,拒绝维护边序号";
  if (!edge) return "边不存在";
  return edge.rewritable ? undefined : "该边不是简单单行语法";
}

export function flowDeleteNodeReason(model: FlowGraph, node: (BaseNode & { shape?: string }) | undefined): string | undefined {
  if (!node) return "节点不存在";
  if (!node.hasStableId) return "节点 id 不稳定";
  if (flowNodeTouchesSubgraph(model, node)) return "subgraph 内节点不做语义编辑";
  const relatedEdges = model.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  if (relatedEdges.some((edge) => !edge.rewritable)) return "节点关联不可回写边,拒绝删除";
  if (model.hasLinkStyle && relatedEdges.length > 0) return "source 含 linkStyle,拒绝维护边序号";
  return undefined;
}

export function flowNodeTouchesSubgraph(model: FlowGraph, node: BaseNode): boolean {
  return node.sourceRefs.some((ref) => model.subgraphs.some((subgraph) => spanContains(subgraph.span, ref)));
}

export function emptyParse(type: DiagramType, error: string): ParseResult {
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

export function withUnparsedLineError(result: ParseResult, line: LineInfo): ParseResult {
  const sourceText = line.text.trim();
  return {
    ...result,
    ok: false,
    fullyRepresented: false,
    error: `无法解析第 ${line.index + 1} 行: ${sourceText}`,
    errorSpan: { start: line.start, end: line.bodyEnd },
  };
}

export function getLines(source: string): LineInfo[] {
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

export function dedupeEdits(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function insertBeforeSourceEnd(source: string, text: string): string {
  if (!source.endsWith("\n")) return `${source}\n${text}`;
  return `${source}${text}`;
}

export function unsupportedRewrite(source: string, op: string): RewriteResult {
  return { ok: false, source, error: `${op} 不支持当前图类型` };
}

export function createEdgeIdFactory(prefix: string): EdgeIdFactory {
  const seen = new Map<string, number>();
  return (input) => {
    const key = edgeIdentityKey(input);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return edgeId(prefix, input, occurrence);
  };
}

export function edgeIdentityKey(input: EdgeIdInput): string {
  return JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null]);
}

export function edgeId(prefix: string, input: EdgeIdInput, occurrence: number): string {
  return `${prefix}-edge-${hashText(JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null, occurrence]))}`;
}

export function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function displayMermaidLabel(value: string): string {
  return decodeMermaidEntities(value)
    .replace(/\\+(["'\\])/g, "$1")
    .replace(/^`([\s\S]*)`$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n");
}

export function decodeMermaidEntities(value: string): string {
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

export function stripTrailingComment(value: string): string {
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

export function isStableMermaidId(id: string): boolean {
  return MERMAID_ID_RE.test(id);
}

export function isStableStateId(id: string): boolean {
  return MERMAID_ID_RE.test(id);
}

export function uniqueId(existing: Iterable<string>, base: string): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

export function boundedUniqueMermaidId(
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

export function spanContains(container: Span, inner: Span): boolean {
  return container.start <= inner.start && inner.end <= container.end;
}
