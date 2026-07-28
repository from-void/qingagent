import type { PmBlockNode, PmDoc, PmInlineNode, PmMark, PmParagraphNode, PmHeadingNode, PmTableCellNode, PmListItemNode, PmTaskItemNode } from "../types";
import type { AiBlock, AiDocument, AiListItem, AiRun, AiRunMark, AiTaskListItem } from "./aiIrSchema";

export function pmToAiIr(doc: PmDoc): AiDocument {
  return {
    blocks: doc.content.map(blockToAi),
  };
}

export function blockToAi(node: PmBlockNode): AiBlock {
  switch (node.type) {
    case "paragraph":
      return withAlign({ type: "paragraph", runs: inlineToRuns(node.content ?? []) }, node);
    case "heading": {
      // 保留标题的 anchor 字段(渲染成 HTML id 供目录链接跳转)
      const headingAnchor = node.attrs.anchor ?? undefined;
      return withAlign(
        headingAnchor != null
          ? { type: "heading", level: node.attrs.level, anchor: headingAnchor, runs: inlineToRuns(node.content ?? []) }
          : { type: "heading", level: node.attrs.level, runs: inlineToRuns(node.content ?? []) },
        node,
      );
    }
    case "blockquote":
      return {
        type: "blockquote",
        blockId: node.attrs.blockId,
        blocks: node.content.map(blockToAiWithId),
      };
    case "codeBlock":
      // language 缺省统一为 "plaintext",与 aiIrToPm 的缺省对称(language:null 往返会漂移成 "plaintext")。
      return { type: "codeBlock", language: node.attrs.language ?? "plaintext", text: inlineToRuns(node.content ?? []).map((run) => run.text).join("") };
    case "bulletList":
      return { type: "bulletList", items: node.content.map(listItemToAi) };
    case "orderedList": {
      const listStyle = node.attrs.listStyle ?? "decimal";
      const start = node.attrs.start ?? 1;
      const block = { type: "orderedList" as const, items: node.content.map(listItemToAi) };
      return {
        ...block,
        ...(start === 1 ? {} : { start }),
        ...(listStyle === "decimal" ? {} : { listStyle }),
      };
    }
    case "horizontalRule":
      return { type: "horizontalRule" };
    case "image":
      return {
        type: "image",
        src: node.attrs.src,
        alt: node.attrs.alt ?? null,
        // 与 codeBlock.language 的缺省策略一致：PM 缺 title 时不凭空注入 null，
        // 保持已有 AI-IR 的省略形态稳定；有值时完整透传。
        ...(node.attrs.title == null ? {} : { title: node.attrs.title }),
        caption: node.attrs.caption ?? null,
        width: node.attrs.width ?? null,
        height: node.attrs.height ?? null,
        align: node.attrs.align ?? "center",
      };
    case "diagram":
      return { type: "diagram", lang: node.attrs.lang, source: node.attrs.source, svg: node.attrs.svg ?? null };
    case "fileAttachment":
      return { type: "fileAttachment", fileId: node.attrs.fileId, filename: node.attrs.filename, mimeType: node.attrs.mimeType, size: node.attrs.size };
    case "penNote":
      return { type: "penNote", runs: inlineToRuns(node.content ?? []) };
    case "taskList":
      return {
        type: "taskList",
        items: node.content.map(taskItemToAi),
      };
    case "callout":
      return {
        type: "callout",
        blockId: node.attrs.blockId,
        emoji: node.attrs.emoji ?? null,
        tone: node.attrs.tone ?? null,
        blocks: node.content.map(blockToAiWithId),
      };
    case "columnList":
      return {
        type: "columnList",
        columns: node.content.map((column) => ({
          widthRatio: column.attrs.widthRatio ?? null,
          blocks: column.content.map(blockToAi),
        })),
      };
    case "blockMath":
      return { type: "blockMath", latex: node.attrs.latex };
    case "table":
      return {
        type: "table",
        rows: node.content.map((row) => ({
          cells: row.content.map(cellToAi),
        })),
      };
  }
}

function blockToAiWithId(node: PmBlockNode): AiBlock {
  return {
    ...blockToAi(node),
    blockId: node.attrs.blockId,
  } as AiBlock;
}

function listItemToAi(item: PmListItemNode): AiListItem {
  const [first, ...rest] = item.content;
  if (first && isInlineOnlyBlock(first)) {
    const runs = inlineToRuns(first.content ?? []);
    const children = rest.map(blockToAi);
    return children.length > 0 ? { runs, children } : { runs };
  }
  const children = item.content.map(blockToAi);
  return children.length > 0 ? { runs: [], children } : { runs: [] };
}

function taskItemToAi(item: PmTaskItemNode): AiTaskListItem {
  const checked = item.attrs.checked === true;
  const [first, ...rest] = item.content;
  if (first?.type === "paragraph") {
    const runs = inlineToRuns(first.content ?? []);
    const children = rest.map(blockToAi);
    return children.length > 0 ? { checked, runs, children } : { checked, runs };
  }
  const children = item.content.map(blockToAi);
  return children.length > 0 ? { checked, runs: [], children } : { checked, runs: [] };
}

function isInlineOnlyBlock(block: PmBlockNode): block is PmParagraphNode | PmHeadingNode | Extract<PmBlockNode, { type: "penNote" }> {
  return block.type === "paragraph" || block.type === "heading" || block.type === "penNote";
}

function withAlign<T extends Extract<AiBlock, { type: "paragraph" | "heading" }>>(
  block: T,
  node: PmParagraphNode | PmHeadingNode,
): T {
  if (!node.attrs.textAlign) return block;
  return { ...block, textAlign: node.attrs.textAlign };
}

function cellToAi(cell: PmTableCellNode) {
  const bg = cell.attrs?.backgroundColor;
  const colspan = cell.attrs?.colspan ?? 1;
  const rowspan = cell.attrs?.rowspan ?? 1;
  return {
    blocks: cell.content.map(blockToAi),
    ...(cell.type === "tableHeader" ? { header: true } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(colspan > 1 ? { colspan } : {}),
    ...(rowspan > 1 ? { rowspan } : {}),
  };
}

/** AI-IR 规范形:相邻且 marks 相同的文本 run 合并(对称于 runsToInline 的合并),
 *  否则「两个相邻裸 text 节点」与「一个合并节点」两种等价 PM 形态产出不同 AI-IR,
 *  块 hash 往返漂移(fuzz seed 0x513789ba 第四层)。math run 永不合并:
 *  两个相邻公式合并会把两条 latex 拼成一条。 */
function mergeAdjacentRuns(runs: AiRun[]): AiRun[] {
  const out: AiRun[] = [];
  const isMath = (run: AiRun) => run.marks?.some((mark) => mark.type === "math") === true;
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !isMath(prev) &&
      !isMath(run) &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(run.marks ?? [])
    ) {
      out[out.length - 1] = prev.marks ? { text: prev.text + run.text, marks: prev.marks } : { text: prev.text + run.text };
      continue;
    }
    out.push(run);
  }
  return out;
}

function inlineToRuns(content: readonly PmInlineNode[]): AiRun[] {
  const runs: AiRun[] = [];
  for (const node of content) {
    if (node.type === "hardBreak") {
      runs.push({ text: "\n" });
      continue;
    }
    // 行内公式整体作为一个 run:text 即 LaTeX 源码,挂 math mark。
    if (node.type === "inlineMath") {
      runs.push({ text: node.attrs.latex, marks: [{ type: "math" }] });
      continue;
    }
    // 无 marks 时省略键:`marks: undefined` 会进入 getDeterministicId 的稳定串,
    // 造成往返后 ai-block-* id 漂移(p-loop R1 发现的字节级往返不稳定)。
    const marks = node.marks?.map(markToAi);
    // 文本内字面 \n 按 hardBreak 语义拆分,与 runsToInline 的逆向拆分对称:
    // 否则「text 含 \n」与「text+hardBreak+text」两种等价形态产出不同 AI-IR,
    // 往返一轮后块 hash 漂移(fuzz seed 0x513789ba 第二层;\n 可经 updateDoc 注入)。
    const segments = node.text.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) runs.push({ text: "\n" });
      if (segment.length === 0) return;
      runs.push(marks && marks.length > 0 ? { text: segment, marks } : { text: segment });
    });
  }
  return mergeAdjacentRuns(runs);
}

function markToAi(mark: PmMark): AiRunMark {
  switch (mark.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strike":
    case "code":
      return { type: mark.type };
    case "link": {
      const title = mark.attrs.title;
      return typeof title === "string"
        ? { type: "link", href: mark.attrs.href, title }
        : { type: "link", href: mark.attrs.href };
    }
    case "textColor":
      return { type: "textColor", color: mark.attrs.color };
    case "highlight":
      return { type: "highlight", color: mark.attrs.color };
  }
}
