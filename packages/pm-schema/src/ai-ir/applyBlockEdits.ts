import { safeParsePmDoc } from "../validators";
import { getDeterministicId, getPmContentHash } from "../hash";
import type {
  PmBlockNode,
  PmDiagramOverlay,
  PmDoc,
  PmListItemNode,
  PmNode,
  PmTableCellNode,
  PmTableNode,
  PmTableRowNode,
  PmTaskItemNode,
} from "../types";
import { compileAiDocumentToPm } from "./aiIrToPm";
import type { AiBlock } from "./aiIrSchema";
import { allocateMaterializedBlockIds, isGeneratedAiBlockId } from "./draftBlockIds";

export type ListItemDraft = {
  runs?: unknown[];
  children?: unknown[];
  checked?: boolean;
};

export type TableCellDraft = {
  blocks?: unknown[];
  header?: boolean;
  backgroundColor?: string;
  colspan?: number;
  rowspan?: number;
};

type ListBlockNode = Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>;
type ListItemNode = PmListItemNode | PmTaskItemNode;

// editDraft 的「块级」编辑(文本级 replaceText/markText 在 host 侧另走 runs 匹配器,不在此)。
// block 接受 unknown,由 compileAiDocumentToPm 内部按 aiBlockSchema 校验并报块级错。
export type BlockEdit =
  | { action: "replaceBlock"; ref: string; block: AiBlock | unknown }
  | { action: "insertBlock"; position: "after" | "before" | "start" | "end"; ref?: string; blocks: readonly (AiBlock | unknown)[] }
  | { action: "deleteBlock"; ref: string }
  | { action: "replaceListItem"; ref: string; item: ListItemDraft | unknown }
  | { action: "insertListItem"; parentRef: string; at: "before" | "after" | "start" | "end"; ref?: string; item: ListItemDraft | unknown }
  | { action: "deleteListItem"; ref: string }
  | { action: "insertTableRow"; ref: string; at: "before" | "after" | "end"; rowIndex?: number; cells?: readonly (TableCellDraft | unknown)[] }
  | { action: "insertTableColumn"; ref: string; at: "before" | "after" | "end"; columnIndex?: number; cells?: readonly (TableCellDraft | unknown)[] }
  | { action: "deleteTableRow"; ref: string; rowIndex: number }
  | { action: "deleteTableColumn"; ref: string; columnIndex: number };

export interface ApplyBlockEditsResult {
  ok: boolean;
  /** 成功时为新草稿 doc;失败时为 null(原 doc 由调用方持有、绝不被改动 —— 纯函数,天然原子) */
  doc: PmDoc | null;
  /** 改动块的 ref:replaceBlock 保留原 ref;insertBlock 为新块的新 ref;deleteBlock 为被删 ref */
  applied: string[];
  /** insertBlock 因与插入位紧邻内容重复而整条跳过的 op 数。 */
  skippedDuplicateInserts: number;
  error?: string;
  /** 失败发生在第几个 op(从 0 起) */
  failedOpIndex?: number;
}

class OpError extends Error {
  constructor(
    public readonly opIndex: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 把一组「块级」编辑应用到原草稿 doc,产出新 doc。语义(设计 §6 / §7.2):
 * - 顶层 replace/insert/delete 的 ref 按**原 doc 快照**解析;
 * - 列表行级与表格行列级 op 在顶层块变更后应用,同类 op 保持声明顺序;
 *   表格后续 rowIndex/columnIndex 以前序表格 op 应用后的当前表为准;
 * - `replaceBlock`:编译新 AI-IR 块,**保留原 blockId**(ref 稳定 + buildDraftDiff 按 id 干净对齐成单 replace hunk);
 * - `insertBlock`:新块在插入边界 materialize 成真实 block-* ref;
 * - `deleteBlock`:移除;
 * - **未触碰的块:复用原 PmDoc 节点**(blockId / attrs / 高亮颜色 / 图片尺寸全留 —— 不变量 #3);
 * - 任一 op 失败(ref 不存在 / AI-IR 非法 / 结果不过 schema)→ 整组失败、`doc=null`,调用方不动草稿。
 */
export function applyBlockEdits(originalDoc: PmDoc, ops: readonly BlockEdit[]): ApplyBlockEditsResult {
  const nodes = originalDoc.content;
  const indexByRef = new Map<string, number>();
  nodes.forEach((node, i) => indexByRef.set(node.attrs.blockId, i));
  const listItemOps: Array<{ op: Extract<BlockEdit, { action: "replaceListItem" | "insertListItem" | "deleteListItem" }>; opIndex: number }> = [];
  const tableOps: Array<{ op: Extract<BlockEdit, { action: "insertTableRow" | "insertTableColumn" | "deleteTableRow" | "deleteTableColumn" }>; opIndex: number }> = [];

  const replaceAt = new Map<number, PmBlockNode>();
  const deleteAt = new Set<number>();
  const insertBefore = new Map<number, PmBlockNode[]>();
  const insertAfter = new Map<number, PmBlockNode[]>();
  const prepend: PmBlockNode[] = [];
  const append: PmBlockNode[] = [];
  const applied: string[] = [];
  const usedInsertIds = new Set(nodes.map((node) => node.attrs.blockId));
  let insertOccurrence = 0;
  let skippedDuplicateInserts = 0;

  const compileBlocks = (blocks: readonly unknown[], opIndex: number): PmBlockNode[] => {
    const result = compileAiDocumentToPm({ blocks });
    if (!result.ok || !result.doc) {
      const errors = result.blockErrors.map((e) => `block ${e.index}: ${e.message}`);
      errors.push(...incomingBlockContractHints(blocks));
      throw new OpError(opIndex, [...new Set(errors)].join("; "));
    }
    return result.doc.content;
  };

  try {
    ops.forEach((op, opIndex) => {
      switch (op.action) {
        case "replaceBlock": {
          const idx = indexByRef.get(op.ref);
          if (idx === undefined) throw new OpError(opIndex, `块 ${op.ref} 不存在,请先 readDraft`);
          const compiled = compileBlocks([op.block], opIndex);
          if (compiled.length !== 1) throw new OpError(opIndex, "replaceBlock 期望单个块");
          assertMergedTableColwidthReplaceSafe(nodes[idx]!, opIndex, op.ref);
          // 保留原 blockId，并把临时 ai-block-* 后代深度 materialize 到最终 ref 命名空间；
          // 否则 table 顶层转正后，cell 多块后代仍可能沿用临时前缀或与另一张相同表撞 id。
          const replacement = materializeAnchoredReplacement(compiled[0]!, op.ref, {
            existingIds: collectBlockIdsExcluding(nodes, idx),
          });
          replaceAt.set(
            idx,
            carryOverDiagramOverlay(
              nodes[idx]!,
              carryOverTableColwidth(nodes[idx]!, carryOverTableHeader(nodes[idx]!, replacement)),
            ),
          );
          applied.push(op.ref);
          break;
        }
        case "deleteBlock": {
          const idx = indexByRef.get(op.ref);
          if (idx === undefined) throw new OpError(opIndex, `块 ${op.ref} 不存在,请先 readDraft`);
          deleteAt.add(idx);
          applied.push(op.ref);
          break;
        }
        case "insertBlock": {
          let compiled = compileBlocks(op.blocks, opIndex);
          let insertIdx: number | undefined;
          if (op.position === "after" || op.position === "before") {
            if (op.ref === undefined) throw new OpError(opIndex, "insertBlock after/before 需要 ref");
            insertIdx = indexByRef.get(op.ref);
            if (insertIdx === undefined) throw new OpError(opIndex, `块 ${op.ref} 不存在,请先 readDraft`);
            // BB② 幂等护栏:跨调用累积候选时,同一条 insert after/before R 可能被重复作用
            // 两次(模型同轮分两步各发一次 / 重发),在插入位旁留下完全相同的相邻块(线上偶发重复
            // heading)。只要本 op 的任一块与插入位紧邻一侧已有块内容哈希相同,整条 insert op
            // all-or-nothing 跳过,避免旧的逐块 filter 把多块插入过滤成乱序残块。比较前
            // stripBlockIds 排除 blockId 干扰。分隔线/空段/内容不同的块一律放过。
            const neighborIdx = op.position === "after" ? insertIdx + 1 : insertIdx - 1;
            const neighbor = nodes[neighborIdx];
            if (neighbor && isContentBearingBlock(neighbor)) {
              const neighborHash = getPmContentHash(stripBlockIds(neighbor));
              const hasDuplicateNeighbor = compiled.some(
                (block) =>
                  isContentBearingBlock(block) &&
                  getPmContentHash(stripBlockIds(block)) === neighborHash,
              );
              if (hasDuplicateNeighbor) {
                skippedDuplicateInserts++;
                break;
              }
            }
          }
          const materialized = allocateMaterializedBlockIds(compiled, {
            namespace: "editDraft.insert",
            existingIds: usedInsertIds,
            occurrence: insertOccurrence,
          });
          insertOccurrence = materialized.nextOccurrence;
          for (const id of materialized.ids) usedInsertIds.add(id);
          if (op.position === "start") {
            prepend.push(...materialized.nodes);
          } else if (op.position === "end") {
            append.push(...materialized.nodes);
          } else {
            const bucket = op.position === "after" ? insertAfter : insertBefore;
            const arr = bucket.get(insertIdx!) ?? [];
            arr.push(...materialized.nodes);
            bucket.set(insertIdx!, arr);
          }
          applied.push(...materialized.ids);
          break;
        }
        case "replaceListItem":
        case "insertListItem":
        case "deleteListItem": {
          listItemOps.push({ op, opIndex });
          break;
        }
        case "insertTableRow":
        case "insertTableColumn":
        case "deleteTableRow":
        case "deleteTableColumn": {
          tableOps.push({ op, opIndex });
          break;
        }
      }
    });

    const out: PmBlockNode[] = [...prepend];
    nodes.forEach((node, i) => {
      out.push(...(insertBefore.get(i) ?? []));
      if (!deleteAt.has(i)) out.push(replaceAt.get(i) ?? node);
      out.push(...(insertAfter.get(i) ?? []));
    });
    out.push(...append);

    // 只校验、不替换:normalizePmDoc 返回的是 Zod parse 克隆,会把未触碰块也换成
    // 新对象,破坏「未触碰块复用原 PmDoc 节点」不变量 #3(fuzz seed 0x5137a9ba)。
    // 各来源节点均已规范化:replaceBlock/insertBlock 走过 compileAiDocumentToPm
    // 内部的 normalizePmDoc,未触碰块来自合法原 doc。
    const doc: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: originalDoc.attrs.schemaVersion },
      content: out,
    };
    const withListItems = applyListItemEdits(doc, listItemOps);
    applied.push(...withListItems.applied);
    const withTables = applyTableEdits(withListItems.doc, tableOps);
    applied.push(...withTables.applied);

    const parsed = safeParsePmDoc(withTables.doc);
    if (!parsed.success) throw new Error(`结果未过 pmDocSchema: ${parsed.error.message}`);
    assertUniqueBlockIds(withTables.doc);

    return { ok: true, doc: withTables.doc, applied, skippedDuplicateInserts };
  } catch (err) {
    if (err instanceof OpError) {
      return {
        ok: false,
        doc: null,
        applied: [],
        skippedDuplicateInserts: 0,
        error: err.message,
        failedOpIndex: err.opIndex,
      };
    }
    return {
      ok: false,
      doc: null,
      applied: [],
      skippedDuplicateInserts: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function materializeAnchoredReplacement(
  node: PmBlockNode,
  blockId: string,
  opts: { existingIds: ReadonlySet<string> },
): PmBlockNode {
  const rebased = rebaseBlockIdPrefixDeep(node, node.attrs.blockId, blockId);
  const materialized = materializeGeneratedBlockIdsDeep(rebased, {
    namespace: `editDraft.replaceBlock:${blockId}`,
    existingIds: opts.existingIds,
  }).node;
  // anchored replace 的锚点 ref 必须原样保留；深度 materialize 只负责后代临时 ID。
  return { ...materialized, attrs: { ...materialized.attrs, blockId } } as PmBlockNode;
}

function rebaseBlockIdPrefixDeep<T extends PmNode>(node: T, oldPrefix: string, newPrefix: string): T {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const attrs = record.attrs && typeof record.attrs === "object" && !Array.isArray(record.attrs)
      ? record.attrs as Record<string, unknown>
      : null;
    const currentId = attrs?.blockId;
    const nextAttrs = typeof currentId === "string" && currentId.startsWith(oldPrefix)
      ? { ...attrs, blockId: `${newPrefix}${currentId.slice(oldPrefix.length)}` }
      : attrs;
    return {
      ...record,
      ...(nextAttrs ? { attrs: nextAttrs } : {}),
      ...(Array.isArray(record.content) ? { content: record.content.map(rewrite) } : {}),
    };
  };
  return rewrite(node) as T;
}

// 取表格单元格递归纯文字，用于比对含列表/待办等多块表头标签是否仍保留。
function tableCellText(cell: { content: PmBlockNode[] }): string {
  const text: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") text.push(record.text);
    visit(record.content);
  };
  visit(cell.content);
  return text.join("").trim();
}

// editDraft 改表(replaceBlock)时,模型常重生成整张表却丢掉表头行的 header 标记
// (tableHeader→tableCell)→ 渲染丢 thead、导出丢表头。这里用"旧表首行本是表头"这一
// **已存在的结构信号**(模型本就在编辑该表),在新表完全没有表头单元格时,把新表首行确定性
// 还原为 tableHeader。这是"基于已有信号的机械保留",不是凭空臆造表结构。
// 三重保守门,尽量只命中"模型忘标表头"而非"用户有意删表头/重构":
//   ① 旧表首行本是表头;② 新表完全无任何表头单元格(模型若显式标了表头则尊重);
//   ③ 新表首行仍保留着至少一个旧表头标签文字(加列/调整时标签仍在=确为同一表头行,
//      只是丢了标记;若首行内容已实质改变=用户可能有意删表头/换内容,则尊重模型不强还原)。
function carryOverTableHeader(oldNode: PmBlockNode, newNode: PmBlockNode): PmBlockNode {
  if (oldNode.type !== "table" || newNode.type !== "table") return newNode;
  const oldFirstRow = oldNode.content[0];
  const oldFirstRowIsHeader =
    !!oldFirstRow &&
    oldFirstRow.content.length > 0 &&
    oldFirstRow.content.every((cell) => cell.type === "tableHeader");
  if (!oldFirstRowIsHeader) return newNode;
  const newHasAnyHeader = newNode.content.some((row) =>
    row.content.some((cell) => cell.type === "tableHeader"),
  );
  if (newHasAnyHeader) return newNode;
  const newFirstRow = newNode.content[0];
  if (!newFirstRow || newFirstRow.content.length === 0) return newNode;
  const oldHeaderLabels = new Set(
    oldFirstRow.content.map(tableCellText).filter((t) => t.length > 0),
  );
  const newFirstRowKeepsAHeaderLabel = newFirstRow.content.some((cell) =>
    oldHeaderLabels.has(tableCellText(cell)),
  );
  if (!newFirstRowKeepsAHeaderLabel) return newNode;
  return {
    ...newNode,
    content: newNode.content.map((row, rowIndex) =>
      rowIndex === 0
        ? {
            ...row,
            content: row.content.map((cell) => ({ ...cell, type: "tableHeader" as const })),
          }
        : row,
    ),
  };
}

function tableHasSpan(table: PmTableNode): boolean {
  return table.content.some((row) => row.content.some((cell) =>
    (cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1,
  ));
}

function tableHasColwidth(table: PmTableNode): boolean {
  return table.content.some((row) => row.content.some((cell) =>
    Array.isArray(cell.attrs?.colwidth) && cell.attrs.colwidth.length > 0,
  ));
}

function assertMergedTableColwidthReplaceSafe(
  oldNode: PmBlockNode,
  opIndex: number,
  ref: string,
): void {
  if (oldNode.type !== "table") return;
  if (!tableHasSpan(oldNode) || !tableHasColwidth(oldNode)) return;
  throw new OpError(
    opIndex,
    `表格 ${ref} 含合并单元格及列宽；为保护合并单元格表格的列宽，replaceBlock 暂不支持，第五批解禁`,
  );
}

// AI-IR 不表达像素列宽。普通表 replaceBlock 时按物理行/列位置机械带回旧 colwidth：
// 同列数完整保留；列数变化时保留可对应前缀，新增列写 null。若新 cell 自带宽度则尊重它。
// 合并表需要逻辑网格映射，带宽度者已由上面的临时门控拒绝；无宽度者无需 carry-over。
function carryOverTableColwidth(oldNode: PmBlockNode, newNode: PmBlockNode): PmBlockNode {
  if (oldNode.type !== "table" || newNode.type !== "table") return newNode;
  if (tableHasSpan(oldNode)) return newNode;
  return {
    ...newNode,
    content: newNode.content.map((row, rowIndex) => ({
      ...row,
      content: row.content.map((cell, cellIndex) => {
        if (cell.attrs?.colwidth !== undefined) return cell;
        const oldCell = oldNode.content[rowIndex]?.content[cellIndex];
        const oldWidth = oldCell?.attrs?.colwidth;
        const newHasSpan = (cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1;
        const colwidth = !newHasSpan && Array.isArray(oldWidth) ? [...oldWidth] : null;
        return { ...cell, attrs: { ...cell.attrs, colwidth } };
      }),
    })),
  };
}

function carryOverDiagramOverlay(oldNode: PmBlockNode, newNode: PmBlockNode): PmBlockNode {
  if (oldNode.type !== "diagram" || newNode.type !== "diagram") return newNode;
  const overlay = oldNode.attrs.overlay;
  if (!overlay) return newNode;
  const oldIds = extractDiagramStableIds(oldNode.attrs.source);
  const newIds = extractDiagramStableIds(newNode.attrs.source);
  const nodeIds = intersect(oldIds.nodes, newIds.nodes);
  const edgeIds = intersect(oldIds.edges, newIds.edges);
  const nextOverlay: PmDiagramOverlay = {
    positions: filterRecord(overlay.positions ?? undefined, nodeIds),
    styles: filterRecord(overlay.styles ?? undefined, nodeIds),
    edgeStyles: filterRecord(overlay.edgeStyles ?? undefined, edgeIds),
    edgeHandles: filterRecord(overlay.edgeHandles ?? undefined, edgeIds),
  };
  if (!nextOverlay.positions && !nextOverlay.styles && !nextOverlay.edgeStyles && !nextOverlay.edgeHandles) {
    return { ...newNode, attrs: { ...newNode.attrs, overlay: null } };
  }
  return { ...newNode, attrs: { ...newNode.attrs, overlay: nextOverlay } };
}

function extractDiagramStableIds(source: string): { nodes: Set<string>; edges: Set<string> } {
  const lines = source.split(/\r?\n/);
  const header = lines.find((line) => line.trim());
  const first = header?.trim() ?? "";
  if (/^mindmap\b/.test(first)) return extractMindmapIds(lines);
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const edgeFactories = new Map<string, EdgeIdFactory>();
  const addNode = (id: string) => {
    if (/^[A-Za-z_][\w-]*$/.test(id)) nodes.add(id);
  };
  const addEdge = (prefix: string, sourceId: string, targetId: string, syntaxKind: string, label?: string) => {
    addNode(sourceId);
    addNode(targetId);
    let nextEdgeId = edgeFactories.get(prefix);
    if (!nextEdgeId) {
      nextEdgeId = createEdgeIdFactory(prefix);
      edgeFactories.set(prefix, nextEdgeId);
    }
    edges.add(nextEdgeId({ source: sourceId, target: targetId, syntaxKind, label: label || undefined }));
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    if (/^(flowchart|graph)\b/.test(first)) {
      const edge = trimmed.match(/^([A-Za-z_][\w-]*)(?:\[[^\]]*]|\([^)]*\)|\{[^}]*})?\s+(-->|-.->|==>)(?:\|([^|]*)\|)?\s+([A-Za-z_][\w-]*)/);
      if (edge) {
        addEdge("flow", edge[1]!, edge[4]!, edge[2]!, edge[3]);
        continue;
      }
      const node = trimmed.match(/^([A-Za-z_][\w-]*)/);
      if (node) addNode(node[1]!);
      continue;
    }
    if (/^stateDiagram/.test(first)) {
      const alias = trimmed.match(/^state\s+"[^"]+"\s+as\s+([A-Za-z_][\w-]*)$/);
      if (alias) addNode(alias[1]!);
      const edge = trimmed.match(/^([A-Za-z_][\w-]*)\s*-->\s*([A-Za-z_][\w-]*)(?:\s*:\s*(.*?))?\s*$/);
      if (edge) addEdge("state", edge[1]!, edge[2]!, "-->", edge[3]?.trim());
      continue;
    }
    if (/^erDiagram/.test(first)) {
      const edge = trimmed.match(/^([A-Za-z_][\w-]*)\s+([|o}{][|o}{]--[|o}{][|o}{])\s+([A-Za-z_][\w-]*)(?:\s*:\s*(.*?))?\s*$/);
      if (edge) addEdge("er", edge[1]!, edge[3]!, edge[2]!, edge[4]?.trim());
      else {
        const entity = trimmed.match(/^([A-Za-z_][\w-]*)/);
        if (entity) addNode(entity[1]!);
      }
      continue;
    }
    if (/^classDiagram/.test(first)) {
      const edge = trimmed.match(/^([A-Za-z_][\w-]*)\s+([<|*o.]{0,2}--[>|*o.]{0,2}|<\|--|\*--|o--|\.\.>|-->)\s+([A-Za-z_][\w-]*)(?:\s*:\s*(.*?))?\s*$/);
      if (edge) addEdge("class", edge[1]!, edge[3]!, edge[2]!, edge[4]?.trim());
      else {
        const cls = trimmed.match(/^class\s+([A-Za-z_][\w-]*)|^([A-Za-z_][\w-]*)$/);
        const id = cls?.[1] ?? cls?.[2];
        if (id) addNode(id);
      }
    }
  }
  return { nodes, edges };
}

function extractMindmapIds(lines: string[]): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const stack: Array<{ id: string; indent: number; path: string[] }> = [];
  const siblingCounters = new Map<string, Map<string, number>>();
  const nextEdgeId = createEdgeIdFactory("mind");
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const parentKey = parent?.id ?? "root";
    const counters = siblingCounters.get(parentKey) ?? new Map<string, number>();
    siblingCounters.set(parentKey, counters);
    const occ = (counters.get(trimmed) ?? 0) + 1;
    counters.set(trimmed, occ);
    const path = [...(parent?.path ?? []), `${trimmed}#${occ}`];
    const id = `mind-${hashText(path.join("/"))}`;
    nodes.add(id);
    if (parent) edges.add(nextEdgeId({ source: parent.id, target: id, syntaxKind: "tree" }));
    stack.push({ id, indent, path });
  }
  return { nodes, edges };
}

function filterRecord<T>(record: Record<string, T> | null | undefined, allowed: Set<string>): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}

type EdgeIdInput = { source: string; target: string; syntaxKind: string; label?: string };
type EdgeIdFactory = (input: EdgeIdInput) => string;

function createEdgeIdFactory(prefix: string): EdgeIdFactory {
  const seen = new Map<string, number>();
  return (input) => {
    const key = edgeIdentityKey(input);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return `${prefix}-edge-${hashText(JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null, occurrence]))}`;
  };
}

function edgeIdentityKey(input: EdgeIdInput): string {
  return JSON.stringify([input.source, input.target, input.syntaxKind, input.label ?? null]);
}

function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function withListItemBlockId<T extends ListItemNode>(node: T, blockId: string): T {
  return { ...node, attrs: { ...node.attrs, blockId } } as T;
}

function applyListItemEdits(
  doc: PmDoc,
  ops: ReadonlyArray<{ op: Extract<BlockEdit, { action: "replaceListItem" | "insertListItem" | "deleteListItem" }>; opIndex: number }>,
): { doc: PmDoc; applied: string[] } {
  let workingDoc = doc;
  const applied: string[] = [];

  for (const { op, opIndex } of ops) {
    if (op.action === "replaceListItem") {
      const target = findListItemByRef(workingDoc, op.ref);
      if (!target) throw new OpError(opIndex, `列表行 ${op.ref} 不存在,请先 readDraft`);
      const compiled = compileListItemForParent(target.parentList, op.item, {
        opIndex,
        existingItem: target.item,
      });
      const materialized = materializeGeneratedBlockIdsDeep(compiled, {
        namespace: "editDraft.replaceListItem",
        existingIds: collectBlockIds(workingDoc),
      }).node;
      const replacement = withListItemBlockId(materialized, op.ref);
      const nextItems = [...target.parentList.content] as ListItemNode[];
      nextItems[target.index] = replacement;
      workingDoc = replaceNodeAtPath(workingDoc, target.parentPath, withListContent(target.parentList, nextItems));
      applied.push(op.ref);
      assertListEditDocValid(workingDoc, opIndex);
      continue;
    }

    if (op.action === "deleteListItem") {
      const target = findListItemByRef(workingDoc, op.ref);
      if (!target) throw new OpError(opIndex, `列表行 ${op.ref} 不存在,请先 readDraft`);
      if (target.parentList.content.length <= 1) {
        throw new OpError(opIndex, `列表 ${target.parentList.attrs.blockId} 只有一行,拒绝删除后留下空列表`);
      }
      const nextItems = [...target.parentList.content] as ListItemNode[];
      nextItems.splice(target.index, 1);
      workingDoc = replaceNodeAtPath(workingDoc, target.parentPath, withListContent(target.parentList, nextItems));
      applied.push(op.ref);
      assertListEditDocValid(workingDoc, opIndex);
      continue;
    }

    const parent = findListByRef(workingDoc, op.parentRef);
    if (!parent) throw new OpError(opIndex, `父列表 ${op.parentRef} 不存在,请先 readDraft`);
    let insertIndex = parent.list.content.length;
    if (op.at === "start") {
      insertIndex = 0;
    } else if (op.at === "end") {
      insertIndex = parent.list.content.length;
    } else {
      if (!op.ref) throw new OpError(opIndex, "insertListItem before/after 需要目标行 ref");
      const siblingIndex = parent.list.content.findIndex((item) => item.attrs.blockId === op.ref);
      if (siblingIndex < 0) {
        throw new OpError(opIndex, `列表行 ${op.ref} 不属于父列表 ${op.parentRef}`);
      }
      insertIndex = op.at === "before" ? siblingIndex : siblingIndex + 1;
    }

    const compiled = compileListItemForParent(parent.list, op.item, { opIndex });
    const materialized = materializeGeneratedBlockIdsDeep(compiled, {
      namespace: "editDraft.insertListItem",
      existingIds: collectBlockIds(workingDoc),
    }).node;
    const nextItems = [...parent.list.content] as ListItemNode[];
    nextItems.splice(insertIndex, 0, materialized);
    workingDoc = replaceNodeAtPath(workingDoc, parent.path, withListContent(parent.list, nextItems));
    applied.push(materialized.attrs.blockId);
    assertListEditDocValid(workingDoc, opIndex);
  }

  return { doc: workingDoc, applied };
}

function applyTableEdits(
  doc: PmDoc,
  ops: ReadonlyArray<{ op: Extract<BlockEdit, { action: "insertTableRow" | "insertTableColumn" | "deleteTableRow" | "deleteTableColumn" }>; opIndex: number }>,
): { doc: PmDoc; applied: string[] } {
  let workingDoc = doc;
  const applied: string[] = [];

  for (const { op, opIndex } of ops) {
    const target = findTableByRef(workingDoc, op.ref);
    if (!target) throw new OpError(opIndex, `表格 ${op.ref} 不存在,请先 readDraft`);
    assertNoMergedTableCells(target.table, opIndex, op.ref);

    if (op.action === "insertTableRow") {
      const columnCount = tableColumnCount(target.table);
      const cells = op.cells ?? [];
      if (cells.length > columnCount) {
        throw new OpError(opIndex, `insertTableRow.cells 有 ${cells.length} 个,超过当前表格 ${columnCount} 列`);
      }
      const existingIds = collectBlockIds(workingDoc);
      const nextRow: PmTableRowNode = {
        type: "tableRow",
        content: Array.from({ length: columnCount }, (_, columnIndex) =>
          compileTableCell(cells[columnIndex], { opIndex, header: false, existingIds }),
        ),
      };
      const insertIndex = resolveTableRowInsertIndex(target.table, op, opIndex);
      const nextRows = [...target.table.content];
      nextRows.splice(insertIndex, 0, nextRow);
      workingDoc = replaceNodeAtPath(workingDoc, target.path, withTableRows(target.table, nextRows));
      applied.push(op.ref);
      assertTableEditDocValid(workingDoc, opIndex);
      continue;
    }

    if (op.action === "insertTableColumn") {
      const cells = op.cells ?? [];
      if (cells.length > target.table.content.length) {
        throw new OpError(opIndex, `insertTableColumn.cells 有 ${cells.length} 个,超过当前表格 ${target.table.content.length} 行`);
      }
      const existingIds = collectBlockIds(workingDoc);
      const fixedInsertIndex = op.at === "end"
        ? null
        : resolveTableColumnInsertIndex(target.table, op, opIndex);
      const nextRows = target.table.content.map((row, rowIndex): PmTableRowNode => {
        const insertIndex = fixedInsertIndex ?? row.content.length;
        const newCell = compileTableCell(cells[rowIndex], {
          opIndex,
          header: rowIsHeader(row),
          existingIds,
        });
        const nextCells = [...row.content];
        nextCells.splice(insertIndex, 0, newCell);
        return { ...row, content: nextCells };
      });
      workingDoc = replaceNodeAtPath(workingDoc, target.path, withTableRows(target.table, nextRows));
      applied.push(op.ref);
      assertTableEditDocValid(workingDoc, opIndex);
      continue;
    }

    if (op.action === "deleteTableRow") {
      assertTableIndex(opIndex, "rowIndex", op.rowIndex);
      const row = target.table.content[op.rowIndex];
      if (!row) throw tableRowIndexError(opIndex, op.ref, op.rowIndex, target.table.content.length);
      if (rowIsHeader(row)) {
        throw new OpError(opIndex, `deleteTableRow 拒绝删除表头行 rowIndex:${op.rowIndex};如需重构表头请先 readDraft 后 replaceBlock 整表`);
      }
      if (target.table.content.length <= 1) {
        throw new OpError(opIndex, "deleteTableRow 会让表格没有任何行;表格至少需要保留一行");
      }
      const nextRows = [...target.table.content];
      nextRows.splice(op.rowIndex, 1);
      workingDoc = replaceNodeAtPath(workingDoc, target.path, withTableRows(target.table, nextRows));
      applied.push(op.ref);
      assertTableEditDocValid(workingDoc, opIndex);
      continue;
    }

    assertTableIndex(opIndex, "columnIndex", op.columnIndex);
    const columnCount = tableColumnCount(target.table);
    if (op.columnIndex >= columnCount) throw tableColumnIndexError(opIndex, op.ref, op.columnIndex, columnCount);
    if (columnCount <= 1) {
      throw new OpError(opIndex, "deleteTableColumn 会让表格没有任何列;表格至少需要保留一列");
    }
    const nextRows = target.table.content.map((row, rowIndex): PmTableRowNode => {
      if (op.columnIndex >= row.content.length) {
        throw new OpError(opIndex, `deleteTableColumn columnIndex:${op.columnIndex} 在第 ${rowIndex} 行越界,请先 readDraft 确认当前表格结构`);
      }
      const nextCells = [...row.content];
      nextCells.splice(op.columnIndex, 1);
      return { ...row, content: nextCells };
    });
    workingDoc = replaceNodeAtPath(workingDoc, target.path, withTableRows(target.table, nextRows));
    applied.push(op.ref);
    assertTableEditDocValid(workingDoc, opIndex);
  }

  return { doc: workingDoc, applied };
}

function assertListEditDocValid(doc: PmDoc, opIndex: number): void {
  const parsed = safeParsePmDoc(doc);
  if (!parsed.success) {
    throw new OpError(opIndex, `行级列表编辑后结果未过 pmDocSchema: ${parsed.error.message}`);
  }
}

function assertTableEditDocValid(doc: PmDoc, opIndex: number): void {
  const parsed = safeParsePmDoc(doc);
  if (!parsed.success) {
    throw new OpError(opIndex, `表格增量编辑后结果未过 pmDocSchema: ${parsed.error.message}`);
  }
}

function compileListItemForParent(
  parentList: ListBlockNode,
  rawItem: unknown,
  opts: { opIndex: number; existingItem?: ListItemNode },
): ListItemNode {
  const item = normalizeListItemDraft(rawItem, opts.opIndex);
  if (parentList.type === "bulletList" || parentList.type === "orderedList") {
    if (item.checked !== undefined) {
      throw new OpError(opts.opIndex, `${parentList.type} 的 listItem 不支持 checked; 如需勾选状态请使用 taskList`);
    }
    const result = compileAiDocumentToPm({
      blocks: [{
        type: parentList.type,
        items: [{
          runs: item.runs ?? [],
          ...(item.children ? { children: item.children } : {}),
        }],
      }],
    });
    if (!result.ok || !result.doc) throw new OpError(opts.opIndex, formatCompileErrors(result.blockErrors, "listItem"));
    const list = result.doc.content[0];
    if (!list || list.type !== parentList.type || list.content.length !== 1) {
      throw new OpError(opts.opIndex, "listItem 编译结果不是单个列表行");
    }
    return list.content[0]!;
  }

  if (!Array.isArray(item.runs)) {
    throw new OpError(opts.opIndex, "taskItem 必须提供 runs,用于生成首个 paragraph");
  }
  const checked = item.checked ?? (opts.existingItem?.type === "taskItem" ? opts.existingItem.attrs.checked : false);
  const result = compileAiDocumentToPm({
    blocks: [{ type: "taskList", items: [{ checked, runs: item.runs }] }],
  });
  if (!result.ok || !result.doc) throw new OpError(opts.opIndex, formatCompileErrors(result.blockErrors, "taskItem"));
  const list = result.doc.content[0];
  if (!list || list.type !== "taskList" || list.content.length !== 1) {
    throw new OpError(opts.opIndex, "taskItem 编译结果不是单个待办行");
  }
  const taskItem = list.content[0]!;
  const childBlocks = item.children ? compileChildBlocks(item.children, opts.opIndex) : [];
  return { ...taskItem, content: [...taskItem.content, ...childBlocks] };
}

function normalizeListItemDraft(rawItem: unknown, opIndex: number): ListItemDraft {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    throw new OpError(opIndex, "list item 必须是对象,形如 {runs, children, checked}");
  }
  const item = rawItem as Record<string, unknown>;
  if ("runs" in item && !Array.isArray(item.runs)) throw new OpError(opIndex, "list item.runs 必须是数组");
  if ("children" in item && !Array.isArray(item.children)) throw new OpError(opIndex, "list item.children 必须是 block 数组");
  if ("checked" in item && typeof item.checked !== "boolean") throw new OpError(opIndex, "list item.checked 必须是 boolean");
  return {
    ...(Array.isArray(item.runs) ? { runs: item.runs } : {}),
    ...(Array.isArray(item.children) ? { children: item.children } : {}),
    ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
  };
}

function compileChildBlocks(children: readonly unknown[], opIndex: number): PmBlockNode[] {
  const result = compileAiDocumentToPm({ blocks: children });
  if (!result.ok || !result.doc) throw new OpError(opIndex, formatCompileErrors(result.blockErrors, "children"));
  return result.doc.content;
}

function formatCompileErrors(
  errors: readonly { index: number; message: string }[],
  label: string,
): string {
  if (errors.length === 0) return `${label} 编译失败`;
  return errors.map((e) => `${label} block ${e.index}: ${e.message}`).join("; ");
}

function withListContent(list: ListBlockNode, content: readonly ListItemNode[]): ListBlockNode {
  return { ...list, content } as ListBlockNode;
}

type ListLocation = {
  list: ListBlockNode;
  path: number[];
};

type TableLocation = {
  table: PmTableNode;
  path: number[];
};

type ListItemLocation = {
  parentList: ListBlockNode;
  parentPath: number[];
  item: ListItemNode;
  index: number;
};

function findListByRef(doc: PmDoc, ref: string): ListLocation | null {
  let found: ListLocation | null = null;
  visitContent(doc.content, [], (node, path) => {
    if (found || !isListBlockNode(node)) return;
    if (node.attrs.blockId === ref) found = { list: node, path };
  });
  return found;
}

function findListItemByRef(doc: PmDoc, ref: string): ListItemLocation | null {
  let found: ListItemLocation | null = null;
  visitContent(doc.content, [], (node, path) => {
    if (found || !isListBlockNode(node)) return;
    node.content.forEach((item, index) => {
      if (!found && item.attrs.blockId === ref) {
        found = { parentList: node, parentPath: path, item, index };
      }
    });
  });
  return found;
}

function findTableByRef(doc: PmDoc, ref: string): TableLocation | null {
  let found: TableLocation | null = null;
  visitContent(doc.content, [], (node, path) => {
    if (found || node.type !== "table") return;
    if (node.attrs.blockId === ref) found = { table: node, path };
  });
  return found;
}

function visitContent(
  content: readonly unknown[] | undefined,
  path: number[],
  visit: (node: PmNode, path: number[]) => void,
): void {
  content?.forEach((child, index) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return;
    const node = child as PmNode;
    const childPath = [...path, index];
    visit(node, childPath);
    const nested = (node as unknown as { content?: unknown[] }).content;
    if (Array.isArray(nested)) visitContent(nested, childPath, visit);
  });
}

function isListBlockNode(node: PmNode): node is ListBlockNode {
  return node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList";
}

function withTableRows(table: PmTableNode, content: readonly PmTableRowNode[]): PmTableNode {
  return { ...table, content: [...content] };
}

function rowIsHeader(row: PmTableRowNode): boolean {
  return row.content.length > 0 && row.content.every((cell) => cell.type === "tableHeader");
}

function tableColumnCount(table: PmTableNode): number {
  return Math.max(...table.content.map((row) => row.content.length));
}

function assertNoMergedTableCells(table: PmTableNode, opIndex: number, ref: string): void {
  for (const row of table.content) {
    for (const cell of row.content) {
      const colspan = cell.attrs?.colspan ?? 1;
      const rowspan = cell.attrs?.rowspan ?? 1;
      if (colspan > 1 || rowspan > 1) {
        throw new OpError(
          opIndex,
          `表格 ${ref} 含合并单元格(colspan/rowspan),表格增量行列 op 暂不支持;请先 readDraft 后 replaceBlock 整表重构`,
        );
      }
    }
  }
}

function resolveTableRowInsertIndex(
  table: PmTableNode,
  op: Extract<BlockEdit, { action: "insertTableRow" }>,
  opIndex: number,
): number {
  if (op.at === "end") return table.content.length;
  if (op.rowIndex === undefined) throw new OpError(opIndex, "insertTableRow before/after 需要 rowIndex");
  assertTableIndex(opIndex, "rowIndex", op.rowIndex);
  if (op.rowIndex >= table.content.length) {
    throw tableRowIndexError(opIndex, op.ref, op.rowIndex, table.content.length);
  }
  if (op.at === "before" && op.rowIndex === 0 && rowIsHeader(table.content[0]!)) {
    throw new OpError(opIndex, "insertTableRow 拒绝在表头行之前插入数据行;如需表格说明请插入表格外段落");
  }
  return op.at === "before" ? op.rowIndex : op.rowIndex + 1;
}

function resolveTableColumnInsertIndex(
  table: PmTableNode,
  op: Extract<BlockEdit, { action: "insertTableColumn" }>,
  opIndex: number,
): number {
  if (op.columnIndex === undefined) throw new OpError(opIndex, "insertTableColumn before/after 需要 columnIndex");
  assertTableIndex(opIndex, "columnIndex", op.columnIndex);
  const columnCount = tableColumnCount(table);
  if (op.columnIndex >= columnCount) throw tableColumnIndexError(opIndex, op.ref, op.columnIndex, columnCount);
  for (let rowIndex = 0; rowIndex < table.content.length; rowIndex += 1) {
    const row = table.content[rowIndex]!;
    if (op.columnIndex >= row.content.length) {
      throw new OpError(opIndex, `insertTableColumn columnIndex:${op.columnIndex} 在第 ${rowIndex} 行越界,请先 readDraft 确认当前表格结构`);
    }
  }
  return op.at === "before" ? op.columnIndex : op.columnIndex + 1;
}

function assertTableIndex(opIndex: number, label: "rowIndex" | "columnIndex", value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new OpError(opIndex, `${label}:${String(value)} 必须是非负整数`);
  }
}

function tableRowIndexError(opIndex: number, ref: string, rowIndex: number, rowCount: number): OpError {
  return new OpError(opIndex, `表格 ${ref} rowIndex:${rowIndex} 越界(当前 ${rowCount} 行),请先 readDraft 确认当前表格结构`);
}

function tableColumnIndexError(opIndex: number, ref: string, columnIndex: number, columnCount: number): OpError {
  return new OpError(opIndex, `表格 ${ref} columnIndex:${columnIndex} 越界(当前 ${columnCount} 列),请先 readDraft 确认当前表格结构`);
}

function compileTableCell(
  rawCell: unknown,
  opts: { opIndex: number; header: boolean; existingIds: Set<string> },
): PmTableCellNode {
  const cell = normalizeTableCellDraft(rawCell, opts.opIndex);
  if ((cell.colspan ?? 1) > 1 || (cell.rowspan ?? 1) > 1) {
    throw new OpError(opts.opIndex, "表格增量行列 op 暂不支持插入 colspan/rowspan 合并单元格");
  }
  const result = compileAiDocumentToPm({
    blocks: [{
      type: "table",
      rows: [{
        cells: [{
          blocks: cell.blocks ?? [],
          header: opts.header || cell.header === true,
          ...(cell.backgroundColor ? { backgroundColor: cell.backgroundColor } : {}),
        }],
      }],
    }],
  });
  if (!result.ok || !result.doc) throw new OpError(opts.opIndex, formatCompileErrors(result.blockErrors, "tableCell"));
  const table = result.doc.content[0];
  const compiled = table?.type === "table" ? table.content[0]?.content[0] : undefined;
  if (!compiled) throw new OpError(opts.opIndex, "tableCell 编译结果不是单个单元格");
  const materialized = materializeGeneratedBlockIdsDeep(compiled, {
    namespace: "editDraft.insertTableCell",
    existingIds: opts.existingIds,
  });
  for (const id of materialized.ids) opts.existingIds.add(id);
  return materialized.node;
}

function normalizeTableCellDraft(rawCell: unknown, opIndex: number): TableCellDraft {
  if (rawCell === undefined) return {};
  if (!rawCell || typeof rawCell !== "object" || Array.isArray(rawCell)) {
    throw new OpError(opIndex, "table cell 必须是对象,形如 {blocks, header?, backgroundColor?}");
  }
  const cell = rawCell as Record<string, unknown>;
  if ("blocks" in cell && !Array.isArray(cell.blocks)) throw new OpError(opIndex, "table cell.blocks 必须是 block 数组");
  if ("runs" in cell && !Array.isArray(cell.runs)) throw new OpError(opIndex, "table cell.runs 必须是数组");
  if ("header" in cell && typeof cell.header !== "boolean") throw new OpError(opIndex, "table cell.header 必须是 boolean");
  if ("backgroundColor" in cell && typeof cell.backgroundColor !== "string") {
    throw new OpError(opIndex, "table cell.backgroundColor 必须是字符串主题色名");
  }
  for (const name of ["colspan", "rowspan"] as const) {
    if (name in cell && (!Number.isInteger(cell[name]) || Number(cell[name]) < 1)) {
      throw new OpError(opIndex, `table cell.${name} 必须是大于等于 1 的整数`);
    }
  }
  // 存量会话可能仍携带 runs；只在边界读取一次，归一后的公开类型与内部数据均只保留 blocks。
  const legacyBlocks = Array.isArray(cell.runs)
    ? [{ type: "paragraph", runs: cell.runs }]
    : [];
  return {
    blocks: Array.isArray(cell.blocks) ? cell.blocks : legacyBlocks,
    ...(typeof cell.header === "boolean" ? { header: cell.header } : {}),
    ...(typeof cell.backgroundColor === "string" ? { backgroundColor: cell.backgroundColor } : {}),
    ...(typeof cell.colspan === "number" ? { colspan: cell.colspan } : {}),
    ...(typeof cell.rowspan === "number" ? { rowspan: cell.rowspan } : {}),
  };
}

function replaceNodeAtPath(doc: PmDoc, path: readonly number[], replacement: PmNode): PmDoc {
  if (path.length === 0) throw new Error("不能替换 doc 根节点");
  return {
    ...doc,
    content: replaceInContent(doc.content, path, replacement) as PmBlockNode[],
  };
}

function replaceInContent(content: readonly unknown[], path: readonly number[], replacement: PmNode): unknown[] {
  const [index, ...rest] = path;
  if (index === undefined) return content as unknown[];
  if (index < 0 || index >= content.length) throw new Error("列表路径越界");
  const next = [...content];
  next[index] = rest.length === 0
    ? replacement
    : replaceInNode(content[index], rest, replacement);
  return next;
}

function replaceInNode(node: unknown, path: readonly number[], replacement: PmNode): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("列表路径指向非节点");
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record.content)) throw new Error("列表路径缺少 content");
  return { ...record, content: replaceInContent(record.content, path, replacement) };
}

function materializeGeneratedBlockIdsDeep<T extends PmNode>(
  node: T,
  opts: { namespace: string; existingIds: ReadonlySet<string> },
): { node: T; ids: string[] } {
  const used = new Set(opts.existingIds);
  let occurrence = 0;
  const ids: string[] = [];

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    let attrs = record.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const blockId = (attrs as Record<string, unknown>).blockId;
      if (isGeneratedAiBlockId(blockId)) {
        const baseId = getDeterministicId("block", {
          namespace: opts.namespace,
          sourceBlockId: blockId,
          type: record.type,
          contentHash: getPmContentHash(stripBlockIds(record)),
        });
        let nextId = baseId;
        while (used.has(nextId)) {
          nextId = `${baseId}~${occurrence}`;
          occurrence += 1;
        }
        used.add(nextId);
        ids.push(nextId);
        attrs = { ...(attrs as Record<string, unknown>), blockId: nextId };
      } else if (typeof blockId === "string") {
        used.add(blockId);
        ids.push(blockId);
      }
    }

    const content = Array.isArray(record.content) ? record.content.map(rewrite) : record.content;
    return {
      ...record,
      ...(attrs ? { attrs } : {}),
      ...(Array.isArray(record.content) ? { content } : {}),
    };
  };

  return { node: rewrite(node) as T, ids };
}

function collectBlockIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs && typeof record.attrs === "object" && !Array.isArray(record.attrs)
      ? record.attrs as Record<string, unknown>
      : null;
    if (typeof attrs?.blockId === "string") ids.add(attrs.blockId);
    visit(record.content);
  };
  visit(value);
  return ids;
}

function collectBlockIdsExcluding(nodes: readonly PmBlockNode[], excludedIndex: number): Set<string> {
  return collectBlockIds(nodes.filter((_, index) => index !== excludedIndex));
}

function assertUniqueBlockIds(value: unknown): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs && typeof record.attrs === "object" && !Array.isArray(record.attrs)
      ? record.attrs as Record<string, unknown>
      : null;
    const blockId = attrs?.blockId;
    if (typeof blockId === "string") {
      if (seen.has(blockId)) duplicates.add(blockId);
      seen.add(blockId);
    }
    visit(record.content);
  };
  visit(value);
  if (duplicates.size > 0) {
    throw new Error(`applyBlockEdits 结果出现重复 blockId: ${[...duplicates].join(", ")}`);
  }
}

function stripBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlockIds);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "blockId") continue;
    out[key] = stripBlockIds(child);
  }
  return out;
}

// BB② 幂等护栏辅助:递归判断节点是否含可见文字(任一 run/text 非空白)。
function nodeHasVisibleText(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(nodeHasVisibleText);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim().length > 0) return true;
  return Object.values(record).some(nodeHasVisibleText);
}

// BB② 幂等护栏:只有「有实义内容」的块才参与"相邻同内容去重"。
// 分隔线 horizontalRule、空段落等结构块返回 false —— 放过用户有意连续插入相同分隔/空行的合法用例。
function isContentBearingBlock(node: PmBlockNode): boolean {
  if (node.type === "horizontalRule") return false;
  return nodeHasVisibleText(node);
}

function incomingBlockContractHints(blocks: readonly unknown[]): string[] {
  return blocks.flatMap((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const o = block as Record<string, unknown>;
    const looksLikeReadDraftEnvelope =
      (o.aiIr && typeof o.aiIr === "object") ||
      "ref" in o ||
      "editability" in o ||
      ("text" in o && o.type !== "codeBlock");
    const missingRequiredField = missingAiBlockTopLevelField(o);
    if (!looksLikeReadDraftEnvelope && !missingRequiredField) return [];
    const reason = missingRequiredField
      ? `block ${index} 缺 ${missingRequiredField}`
      : `block ${index} 缺顶层字段`;
    return [`${reason}；editDraft 结构载荷请传 QingML 片段，不要带 ref/text/editability 外壳。`];
  });
}

function missingAiBlockTopLevelField(block: Record<string, unknown>): string | null {
  switch (block.type) {
    case "paragraph":
    case "blockquote":
    case "penNote":
      return Array.isArray(block.runs) ? null : `${block.type} 需要的 runs 字段`;
    case "heading": {
      const missing = [
        Number.isInteger(block.level) ? null : "level",
        Array.isArray(block.runs) ? null : "runs",
      ].filter(Boolean);
      return missing.length > 0 ? `heading 需要的 ${missing.join("/")} 字段` : null;
    }
    case "codeBlock":
      return typeof block.text === "string" ? null : "codeBlock 需要的 text 字段";
    case "bulletList":
    case "orderedList":
    case "taskList":
      return Array.isArray(block.items) ? null : `${block.type} 需要的 items 字段`;
    case "columnList":
      return Array.isArray(block.columns) ? null : "columnList 需要的 columns 字段";
    case "callout":
      return Array.isArray(block.runs) ? null : "callout 需要的 runs 字段";
    case "blockMath":
      return typeof block.latex === "string" ? null : "blockMath 需要的 latex 字段";
    case "table":
      return Array.isArray(block.rows) ? null : "table 需要的 rows 字段";
    case "image":
      return typeof block.src === "string" ? null : "image 需要的 src 字段";
    case "fileAttachment": {
      const missing = ["fileId", "filename", "mimeType"].filter((key) => typeof block[key] !== "string");
      if (typeof block.size !== "number") missing.push("size");
      return missing.length > 0 ? `fileAttachment 需要的 ${missing.join("/")} 字段` : null;
    }
    case "horizontalRule":
      return null;
    default:
      return typeof block.type === "string" ? null : "顶层 type 字段";
  }
}
