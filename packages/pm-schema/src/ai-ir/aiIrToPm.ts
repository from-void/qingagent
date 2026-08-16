import { getDeterministicId } from "../hash";
import { PM_SCHEMA_VERSION } from "../schemaVersion";
import { normalizeDrawioSource } from "../drawio/drawioXml";
import {
  isAllowedThemeColor,
  normalizePmDoc,
  PM_TABLE_MAX_CELLS,
  PM_TABLE_MAX_LOGICAL_COLUMNS,
  PM_TABLE_MAX_SPAN,
} from "../validators";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark, PmParagraphNode, PmTaskItemNode, PmTextAlign, PmThemeColor } from "../types";
import {
  aiBlockSchema,
  aiDocumentEnvelopeSchema,
  type AiBlock,
  type AiDocument,
  type AiListItem,
  type AiRun,
  type AiRunMark,
  type AiTableCell,
  type AiTableRow,
  type AiTaskListItem,
} from "./aiIrSchema";

/**
 * 表格 cell 后代 blockId 规范：
 * - 单段 paragraph 沿用 `${tableId}-rN-cN-p`（N 为 1-based，仅 ID 命名如此）；
 * - 多块 cell 的第 k 个直接子块为 `${tableId}-rN-cN-bK`；
 * - 嵌套后代继续由既有 blockToPm/materialize 体系派生，并以最终 table ref 为命名空间；
 * - anchored replace 把顶层临时 `ai-block-*` 转成稳定 ref 时，applyBlockEdits 必须同步
 *   深度重写后代前缀并 materialize 其余临时 ID，不能只浅改 table.attrs.blockId。
 */

export interface AiIrBlockError {
  index: number;
  message: string;
}

export interface AiIrCompileResult {
  ok: boolean;
  doc: PmDoc | null;
  blockErrors: AiIrBlockError[];
}

// mermaid 图头(首个非空行)关键字;用来识别"被模型写成代码块的图表"。
// 取强特征,避免把普通代码误判:flowchart/graph 必带方向,其余是 mermaid 专有图类型。
const MERMAID_HEADER =
  /^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|^(?:sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie(?:\s+title|\s+showData|\s*\n)|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta|C4Context)\b/;

/**
 * 判断一个代码块其实是不是 mermaid 图表源码。
 * 命中条件:① language 显式是 mermaid(各种大小写/别名);或 ② 正文首个非空行是合法 mermaid 图头。
 * 命中则返回去除首尾空白的源码,否则返回 null。
 */
export function detectMermaidSource(language: string | null | undefined, text: string | null | undefined): string | null {
  const src = (text ?? "").trim();
  if (!src) return null;
  const lang = (language ?? "").trim().toLowerCase();
  const langIsMermaid = lang === "mermaid" || lang === "mmd";
  // 取首个非空行判断图头
  const firstLine = src.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const looksMermaid = MERMAID_HEADER.test(firstLine);
  return langIsMermaid || looksMermaid ? src : null;
}

/**
 * 识别被模型写进 codeBlock 的 drawio XML，并在返回前完成解压与安全校验。
 */
export function detectDrawioSource(language: string | null | undefined, text: string | null | undefined): string | null {
  const source = (text ?? "").trim();
  if (!source) return null;
  const lang = (language ?? "").trim().toLowerCase();
  const looksDrawio = lang === "drawio" || /^<(?:mxGraphModel|mxfile)\b/.test(source);
  if (!looksDrawio) return null;
  try {
    return normalizeDrawioSource(source);
  } catch {
    return null;
  }
}

/**
 * 把已经是 PM 文档(已落盘 / 待装载)里"伪装成代码块的 Mermaid/drawio 图"升级回 diagram 块。
 *
 * 背景:本项目铁律是「mermaid 永远是活图,绝不是死代码块」——所有文档编译入口都已
 * 在各自入口做这个升级。但当一个 `codeBlock(language=mermaid)` 通过【其它路径】混进已存文档(例如
 * 历史脏数据 / 某次编辑把 diagram 退化成 codeBlock)时,装载到编辑器里就会渲染成一段死代码、没有
 * 可视化编辑入口(用户报的"Mermaid 退回代码格式")。本函数是装载侧的同一张安全网:任何 detectMermaidSource
 * 命中的 codeBlock 一律换成 diagram 块,保留其 blockId(块身份稳定)。其它代码块原样保留。
 *
 * 纯函数、不可变:返回一份升级后的克隆,命中 0 处时返回结构等价的克隆(调用方可放心 setContent)。
 */
export function upgradeMermaidCodeBlocksToDiagram<T>(doc: T): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (record.type === "codeBlock") {
      const attrs = (record.attrs ?? {}) as Record<string, unknown>;
      const language = typeof attrs.language === "string" ? attrs.language : null;
      const text = Array.isArray(record.content)
        ? (record.content as Array<{ text?: unknown }>).map((run) => (typeof run?.text === "string" ? run.text : "")).join("")
        : "";
      const mermaidSource = detectMermaidSource(language, text);
      if (mermaidSource) {
        const blockId = typeof attrs.blockId === "string" && attrs.blockId.length > 0 ? attrs.blockId : undefined;
        return { type: "diagram", attrs: { ...(blockId ? { blockId } : {}), lang: "mermaid", source: mermaidSource, svg: null } };
      }
      const drawioSource = detectDrawioSource(language, text);
      if (drawioSource) {
        const blockId = typeof attrs.blockId === "string" && attrs.blockId.length > 0 ? attrs.blockId : undefined;
        return { type: "diagram", attrs: { ...(blockId ? { blockId } : {}), lang: "drawio", source: drawioSource, svg: null } };
      }
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) output[key] = visit(value);
    return output;
  };
  return visit(doc) as T;
}

export function aiIrToPm(input: AiDocument): PmDoc {
  const result = compileAiDocumentToPm(input);
  if (!result.ok || !result.doc) {
    throw new Error(formatBlockErrors(result.blockErrors));
  }
  return result.doc;
}

// 模型常把 run 的标记写成"裸字段"简写:`{text,link}` / `{text,href}` 表超链接,
// `{text,bold:true}` 表加粗。aiRunSchema 只认 `marks:[{type,...}]`,而 Zod z.object 非严格
// 会把这些未知字段【静默剥离】→ 校验仍通过(ok:true)但标记丢失(假阳性,链接没挂上)。
// 这里在 schema 校验前把简写并入规范 marks,保住模型 intent;模型传规范格式时此函数无副作用。
const BOOLEAN_MARK_SHORTHANDS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "strikeThrough",
  "code",
] as const;

type AiListBlockType = "bulletList" | "orderedList";
// 扁平 items+depth 编译也支持 taskList(子层级=children 里的子 taskList,item 的 checked 原样保留)。
// 否则模型按范本对多级待办吐 depth 时会被 zod 静默剥掉 depth、整表拍平成同级——正是"内容对、结构拍平"的静默降级。
type FlatDepthListType = AiListBlockType | "taskList";

interface FlatDepthStackEntry {
  item: AiListItem;
  depth: number;
}

function repairAiIrRunShorthand(run: unknown): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const r = run as Record<string, unknown>;
  if (typeof r.text !== "string") return run; // 非常规 run,交给 schema 报错
  const out: Record<string, unknown> = { ...r };
  const marks: Array<Record<string, unknown>> = Array.isArray(r.marks)
    ? r.marks
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !Array.isArray(m))
        .map((m) => ({ ...m }))
    : [];
  const hasMarkType = (type: string) => marks.some((m) => m.type === type);
  let changed = false;

  // link / href 裸字段 → link mark(已有 link mark 则只清掉裸字段)
  const linkHref =
    (typeof r.link === "string" && r.link) || (typeof r.href === "string" && r.href) || null;
  if (linkHref && !hasMarkType("link")) {
    marks.push({ type: "link", href: linkHref });
  }
  if ("link" in out) { delete out.link; changed = true; }
  if ("href" in out) { delete out.href; changed = true; }

  // bold/italic/... 布尔简写 → 对应 mark
  for (const key of BOOLEAN_MARK_SHORTHANDS) {
    if (key in out) {
      if (r[key] === true && !hasMarkType(key)) marks.push({ type: key });
      delete out[key];
      changed = true;
    }
  }

  if (!changed) return run;
  if (marks.length > 0) out.marks = marks;
  else delete out.marks;
  return out;
}

function repairAiIrBlockShorthand(block: unknown, options: { skipPseudoNestedListRepair?: boolean } = {}): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const b = block as Record<string, unknown>;
  // flatDepthListToAiIr 对 `{blocks:[...]}` 信封会返回新对象；blockquote/callout
  // 现在也有 blocks，若无条件递归会把容器误当信封并无限重入。这里只在当前块本身
  // 是列表时运行扁平 depth 编译，容器子块由下方显式递归处理。
  const flatList = normalizeListBlockType(b) ? flatDepthListToAiIr(b) : b;
  if (flatList !== b) return repairAiIrBlockShorthand(flatList, options);

  const out: Record<string, unknown> = { ...b };
  if (Array.isArray(b.runs)) out.runs = b.runs.map(repairAiIrRunShorthand);
  if (
    (b.type === "blockquote" || b.type === "callout")
    && Array.isArray(b.blocks)
  ) {
    out.blocks = b.blocks.map((child) => repairAiIrBlockShorthand(child));
  }
  if (Array.isArray(b.items)) {
    if (b.type === "taskList") {
      // taskList:items 是 {checked,runs,children?}[];容忍模型写成 run[][](按未勾选修复)。
      out.items = b.items.map(repairAiIrTaskItemShorthand);
    } else {
      // bulletList / orderedList:兼容旧 run[][],统一修复成 {runs,children?}。
      const repairedItems = b.items.map(repairAiIrListItemShorthand);
      out.items = options.skipPseudoNestedListRepair
        ? repairedItems
        : repairPseudoNestedListItems(
            b.type === "orderedList" ? "orderedList" : "bulletList",
            repairedItems,
          );
    }
  }
  if (Array.isArray(b.columns)) out.columns = b.columns.map(repairAiIrColumnShorthand);
  if (Array.isArray(b.rows)) {
    out.rows = b.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const r = row as Record<string, unknown>;
      if (!Array.isArray(r.cells)) return row;
      return {
        ...r,
        cells: r.cells.map((cell) => {
          if (!cell || typeof cell !== "object" || Array.isArray(cell)) return cell;
          const c = cell as Record<string, unknown>;
          const normalized: Record<string, unknown> = { ...c };
          if (Array.isArray(c.blocks)) {
            normalized.blocks = c.blocks.map((child) => repairAiIrBlockShorthand(child));
          } else if (Array.isArray(c.runs)) {
            // 旧 AI-IR/会话缓存的一次性入口归一:cell.runs → 单 paragraph blocks。
            normalized.blocks = [{
              type: "paragraph",
              runs: c.runs.map(repairAiIrRunShorthand),
            }];
          }
          delete normalized.runs;
          return normalized;
        }),
      };
    });
  }
  return out;
}

/**
 * 把模型友好的扁平列表 `{items:[{depth,runs}]}` 编译为 AI-IR 递归 children。
 * depth 跳级时按当前栈就近挂载，避免因为 1→3 这类脏层级直接断裂或拍平。
 */
export function flatDepthListToAiIr(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(flatDepthListToAiIr);
  if (!input || typeof input !== "object") return input;

  const block = input as Record<string, unknown>;
  if (Array.isArray(block.blocks)) {
    return { ...block, blocks: block.blocks.map(flatDepthListToAiIr) };
  }

  const listType = normalizeListBlockType(block);
  if (!listType) return input;

  const items = Array.isArray(block.items) ? block.items : null;
  const normalizedBlock: Record<string, unknown> = {
    ...block,
    type: listType,
  };
  delete normalizedBlock.ordered;

  if (!items || !items.some(hasDepthField)) {
    return normalizedBlock.type === block.type ? input : normalizedBlock;
  }

  return {
    ...normalizedBlock,
    items: compileFlatDepthItems(items, listType),
  };
}

function normalizeListBlockType(block: Record<string, unknown>): FlatDepthListType | null {
  if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") return block.type;
  if (block.type === "list") return block.ordered === true ? "orderedList" : "bulletList";
  return null;
}

function hasDepthField(item: unknown): boolean {
  return !!item && typeof item === "object" && !Array.isArray(item) && "depth" in item;
}

function compileFlatDepthItems(items: readonly unknown[], listType: FlatDepthListType): AiListItem[] {
  const roots: AiListItem[] = [];
  const stack: FlatDepthStackEntry[] = [];

  for (const rawItem of items) {
    const item = flatDepthItemToAiListItem(rawItem);
    if (!item) continue;

    const requestedDepth = flatDepthOf(rawItem);
    let depth = Math.max(1, requestedDepth);
    if (stack.length === 0 || depth <= 1) {
      roots.push(item);
      stack[0] = { item, depth: 1 };
      stack.length = 1;
      continue;
    }

    depth = Math.min(depth, stack.length + 1);
    const parent = stack[depth - 2]?.item;
    if (!parent) {
      roots.push(item);
      stack[0] = { item, depth: 1 };
      stack.length = 1;
      continue;
    }

    ensureChildList(parent as unknown as Record<string, unknown>, listType).items.push(item as unknown as Record<string, unknown>);
    stack[depth - 1] = { item, depth };
    stack.length = depth;
  }

  return roots;
}

function flatDepthOf(item: unknown): number {
  if (!item || typeof item !== "object" || Array.isArray(item)) return 1;
  const raw = (item as Record<string, unknown>).depth;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1;
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 1;
}

function flatDepthItemToAiListItem(item: unknown): AiListItem | null {
  if (Array.isArray(item)) return { runs: item.map(repairAiIrRunShorthand) as AiRun[] };
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  delete out.depth;
  if (!Array.isArray(out.runs) && typeof out.text === "string") {
    out.runs = [{ text: out.text }];
    delete out.text;
  }
  if (Array.isArray(out.runs)) out.runs = out.runs.map(repairAiIrRunShorthand);
  if (Array.isArray(out.children)) {
    out.children = out.children.map((child) => repairAiIrBlockShorthand(child, { skipPseudoNestedListRepair: true }));
  }
  return Array.isArray(out.runs) ? out as AiListItem : null;
}

type PseudoListMarker = {
  level: number;
  listType: AiListBlockType;
  prefixLength: number;
  nestingSignal: boolean;
};

function repairPseudoNestedListItems(listType: AiListBlockType, items: unknown[]): unknown[] {
  const objectItems = items.map(asListItemObject);
  if (objectItems.some((item) => item === null)) return items;

  const listItems = objectItems as Record<string, unknown>[];
  if (listItems.some((item) => Array.isArray(item.children))) return items;

  const markers = listItems.map((item) => parsePseudoListMarker(listItemPlainText(item), listType));
  if (!markers.some((marker) => marker?.nestingSignal)) return items;

  const roots: Record<string, unknown>[] = [];
  const stack: Array<Record<string, unknown> | undefined> = [];

  listItems.forEach((item, index) => {
    const marker = markers[index];
    const repaired = marker ? stripListItemPrefix(item, marker.prefixLength) : item;
    let level = marker?.level ?? 0;
    const childListType = marker?.listType ?? listType;

    if (level <= 0 || stack.length === 0) {
      roots.push(repaired);
      stack[0] = repaired;
      stack.length = 1;
      return;
    }

    const parentLevel = Math.min(level - 1, stack.length - 1);
    const parent = stack[parentLevel];
    if (!parent) {
      roots.push(repaired);
      stack[0] = repaired;
      stack.length = 1;
      return;
    }

    level = parentLevel + 1;
    ensureChildList(parent, childListType).items.push(repaired);
    stack[level] = repaired;
    stack.length = level + 1;
  });

  return roots;
}

function asListItemObject(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  return Array.isArray(record.runs) ? record : null;
}

function listItemPlainText(item: Record<string, unknown>): string {
  const runs = item.runs;
  if (!Array.isArray(runs)) return "";
  return runs
    .map((run) =>
      run && typeof run === "object" && typeof (run as Record<string, unknown>).text === "string"
        ? (run as Record<string, string>).text
        : "",
    )
    .join("");
}

function parsePseudoListMarker(text: string, fallbackType: AiListBlockType): PseudoListMarker | null {
  if (!text) return null;

  const leadingWhitespace = text.match(/^[\t ]*/)?.[0] ?? "";
  const indentWidth = [...leadingWhitespace].reduce((sum, char) => sum + (char === "\t" ? 2 : 1), 0);
  const indentLevel = Math.floor(indentWidth / 2);
  const afterIndent = text.slice(leadingWhitespace.length);

  const dotted = afterIndent.match(/^(\d+(?:\.\d+)+)[.)、]?\s+/);
  if (dotted) {
    return {
      level: Math.max(1, dotted[1]!.split(".").length - 1),
      listType: "orderedList",
      prefixLength: leadingWhitespace.length + dotted[0].length,
      nestingSignal: true,
    };
  }

  const circled = afterIndent.match(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/);
  if (circled) {
    return {
      level: indentLevel > 0 ? indentLevel : 0,
      listType: "orderedList",
      prefixLength: indentLevel > 0 ? leadingWhitespace.length + circled[0].length : 0,
      nestingSignal: indentLevel > 0,
    };
  }

  const bullet = afterIndent.match(/^[-*+•]\s+/);
  if (bullet) {
    return {
      level: indentLevel,
      listType: "bulletList",
      prefixLength: leadingWhitespace.length + bullet[0].length,
      nestingSignal: indentLevel > 0,
    };
  }

  const numbered = afterIndent.match(/^(?:\d+|[a-zA-Z])[.)、]\s+/);
  if (numbered) {
    return {
      level: indentLevel,
      listType: "orderedList",
      prefixLength: leadingWhitespace.length + numbered[0].length,
      nestingSignal: indentLevel > 0,
    };
  }

  if (indentLevel > 0) {
    return {
      level: indentLevel,
      listType: fallbackType,
      prefixLength: leadingWhitespace.length,
      nestingSignal: true,
    };
  }

  return null;
}

function stripListItemPrefix(item: Record<string, unknown>, prefixLength: number): Record<string, unknown> {
  if (prefixLength <= 0 || !Array.isArray(item.runs)) return item;
  let remaining = prefixLength;
  const runs = item.runs.map((run) => {
    if (!run || typeof run !== "object" || Array.isArray(run) || typeof (run as Record<string, unknown>).text !== "string") {
      return run;
    }
    if (remaining <= 0) return run;
    const record = run as Record<string, unknown>;
    const text = record.text as string;
    if (text.length <= remaining) {
      remaining -= text.length;
      return { ...record, text: "" };
    }
    const next = { ...record, text: text.slice(remaining) };
    remaining = 0;
    return next;
  });
  return { ...item, runs };
}

function ensureChildList(
  item: Record<string, unknown>,
  listType: FlatDepthListType,
): { type: FlatDepthListType; items: Record<string, unknown>[] } {
  const children = Array.isArray(item.children) ? item.children : [];
  const lastChild = children[children.length - 1];
  if (
    lastChild &&
    typeof lastChild === "object" &&
    !Array.isArray(lastChild) &&
    (lastChild as Record<string, unknown>).type === listType &&
    Array.isArray((lastChild as Record<string, unknown>).items)
  ) {
    return lastChild as { type: FlatDepthListType; items: Record<string, unknown>[] };
  }

  const childList: { type: FlatDepthListType; items: Record<string, unknown>[] } = { type: listType, items: [] };
  item.children = [...children, childList];
  return childList;
}

function repairAiIrListItemShorthand(item: unknown): unknown {
  if (Array.isArray(item)) return { runs: item.map(repairAiIrRunShorthand) };
  if (!item || typeof item !== "object") return item;
  const o = item as Record<string, unknown>;
  return {
    ...o,
    ...(Array.isArray(o.runs) ? { runs: o.runs.map(repairAiIrRunShorthand) } : {}),
    ...(Array.isArray(o.children)
      ? { children: o.children.map((child) => repairAiIrBlockShorthand(child, { skipPseudoNestedListRepair: true })) }
      : {}),
  };
}

function repairAiIrTaskItemShorthand(item: unknown): unknown {
  if (Array.isArray(item)) return { checked: false, runs: item.map(repairAiIrRunShorthand) };
  if (!item || typeof item !== "object") return item;
  const o = item as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o, checked: o.checked === true };
  if (!Array.isArray(out.runs) && typeof out.text === "string") {
    out.runs = [{ text: out.text }];
    delete out.text;
  }
  if (Array.isArray(out.runs)) out.runs = out.runs.map(repairAiIrRunShorthand);
  if (Array.isArray(out.children)) {
    out.children = out.children.map((child) => repairAiIrBlockShorthand(child, { skipPseudoNestedListRepair: true }));
  }
  return out;
}

function repairAiIrColumnShorthand(column: unknown): unknown {
  if (!column || typeof column !== "object" || Array.isArray(column)) return column;
  const o = column as Record<string, unknown>;
  return {
    ...o,
    ...(Array.isArray(o.blocks) ? { blocks: o.blocks.map((block) => repairAiIrBlockShorthand(block)) } : {}),
  };
}

/** 入口:把 `{blocks:[...]}` 信封(或裸 block 数组)里每个块的 run 简写宽容修复。 */
export function repairAiIrShorthand(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((block) => repairAiIrBlockShorthand(block));
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.blocks)) return { ...o, blocks: o.blocks.map((block) => repairAiIrBlockShorthand(block)) };
  }
  return input;
}

export function compileAiDocumentToPm(input: unknown): AiIrCompileResult {
  const envelope = aiDocumentEnvelopeSchema.safeParse(repairAiIrShorthand(input));
  if (!envelope.success) {
    return {
      ok: false,
      doc: null,
      blockErrors: [{ index: -1, message: envelope.error.message }],
    };
  }

  const content: PmBlockNode[] = [];
  const blockErrors: AiIrBlockError[] = [];

  envelope.data.blocks.forEach((rawBlock, index) => {
    const parsed = aiBlockSchema.safeParse(rawBlock);
    if (!parsed.success) {
      blockErrors.push({ index, message: parsed.error.message });
      return;
    }
    try {
      const node = blockToPm(parsed.data, index);
      normalizePmDoc({
        type: "doc",
        attrs: { schemaVersion: PM_SCHEMA_VERSION },
        content: [node],
      });
      content.push(node);
    } catch (err) {
      blockErrors.push({
        index,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (blockErrors.length > 0) {
    return { ok: false, doc: null, blockErrors };
  }

  try {
    const doc = normalizePmDoc({
      type: "doc",
      attrs: { schemaVersion: PM_SCHEMA_VERSION },
      content,
    });
    return { ok: true, doc, blockErrors: [] };
  } catch (err) {
    return {
      ok: false,
      doc: null,
      blockErrors: [{ index: -1, message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

function formatBlockErrors(errors: readonly AiIrBlockError[]): string {
  if (errors.length === 0) return "AI-IR compile failed";
  return `AI-IR compile failed: ${errors.map((err) => `block ${err.index}: ${err.message}`).join("; ")}`;
}

function blockToPm(block: AiBlock, index: number | string): PmBlockNode {
  const blockId = block.blockId ?? getDeterministicId("ai-block", { index, block });
  switch (block.type) {
    case "paragraph":
      return { type: "paragraph", attrs: attrsWithAlign(blockId, block.textAlign), content: runsToInline(block.runs, blockId) };
    case "heading":
      return { type: "heading", attrs: { ...attrsWithAlign(blockId, block.textAlign), level: block.level, anchor: block.anchor ?? null }, content: runsToInline(block.runs, blockId) };
    case "blockquote":
      return {
        type: "blockquote",
        attrs: { blockId },
        content: containerContentToPm(block, blockId, index),
      };
    case "codeBlock": {
      // 安全网:模型(尤其 flash 档)常无视「严禁用 codeBlock 写 mermaid」,把图表写成代码块。
      // 凡 language=mermaid 或正文是合法 mermaid 图头,一律转成 diagram 块,确保图表"活"。
      const mermaidSource = detectMermaidSource(block.language, block.text);
      if (mermaidSource) {
        return { type: "diagram", attrs: { blockId, lang: "mermaid", source: mermaidSource, svg: null } };
      }
      const drawioSource = detectDrawioSource(block.language, block.text);
      if (drawioSource) {
        return { type: "diagram", attrs: { blockId, lang: "drawio", source: drawioSource, svg: null } };
      }
      return { type: "codeBlock", attrs: { blockId, language: block.language ?? "plaintext" }, content: block.text ? [{ type: "text", text: block.text }] : [] };
    }
    case "bulletList":
      return {
        type: "bulletList",
        attrs: { blockId },
        content: block.items.map((item, itemIndex) => listItemToPm(item, blockId, index, itemIndex)),
      };
    case "orderedList":
      return {
        type: "orderedList",
        attrs: { blockId, start: block.start ?? 1, ...(block.listStyle ? { listStyle: block.listStyle } : {}) },
        content: block.items.map((item, itemIndex) => listItemToPm(item, blockId, index, itemIndex)),
      };
    case "horizontalRule":
      return { type: "horizontalRule", attrs: { blockId } };
    case "table": {
      assertValidAiTableGrid(block.rows);
      return {
        type: "table",
        attrs: { blockId },
        content: block.rows.map((row, rowIndex) => ({
          type: "tableRow",
          content: row.cells.map((cell, cellIndex) => cellToPm(cell, {
            blockId,
            rowIndex,
            cellIndex,
            header: row.header === true || cell.header === true,
          })),
        })),
      };
    }
    case "image":
      return { type: "image", attrs: { blockId, src: block.src, alt: block.alt ?? null, title: block.title ?? null, caption: block.caption ?? null, width: block.width ?? null, height: block.height ?? null, align: block.align ?? "center" } };
    case "diagram": {
      // 安全:绝不信任模型给的 svg(会被 dangerouslySetInnerHTML 注入 + 内嵌导出 → 存储型 XSS)。
      // svg 一律置 null,只允许前端渲染并经统一 hardenInlineSvg 加固后回写可信缓存。
      const drawioSource = block.lang === "drawio"
        ? detectDrawioSource(block.lang, block.source)
        : null;
      // 与 codeBlock 入口保持一致：模型给出截断/非法 drawio 时保留原始源码，
      // 降级为可编辑代码块，不能让单个坏图导致整份 AI-IR 编译失败。
      if (block.lang === "drawio" && drawioSource === null) {
        return {
          type: "codeBlock",
          attrs: { blockId, language: "drawio" },
          content: block.source ? [{ type: "text", text: block.source }] : [],
        };
      }
      return {
        type: "diagram",
        attrs: {
          blockId,
          lang: block.lang,
          source: drawioSource ?? block.source,
          svg: null,
        },
      };
    }
    case "fileAttachment":
      return {
        type: "fileAttachment",
        attrs: { blockId, fileId: block.fileId, filename: block.filename, mimeType: block.mimeType, size: block.size },
      };
    case "penNote":
      return { type: "penNote", attrs: { blockId }, content: runsToInline(block.runs, blockId) };
    case "taskList":
      return {
        type: "taskList",
        attrs: { blockId },
        content: block.items.map((item, itemIndex) => taskItemToPm(item, blockId, index, itemIndex)),
      };
    case "callout":
      return {
        type: "callout",
        attrs: { blockId, emoji: block.emoji ?? null, tone: block.tone ?? null },
        content: calloutContentToPm(block, blockId, index),
      };
    case "columnList":
      return {
        type: "columnList",
        attrs: { blockId },
        content: block.columns.map((column, columnIndex) => ({
          type: "column",
          attrs: {
            blockId: `${blockId}-col-${columnIndex + 1}`,
            widthRatio: column.widthRatio ?? null,
          },
          content: column.blocks.map((child, childIndex) =>
            blockToPm(child, `${index}-col-${columnIndex + 1}-child-${childIndex + 1}`),
          ),
        })),
      };
    case "blockMath":
      return { type: "blockMath", attrs: { blockId, latex: block.latex } };
  }
}

function containerContentToPm(
  block: Extract<AiBlock, { type: "blockquote" | "callout" }>,
  blockId: string,
  index: number | string,
): PmBlockNode[] {
  if (block.blocks) {
    return block.blocks.map((child, childIndex) =>
      blockToPm(child, `${index}-${block.type}-child-${childIndex + 1}`),
    );
  }
  return [{
    type: "paragraph",
    attrs: { blockId: `${blockId}-p` },
    content: runsToInline(block.runs, `${blockId}-p`),
  }];
}

function calloutContentToPm(
  block: Extract<AiBlock, { type: "callout" }>,
  blockId: string,
  index: number | string,
): PmParagraphNode[] {
  const content = containerContentToPm(block, blockId, index);
  if (content.some((child) => child.type !== "paragraph")) {
    throw new Error("callout blocks must contain paragraphs only");
  }
  return content as PmParagraphNode[];
}

function listItemToPm(
  item: AiListItem,
  listBlockId: string,
  listIndex: number | string,
  itemIndex: number,
) {
  const itemBlockId = `${listBlockId}-item-${itemIndex + 1}`;
  const childBlocks = (item.children ?? []).map((child, childIndex) =>
    blockToPm(child, `${listIndex}-item-${itemIndex + 1}-child-${childIndex + 1}`),
  );
  return {
    type: "listItem" as const,
    attrs: { blockId: itemBlockId },
    content: [
      {
        type: "paragraph" as const,
        attrs: { blockId: `${itemBlockId}-p` },
        content: runsToInline(item.runs, `${itemBlockId}-p`),
      },
      ...childBlocks,
    ],
  };
}

function taskItemToPm(
  item: AiTaskListItem,
  listBlockId: string,
  listIndex: number | string,
  itemIndex: number,
): PmTaskItemNode {
  const itemBlockId = `${listBlockId}-item-${itemIndex + 1}`;
  const childBlocks = (item.children ?? []).map((child, childIndex) =>
    blockToPm(child, `${listIndex}-item-${itemIndex + 1}-child-${childIndex + 1}`),
  );
  return {
    type: "taskItem",
    attrs: { blockId: itemBlockId, checked: item.checked === true },
    content: [
      {
        type: "paragraph",
        attrs: { blockId: `${itemBlockId}-p` },
        content: runsToInline(item.runs, `${itemBlockId}-p`),
      },
      ...childBlocks,
    ],
  };
}

function attrsWithAlign(blockId: string, textAlign: PmTextAlign | undefined) {
  return textAlign ? { blockId, textAlign } : { blockId };
}

// PM 的结构 schema 只验证 tableRow/tableCell 形状，不验证 span 展开后的矩形网格。
// 在 AI-IR 编译边界确定性排布逻辑列，拒绝缺格、越界和跨出末行的 rowspan，避免把
// TableMap 会判为 broken 的表格交给编辑器；这里只校验，不猜测或补造任何单元格。
function assertValidAiTableGrid(rows: readonly AiTableRow[]): void {
  let totalCells = 0;
  for (const row of rows) {
    totalCells += row.cells.length;
    if (totalCells > PM_TABLE_MAX_CELLS) {
      throw new Error(`table 单元格总数超过上限 ${PM_TABLE_MAX_CELLS}`);
    }
    for (const cell of row.cells) {
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;
      if (
        !Number.isSafeInteger(colspan) || colspan < 1 || colspan > PM_TABLE_MAX_SPAN ||
        !Number.isSafeInteger(rowspan) || rowspan < 1 || rowspan > PM_TABLE_MAX_SPAN
      ) {
        throw new Error(`table span 超过上限 ${PM_TABLE_MAX_SPAN}`);
      }
    }
  }

  let expectedWidth: number | undefined;
  let activeRowspans: number[] = [];

  rows.forEach((row, rowIndex) => {
    const occupied = activeRowspans.map((remaining) => remaining > 0);
    const nextRowspans = activeRowspans.map((remaining) => Math.max(0, remaining - 1));
    let cursor = 0;

    for (const cell of row.cells) {
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;
      while (occupied[cursor]) cursor += 1;

      let start = cursor;
      while (true) {
        let conflict: number | undefined;
        for (let offset = 0; offset < colspan; offset += 1) {
          if (occupied[start + offset]) {
            conflict = start + offset;
            break;
          }
        }
        if (conflict === undefined) break;
        start = conflict + 1;
        while (occupied[start]) start += 1;
      }

      const end = start + colspan;
      if (end > PM_TABLE_MAX_LOGICAL_COLUMNS) {
        throw new Error(`table 逻辑列数超过上限 ${PM_TABLE_MAX_LOGICAL_COLUMNS}`);
      }
      for (let column = start; column < end; column += 1) {
        occupied[column] = true;
        if (rowspan > 1) nextRowspans[column] = rowspan - 1;
      }
      cursor = end;
    }

    const width = occupied.reduce((last, value, column) => value ? column + 1 : last, 0);
    if (expectedWidth === undefined) expectedWidth = width;
    let hasGap = false;
    for (let column = 0; column < expectedWidth; column += 1) {
      if (!occupied[column]) {
        hasGap = true;
        break;
      }
    }
    if (width !== expectedWidth || hasGap) {
      throw new Error(`table span 网格不完整:第 ${rowIndex + 1} 行展开为 ${width} 列，期望 ${expectedWidth} 列`);
    }
    activeRowspans = nextRowspans;
  });

  if (activeRowspans.some((remaining) => remaining > 0)) {
    throw new Error("table rowspan 超出最后一行");
  }
}

function cellToPm(
  cell: AiTableCell,
  opts: { blockId: string; rowIndex: number; cellIndex: number; header: boolean },
) {
  const cellBlockId = `${opts.blockId}-r${opts.rowIndex + 1}-c${opts.cellIndex + 1}`;
  // cell 背景色往返:仅当是合法主题色才写 attrs,非法值不写(交由 PM 校验,不污染)。
  const bg = cell.backgroundColor;
  const cellAttrs = {
    ...(bg && isAllowedThemeColor(bg) ? { backgroundColor: bg as PmThemeColor } : {}),
    ...(cell.colspan !== undefined ? { colspan: cell.colspan } : {}),
    ...(cell.rowspan !== undefined ? { rowspan: cell.rowspan } : {}),
  };
  const sourceBlocks = cell.blocks.length > 0
    ? cell.blocks
    : [{ type: "paragraph" as const, runs: [] }];
  const singleParagraph = sourceBlocks.length === 1 && sourceBlocks[0]?.type === "paragraph";
  const content = sourceBlocks.map((block, blockIndex) => {
    const compiled = blockToPm(block, `${opts.blockId}-r${opts.rowIndex + 1}-c${opts.cellIndex + 1}-b${blockIndex + 1}`);
    if (block.blockId) return compiled;
    const directBlockId = singleParagraph
      ? `${cellBlockId}-p`
      : `${cellBlockId}-b${blockIndex + 1}`;
    return rebaseBlockIdPrefix(compiled, compiled.attrs.blockId, directBlockId);
  });
  return {
    type: opts.header ? "tableHeader" as const : "tableCell" as const,
    ...(Object.keys(cellAttrs).length > 0 ? { attrs: cellAttrs } : {}),
    content,
  };
}

function rebaseBlockIdPrefix<T extends PmBlockNode>(node: T, oldPrefix: string, newPrefix: string): T {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const attrs = record.attrs && typeof record.attrs === "object" && !Array.isArray(record.attrs)
      ? record.attrs as Record<string, unknown>
      : null;
    const blockId = attrs?.blockId;
    const nextAttrs = typeof blockId === "string" && blockId.startsWith(oldPrefix)
      ? { ...attrs, blockId: `${newPrefix}${blockId.slice(oldPrefix.length)}` }
      : attrs;
    return {
      ...record,
      ...(nextAttrs ? { attrs: nextAttrs } : {}),
      ...(Array.isArray(record.content) ? { content: record.content.map(rewrite) } : {}),
    };
  };
  return rewrite(node) as T;
}

function runsToInline(runs: readonly AiRun[], ownerId: string): PmInlineNode[] {
  const nodes: PmInlineNode[] = [];
  for (const [runIndex, run] of runs.entries()) {
    if (!("text" in run)) {
      nodes.push({
        type: "footnoteReference",
        attrs: {
          id: run.id ?? getDeterministicId("footnote", { ownerId, runIndex, note: run.note }),
          note: run.note,
        },
      });
      continue;
    }
    if (run.text.length === 0) continue;
    // math mark 的 run 整体转 inlineMath 节点(text 即 LaTeX 源码),其他 mark 忽略。
    if (run.marks?.some((mark) => mark.type === "math")) {
      nodes.push({ type: "inlineMath", attrs: { latex: run.text } });
      continue;
    }
    const marks = normalizeMarks(run.marks?.map(markToPm) ?? []);
    const parts = run.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) nodes.push({ type: "hardBreak" });
      if (part.length === 0) return;
      const prev = nodes[nodes.length - 1];
      if (prev?.type === "text" && marksEqual(prev.marks ?? [], marks)) {
        prev.text += part;
        return;
      }
      nodes.push(marks.length > 0 ? { type: "text", text: part, marks } : { type: "text", text: part });
    });
  }
  return nodes;
}

function normalizeMarks(marks: PmMark[]): PmMark[] {
  const seen = new Set<string>();
  const result: PmMark[] = [];
  for (const mark of marks) {
    const key = JSON.stringify(mark);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mark);
  }
  return result;
}

function marksEqual(left: readonly PmMark[], right: readonly PmMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function aiRunMarkToPmMark(mark: AiRunMark): PmMark {
  switch (mark.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strike":
    case "code":
      return { type: mark.type };
    case "strikeThrough":
      return { type: "strike" };
    case "link":
      return {
        type: "link",
        attrs: {
          href: mark.href,
          ...(mark.title == null ? {} : { title: mark.title }),
        },
      };
    case "textColor":
      return { type: "textColor", attrs: { color: mark.color } };
    case "highlight":
      return { type: "highlight", attrs: { color: mark.color } };
    case "math":
      // math 不是 PM mark:语义是"整个 run 即一个 inlineMath 节点",由 runsToInline 整 run 转换。
      throw new Error("math mark 不能与文本样式混用,请把公式 run 单独拆出(text 即 LaTeX 源码)");
  }
}

function markToPm(mark: AiRunMark): PmMark {
  return aiRunMarkToPmMark(mark);
}
