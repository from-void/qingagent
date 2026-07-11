import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { legacySectionsToPm, upgradeMermaidCodeBlocksToDiagram } from "@qingagent/pm-schema";
import type { PmBlockNode, PmDoc, PmTableCellNode } from "@qingagent/pm-schema";
import type {
  ViewBlock,
  ViewBlockSeqDiff,
  ViewColumnDiff,
  ViewDocSpan,
  ViewListRowDiff,
  ViewNestedListDiff,
  ViewTableCellDiff,
  ViewTableRowDiff,
} from "../../data/protocol";
import { PmBlockView, PmTableCellView, applyMarks, MathView, textAlignStyle } from "./PmStaticView";
import { placePatchPopupByAnchorRect } from "./patchHover";
import { viewSectionToLegacy } from "./viewDocHtml";

const ROW_POPUP_HIDE_DELAY_MS = 160;
const ReviewLocalPopupSuppressedContext = createContext(false);

// 审阅态"行级 diff"渲染:列表/待办清单不再整块替换(旧块划除 + 新块整显),而是逐行标注 ——
// 新增/改动行左侧绿条、删除行划除。每个保留/新增/改动行**都用原始 after PM item 走 PmBlockView**
// 渲染,保全嵌套子项 / marks / 行内公式(不经 legacy 拍平);只在行外套状态类。删除行用 oldText。
// 非 diff 块回退 PmBlockView。hover 原文用原始 before PM node 直接 PmBlockView(全保真)。

/** ViewDocSpan[] → React:纯文本走 applyMarks,行内 patch 段包 wf-row-ins/del 高亮。
 *  仅在无原始 node 的兜底路径使用(正常路径逐行走 PmBlockView)。 */
function ReviewSpans({ spans }: { spans: readonly ViewDocSpan[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <ReviewSpan key={i} span={span} />
      ))}
    </>
  );
}

function ReviewSpan({ span }: { span: ViewDocSpan }) {
  switch (span.kind) {
    case "text":
      return <>{applyMarks(span.text, span.marks ?? [])}</>;
    case "math":
      return <MathView latex={span.latex} />;
    case "patchIns":
      return <span className="wf-row-ins">{applyMarks(span.text, span.marks ?? [])}</span>;
    case "patchDel":
      return <span className="wf-row-del">{applyMarks(span.text, span.marks ?? [])}</span>;
    case "patchInsMath":
      return (
        <span className="wf-row-ins">
          <MathView latex={span.latex} />
        </span>
      );
    case "patchDelMath":
      return (
        <span className="wf-row-del">
          <MathView latex={span.latex} />
        </span>
      );
    case "patchMark":
      return <>{applyMarks(span.text, span.marks)}</>;
    case "selectable":
      return <>{span.text}</>;
    default:
      return null;
  }
}

type ListDiffBlock = Extract<ViewBlock, { kind: "list" | "taskList" }> & {
  rowDiff: readonly ViewListRowDiff[];
};

type ListNode = Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>;

function isTaskListNode(node: PmBlockNode | undefined): boolean {
  return node?.type === "taskList";
}

function isListNode(node: PmBlockNode | undefined): node is ListNode {
  return node?.type === "bulletList" || node?.type === "orderedList" || node?.type === "taskList";
}

type ListItemLike = {
  attrs?: { checked?: boolean };
  content?: PmBlockNode[];
};

function listItemChildren(item: ListItemLike | undefined): PmBlockNode[] {
  return item?.content ?? [];
}

function nestedListChildren(item: ListItemLike | undefined): PmBlockNode[] {
  return listItemChildren(item).filter(isListNode);
}

function directListItemChildren(item: ListItemLike | undefined): PmBlockNode[] {
  return listItemChildren(item).filter((child) => !isListNode(child));
}

/** granular 局部改动共用的 hover：锚点可以是 li / td / div，弹层只承载该局部的旧内容。 */
function useReviewOriginalPopup<T extends HTMLElement>(original: React.ReactNode, patchIndex?: number) {
  const suppressed = useContext(ReviewLocalPopupSuppressedContext);
  const [visible, setVisible] = useState(false);
  const anchorRef = useRef<T>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (suppressed) return;
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setVisible(true);
  };
  const scheduleHide = () => {
    if (suppressed) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
    }, ROW_POPUP_HIDE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!visible) {
      setStyle(undefined);
      return;
    }
    if (!anchorRef.current || !popupRef.current || typeof window === "undefined") return;
    setStyle(placePatchPopupByAnchorRect(anchorRef.current.getBoundingClientRect(), popupRef.current.getBoundingClientRect()));
  }, [visible]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const portalTarget = typeof document !== "undefined" ? document.getElementById("view-workspace") ?? document.body : null;
  const popup = !suppressed && visible && portalTarget
    ? createPortal(
        <div
          ref={popupRef}
          className="patch-hover-popup patch-row-popup is-visible"
          style={style}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          <span className="patch-popup-title">{patchIndex !== undefined ? `#${patchIndex} · 替换` : "替换"}</span>
          <div className="patch-popup-original">
            <span className="patch-popup-label">原文</span>
            <div className="patch-popup-original-text">{original}</div>
          </div>
        </div>,
        portalTarget,
      )
    : null;

  return { anchorRef, show, scheduleHide, popup };
}

/** 改动行(changed):正文显示改后内容,hover **只弹这一行**的原文(替代块级整份原列表卡)。
 *  自管弹层(portal 到 #view-workspace),不经 PatchHoverLayer——后者对 granular 块已整体让位。 */
function RowChangedLi({
  isTask,
  checked,
  original,
  patchIndex,
  children,
}: {
  isTask: boolean;
  checked: boolean;
  original: React.ReactNode;
  patchIndex?: number;
  children: React.ReactNode;
}) {
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLLIElement>(original, patchIndex);

  return (
    <li
      ref={anchorRef}
      className="wf-list-row wf-list-row--changed"
      data-type={isTask ? "taskItem" : undefined}
      data-checked={isTask ? checked : undefined}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      {isTask ? (
        <>
          <input type="checkbox" checked={checked} disabled readOnly />
          <div>{children}</div>
        </>
      ) : (
        children
      )}
      {popup}
    </li>
  );
}

/** changed 行 hover 的"原文":优先用原始 before item(旧勾选态 + 旧格式所见即所得),兜底纯文本。
 *  渲成一条与正文同构的迷你行(taskList 带旧勾选框),让用户直观看到"这一行改前长什么样"。 */
function renderRowOriginal(beforeItem: ListItemLike | undefined, oldText: string, isTask: boolean): React.ReactNode {
  // hover 只显示当前行自身；嵌套子列表由它们各自的行级 diff/hover 负责，不能把整条旧分支带进来。
  const beforeContent = directListItemChildren(beforeItem as ListItemLike | undefined);
  const content = beforeContent.length > 0
    ? beforeContent.map((child, j) => <PmBlockView key={j} node={child} />)
    : oldText;
  if (isTask) {
    // 待办:旧勾选框状态是"这一行改了什么"的关键,保留它(与正文 taskItem 同构)。
    const beforeChecked = beforeItem?.attrs?.checked ?? false;
    return (
      <ul className="pm-task-list" data-type="taskList">
        <li data-type="taskItem" data-checked={beforeChecked}>
          <input type="checkbox" checked={beforeChecked} disabled readOnly />
          <div>{content}</div>
        </li>
      </ul>
    );
  }
  // 无序/有序列表:单行原文的项目符号/序号是噪声(且有序单项 <ol> 会显错误"1.")——只渲内容本身。
  return <div className="wf-row-orig">{content}</div>;
}

function ReviewNestedLists({
  diffs,
  beforeItem,
  afterItem,
  patchIndex,
}: {
  diffs: readonly ViewNestedListDiff[] | undefined;
  beforeItem: ListItemLike | undefined;
  afterItem: ListItemLike | undefined;
  patchIndex?: number;
}) {
  const beforeLists = nestedListChildren(beforeItem);
  const afterLists = nestedListChildren(afterItem);
  // 兼容旧/手工构造的 rowDiff：没有递归协议时仍按原始 PM node 保真显示嵌套列表。
  if (!diffs?.length) {
    const lists = afterLists.length > 0 ? afterLists : beforeLists;
    return <>{lists.map((node, index) => <PmBlockView key={node.attrs.blockId ?? index} node={node} />)}</>;
  }
  return (
    <>
      {diffs.map((diff, index) => (
        <ReviewListLevel
          key={`${diff.beforeListIndex ?? "x"}:${diff.afterListIndex ?? "x"}:${index}`}
          rowDiff={diff.rowDiff}
          beforeNode={diff.beforeListIndex === undefined ? undefined : beforeLists[diff.beforeListIndex]}
          afterNode={diff.afterListIndex === undefined ? undefined : afterLists[diff.afterListIndex]}
          patchIndex={patchIndex}
        />
      ))}
    </>
  );
}

/** 单层列表 diff；每层各自维护 before/after 游标，子列表递归进入同一渲染器。 */
function ReviewListLevel({
  rowDiff,
  beforeNode,
  afterNode,
  patchIndex,
  fallback,
}: {
  rowDiff: readonly ViewListRowDiff[];
  beforeNode?: PmBlockNode;
  afterNode?: PmBlockNode;
  patchIndex?: number;
  fallback?: { isTask: boolean; ordered: boolean; start?: number };
}) {
  const listNode = isListNode(afterNode) ? afterNode : isListNode(beforeNode) ? beforeNode : undefined;
  const isTask = listNode ? isTaskListNode(listNode) : fallback?.isTask ?? false;
  const beforeItems = isListNode(beforeNode) ? beforeNode.content as unknown as ListItemLike[] : [];
  const afterItems = isListNode(afterNode) ? afterNode.content as unknown as ListItemLike[] : [];
  let beforeCursor = 0;
  let afterCursor = 0;

  const items = rowDiff.map((row, i) => {
    const beforeItem = row.status === "added" ? undefined : beforeItems[beforeCursor++];
    const afterItem = row.status === "removed" ? undefined : afterItems[afterCursor++];
    const cls = `wf-list-row wf-list-row--${row.status}`;
    const directContent = directListItemChildren(afterItem);
    const body = row.status === "removed"
      ? <s className="wf-row-del">{row.oldText}</s>
      : directContent.length > 0
        ? directContent.map((child, j) => <PmBlockView key={child.attrs.blockId ?? j} node={child} />)
        : <ReviewSpans spans={row.spans} />;
    const nested = (
      <ReviewNestedLists
        diffs={row.childLists}
        beforeItem={beforeItem}
        afterItem={afterItem}
        patchIndex={patchIndex}
      />
    );
    const checked = afterItem?.attrs?.checked ?? row.checked ?? false;

    if (row.status === "changed") {
      const beforeContent = renderRowOriginal(beforeItem, row.oldText, isTask);
      return (
        <RowChangedLi key={i} isTask={isTask} checked={checked} original={beforeContent} patchIndex={patchIndex}>
          {body}
          {nested}
        </RowChangedLi>
      );
    }
    if (isTask) {
      return (
        <li key={i} className={cls} data-type="taskItem" data-checked={checked}>
          <input type="checkbox" checked={checked} disabled readOnly />
          <div>
            {body}
            {nested}
          </div>
        </li>
      );
    }
    return (
      <li key={i} className={cls}>
        {body}
        {nested}
      </li>
    );
  });

  if (isTask) return <ul className="pm-task-list" data-type="taskList">{items}</ul>;
  const ordered = listNode ? listNode.type === "orderedList" : fallback?.ordered ?? false;
  const start = listNode?.type === "orderedList" ? listNode.attrs.start : fallback?.start;
  if (ordered) return <ol start={start ?? undefined}>{items}</ol>;
  return <ul>{items}</ul>;
}

/** 列表/待办清单的递归行级 diff。原始 PM 行保全 marks/公式，嵌套列表按 childLists 下钻。 */
function ReviewListDiff({ block, beforeNode, patchIndex }: { block: ListDiffBlock; beforeNode?: PmBlockNode; patchIndex?: number }) {
  const afterNode = (block as { node?: PmBlockNode }).node;
  return (
    <ReviewListLevel
      rowDiff={block.rowDiff}
      beforeNode={beforeNode}
      afterNode={afterNode}
      patchIndex={patchIndex}
      fallback={{
        isTask: block.kind === "taskList",
        ordered: block.kind === "list" && block.ordered,
        ...(block.kind === "list" && block.start !== undefined ? { start: block.start } : {}),
      }}
    />
  );
}

type TextReviewSpan = Extract<ViewDocSpan, { text: string }>;
type TableNode = Extract<PmBlockNode, { type: "table" }>;
type CalloutNode = Extract<PmBlockNode, { type: "callout" }>;
type ColumnListNode = Extract<PmBlockNode, { type: "columnList" }>;

function isTableNode(node: PmBlockNode | undefined): node is TableNode {
  return node?.type === "table";
}

function isCalloutNode(node: PmBlockNode | undefined): node is CalloutNode {
  return node?.type === "callout";
}

function isColumnListNode(node: PmBlockNode | undefined): node is ColumnListNode {
  return node?.type === "columnList";
}

function spanAfterLength(span: ViewDocSpan): number {
  if (span.kind === "patchDel" || span.kind === "patchDelMath") return 0;
  if (span.kind === "math" || span.kind === "patchInsMath") return 1;
  return Array.from(span.text).length;
}

function withSpanText(span: TextReviewSpan, text: string): TextReviewSpan {
  return { ...span, text } as TextReviewSpan;
}

/** 按“改后内容”长度切 spans；删除片段不消费改后长度，留在它实际出现的块内。 */
function splitReviewSpansAtAfterLength(
  spans: readonly ViewDocSpan[],
  afterLength: number,
): [ViewDocSpan[], ViewDocSpan[]] {
  const left: ViewDocSpan[] = [];
  const right: ViewDocSpan[] = [];
  let consumed = 0;
  let split = false;
  for (const span of spans) {
    if (split) {
      right.push(span);
      continue;
    }
    const length = spanAfterLength(span);
    if (length === 0) {
      if (consumed < afterLength) left.push(span);
      else {
        right.push(span);
        split = true;
      }
      continue;
    }
    if (consumed + length <= afterLength) {
      left.push(span);
      consumed += length;
      continue;
    }
    if (span.kind === "math" || span.kind === "patchInsMath" || span.kind === "patchDelMath") {
      right.push(span);
      split = true;
      continue;
    }
    const chars = Array.from(span.text);
    const take = Math.max(0, afterLength - consumed);
    if (take > 0) left.push(withSpanText(span, chars.slice(0, take).join("")));
    if (take < chars.length) right.push(withSpanText(span, chars.slice(take).join("")));
    consumed = afterLength;
    split = true;
  }
  return [left, right];
}

function inlineContentLength(node: PmBlockNode): number {
  if (!("content" in node) || !Array.isArray(node.content)) return 0;
  return node.content.reduce((sum, child) => {
    if (child.type === "hardBreak" || child.type === "inlineMath") return sum + 1;
    if (child.type === "text") return sum + Array.from(child.text).length;
    return sum;
  }, 0);
}

function reviewableBlockAfterLength(node: PmBlockNode): number {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
    case "codeBlock":
      return inlineContentLength(node);
    case "blockquote":
      return node.content.reduce((sum, child, index) => sum + reviewableBlockAfterLength(child) + (index > 0 ? 1 : 0), 0);
    default:
      return 0;
  }
}

function ReviewPmBlockWithSpans({ node, spans }: { node: PmBlockNode; spans: readonly ViewDocSpan[] }) {
  const children = <ReviewSpans spans={spans} />;
  switch (node.type) {
    case "paragraph":
      return <p style={textAlignStyle(node.attrs.textAlign)}>{children}</p>;
    case "heading": {
      const props = { style: textAlignStyle(node.attrs.textAlign) };
      switch (node.attrs.level) {
        case 1: return <h1 {...props}>{children}</h1>;
        case 2: return <h2 id={node.attrs.anchor ?? undefined} {...props}>{children}</h2>;
        case 3: return <h3 {...props}>{children}</h3>;
        case 4: return <h4 {...props}>{children}</h4>;
        case 5: return <h5 {...props}>{children}</h5>;
        case 6: return <h6 {...props}>{children}</h6>;
      }
    }
    case "penNote":
      return <p style={{ color: "var(--ink-3)", fontSize: 12.5, fontStyle: "italic" }}>{children}</p>;
    case "codeBlock":
      return <pre className="md-code-block" data-language={node.attrs.language ?? "plaintext"}>{children}</pre>;
    case "blockquote":
      return <blockquote><ReviewPmBlocksWithSpans nodes={node.content} spans={spans} /></blockquote>;
    default:
      return <PmBlockView node={node} />;
  }
}

/** 保留原始多块结构，仅把可审阅的行内叶子替换成 spans。 */
function ReviewPmBlocksWithSpans({ nodes, spans }: { nodes: readonly PmBlockNode[]; spans: readonly ViewDocSpan[] }) {
  let remaining = [...spans];
  return (
    <>
      {nodes.map((node, index) => {
        if (index > 0 && remaining.length > 0) {
          const [, afterSeparator] = splitReviewSpansAtAfterLength(remaining, 1);
          remaining = afterSeparator;
        }
        const length = reviewableBlockAfterLength(node);
        if (length === 0) return <PmBlockView key={node.attrs.blockId ?? index} node={node} />;
        const [blockSpans, rest] = splitReviewSpansAtAfterLength(remaining, length);
        remaining = rest;
        return <ReviewPmBlockWithSpans key={node.attrs.blockId ?? index} node={node} spans={blockSpans} />;
      })}
    </>
  );
}

function ChangedTableCell({
  cell,
  beforeCell,
  diff,
  patchIndex,
}: {
  cell: PmTableCellNode;
  beforeCell?: PmTableCellNode;
  diff: Extract<ViewTableCellDiff, { status: "changed" }>;
  patchIndex?: number;
}) {
  const original = beforeCell
    ? <div className="wf-row-orig">{beforeCell.content.map((child, index) => <PmBlockView key={child.attrs.blockId ?? index} node={child} />)}</div>
    : <div className="wf-row-orig">{diff.oldText}</div>;
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLTableCellElement>(original, patchIndex);
  return (
    <PmTableCellView
      cell={cell}
      className="wf-table-cell wf-table-cell--changed"
      cellRef={anchorRef}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      {cell.content.map((child, index) => <PmBlockView key={child.attrs.blockId ?? index} node={child} />)}
      {popup}
    </PmTableCellView>
  );
}

/** 原始 before/after 表行双游标对齐 cellDiff，单元格壳始终来自 PM node。 */
function ReviewTableDiff({
  node,
  beforeNode,
  cellDiff,
  patchIndex,
}: {
  node: TableNode;
  beforeNode?: PmBlockNode;
  cellDiff: readonly ViewTableRowDiff[];
  patchIndex?: number;
}) {
  const beforeRows = isTableNode(beforeNode) ? beforeNode.content : [];
  const afterRows = node.content;
  let beforeCursor = 0;
  let afterCursor = 0;
  const rows = cellDiff.map((rowDiff, rowIndex) => {
    const beforeRow = rowDiff.status === "added" ? undefined : beforeRows[beforeCursor++];
    const afterRow = rowDiff.status === "removed" ? undefined : afterRows[afterCursor++];
    const row = afterRow ?? beforeRow;
    if (!row) return null;
    const rowClass = `wf-table-row wf-table-row--${rowDiff.status}`;
    return (
      <tr key={rowIndex} className={rowClass}>
        {Array.from({ length: Math.max(row.content.length, rowDiff.cells.length) }, (_, cellIndex) => {
          const afterCell = afterRow?.content[cellIndex];
          const beforeCell = beforeRow?.content[cellIndex];
          const cell = afterCell ?? beforeCell;
          if (!cell) return null;
          const diff = rowDiff.cells[cellIndex];
          if (rowDiff.status === "changed" && diff?.status === "changed") {
            return (
              <ChangedTableCell
                key={cellIndex}
                cell={cell}
                beforeCell={beforeCell}
                diff={diff}
                patchIndex={patchIndex}
              />
            );
          }
          return <PmTableCellView key={cellIndex} cell={cell} className="wf-table-cell" />;
        })}
      </tr>
    );
  });
  return <div className="pm-table-scroll"><table><tbody>{rows}</tbody></table></div>;
}

function ChangedContainerTextBlock({
  node,
  beforeNode,
  spans,
  oldText,
  patchIndex,
}: {
  node: PmBlockNode;
  beforeNode?: PmBlockNode;
  spans: readonly ViewDocSpan[];
  oldText: string;
  patchIndex?: number;
}) {
  const original = beforeNode ? <PmBlockView node={beforeNode} /> : <div className="wf-row-orig">{oldText}</div>;
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLDivElement>(original, patchIndex);
  return (
    <div
      ref={anchorRef}
      className="wf-container-block wf-container-block--changed"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <ReviewPmBlockWithSpans node={node} spans={spans} />
      {popup}
    </div>
  );
}

function ChangedContainerBlock({
  node,
  beforeNode,
  patchIndex,
}: {
  node: PmBlockNode;
  beforeNode?: PmBlockNode;
  patchIndex?: number;
}) {
  const original = beforeNode ? <PmBlockView node={beforeNode} /> : null;
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLDivElement>(original, patchIndex);
  return (
    <div
      ref={anchorRef}
      className="wf-container-block wf-container-block--changed"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <PmBlockView node={node} />
      {popup}
    </div>
  );
}

function ReviewBlockSeqDiffView({
  diff,
  beforeNodes,
  afterNodes,
  patchIndex,
}: {
  diff: readonly ViewBlockSeqDiff[number][];
  beforeNodes: readonly PmBlockNode[];
  afterNodes: readonly PmBlockNode[];
  patchIndex?: number;
}) {
  let beforeCursor = 0;
  let afterCursor = 0;
  return (
    <>
      {diff.map((entry, index) => {
        const beforeBlock = entry.status === "added" ? undefined : beforeNodes[beforeCursor++];
        const afterBlock = entry.status === "removed" ? undefined : afterNodes[afterCursor++];
        if (entry.status === "same") return <PmBlockView key={index} node={afterBlock ?? entry.block} />;
        if (entry.status === "added") {
          return <div key={index} className="wf-container-block wf-container-block--added"><PmBlockView node={afterBlock ?? entry.block} /></div>;
        }
        if (entry.status === "removed") {
          return (
            <div key={index} className="wf-container-block wf-container-block--removed">
              {beforeBlock ? <PmBlockView node={beforeBlock} /> : <s className="wf-row-del">{entry.oldText}</s>}
            </div>
          );
        }
        if (entry.kind === "text") {
          return (
            <ChangedContainerTextBlock
              key={index}
              node={afterBlock ?? entry.node}
              beforeNode={beforeBlock}
              spans={entry.spans}
              oldText={entry.oldText}
              patchIndex={patchIndex}
            />
          );
        }
        if (entry.kind === "list") {
          return (
            <ReviewListLevel
              key={index}
              rowDiff={entry.rowDiff}
              beforeNode={beforeBlock}
              afterNode={afterBlock ?? entry.node}
              patchIndex={patchIndex}
            />
          );
        }
        if (entry.kind === "block") {
          return (
            <ChangedContainerBlock
              key={index}
              node={afterBlock ?? entry.node}
              beforeNode={beforeBlock}
              patchIndex={patchIndex}
            />
          );
        }
        return (
          <ReviewTableDiff
            key={index}
            node={(afterBlock ?? entry.node) as TableNode}
            beforeNode={beforeBlock}
            cellDiff={entry.cellDiff}
            patchIndex={patchIndex}
          />
        );
      })}
    </>
  );
}

function ReviewCalloutDiff({ block, beforeNode, patchIndex }: { block: Extract<ViewBlock, { kind: "callout" }>; beforeNode?: PmBlockNode; patchIndex?: number }) {
  const node = block.node as CalloutNode;
  const beforeContent = isCalloutNode(beforeNode) ? beforeNode.content : [];
  return (
    <div className={`pm-callout pm-callout--${node.attrs.tone ?? "info"}`} data-pm-node="callout">
      <span className="pm-callout-emoji">{node.attrs.emoji ?? "💡"}</span>
      <div className="pm-callout-body">
        <ReviewBlockSeqDiffView diff={block.bodyDiff ?? []} beforeNodes={beforeContent} afterNodes={node.content} patchIndex={patchIndex} />
      </div>
    </div>
  );
}

function ReviewColumnListDiff({ block, beforeNode, patchIndex }: { block: Extract<ViewBlock, { kind: "columnList" }>; beforeNode?: PmBlockNode; patchIndex?: number }) {
  const node = block.node as ColumnListNode;
  const beforeColumns = isColumnListNode(beforeNode) ? beforeNode.content : [];
  const columnsDiff: readonly ViewColumnDiff[] = block.columnsDiff ?? node.content.map((_, afterColumnIndex): ViewColumnDiff => ({
    status: "same" as const,
    afterColumnIndex,
    bodyDiff: [],
  }));
  const displayColumns = columnsDiff.map((columnDiff) => {
    const column = columnDiff.afterColumnIndex !== undefined
      ? node.content[columnDiff.afterColumnIndex]
      : columnDiff.beforeColumnIndex !== undefined
        ? beforeColumns[columnDiff.beforeColumnIndex]
        : undefined;
    return { columnDiff, column };
  }).filter((entry): entry is typeof entry & { column: NonNullable<typeof entry.column> } => Boolean(entry.column));
  const widthPercent = (column: (typeof displayColumns)[number]["column"]) => {
    const ratio = column.attrs.widthRatio;
    const normalized = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
      ? ratio
      : 1 / Math.max(1, displayColumns.length);
    return `${normalized * 100}%`;
  };
  return (
    <div className="pm-column-list" data-pm-node="columnList" style={{ display: "flex", gap: 16, alignItems: "stretch", width: "100%" }}>
      {displayColumns.map(({ columnDiff, column }, displayIndex) => {
        const beforeNodes = columnDiff.beforeColumnIndex !== undefined
          ? beforeColumns[columnDiff.beforeColumnIndex]?.content ?? []
          : [];
        const afterNodes = columnDiff.afterColumnIndex !== undefined
          ? node.content[columnDiff.afterColumnIndex]?.content ?? []
          : [];
        return (
          <div
            key={`${columnDiff.status}-${column.attrs.blockId ?? displayIndex}`}
            className={`pm-column wf-column wf-column--${columnDiff.status}`}
            data-pm-node="column"
            data-column-status={columnDiff.status}
            style={{ flexGrow: 0, flexShrink: 1, flexBasis: widthPercent(column), minWidth: 0 }}
          >
            <ReviewBlockSeqDiffView
              diff={columnDiff.bodyDiff}
              beforeNodes={beforeNodes}
              afterNodes={afterNodes}
              patchIndex={patchIndex}
            />
          </div>
        );
      })}
    </div>
  );
}

/** 原始 PM node[] → React(mermaid 升级后逐块 PmBlockView)。hover 原文 / 兜底渲染共用。 */
function renderPmNodes(nodes: readonly PmBlockNode[]): React.ReactNode {
  const pmDoc = upgradeMermaidCodeBlocksToDiagram({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: nodes as PmBlockNode[],
  } as PmDoc);
  return (pmDoc.content as PmBlockNode[]).map((node, i) => <PmBlockView key={i} node={node} />);
}

/** ViewBlock → PmBlockNode[]:优先原始 node,兜底走 legacy 回转 + mermaid 升级。 */
function viewBlockToPmNodes(block: ViewBlock): PmBlockNode[] {
  const original = (block as { node?: PmBlockNode }).node;
  if (original) return [original];
  const content = legacySectionsToPm([viewSectionToLegacy(block)] as never).content as PmBlockNode[];
  const doc = upgradeMermaidCodeBlocksToDiagram({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content,
  } as PmDoc);
  return doc.content as PmBlockNode[];
}

/** 单个 ViewBlock 的审阅渲染:列表 / 表格 / callout / columnList 消费各自 granular diff，
 *  beforeNode 用于把 changed 行、格、块的 hover 限定为对应旧节点。 */
function ReviewBlockViewContent({ block, beforeNode, patchIndex }: { block: ViewBlock; beforeNode?: PmBlockNode; patchIndex?: number }) {
  if ((block.kind === "list" || block.kind === "taskList") && block.rowDiff && block.rowDiff.length > 0) {
    return <ReviewListDiff block={block as ListDiffBlock} beforeNode={beforeNode} patchIndex={patchIndex} />;
  }
  if (block.kind === "table" && block.cellDiff && block.cellDiff.length > 0 && isTableNode(block.node)) {
    return <ReviewTableDiff node={block.node} beforeNode={beforeNode} cellDiff={block.cellDiff} patchIndex={patchIndex} />;
  }
  if (block.kind === "callout" && block.bodyDiff && block.bodyDiff.length > 0) {
    return <ReviewCalloutDiff block={block} beforeNode={beforeNode} patchIndex={patchIndex} />;
  }
  if (block.kind === "columnList" && block.columnsDiff && block.columnsDiff.length > 0) {
    return <ReviewColumnListDiff block={block} beforeNode={beforeNode} patchIndex={patchIndex} />;
  }
  const nodes = viewBlockToPmNodes(block);
  return (
    <>
      {nodes.map((node, i) => (
        <PmBlockView key={i} node={node} />
      ))}
    </>
  );
}

export function ReviewBlockView({
  block,
  beforeNode,
  patchIndex,
  suppressLocalPopup = false,
}: {
  block: ViewBlock;
  beforeNode?: PmBlockNode;
  patchIndex?: number;
  suppressLocalPopup?: boolean;
}) {
  return (
    <ReviewLocalPopupSuppressedContext.Provider value={suppressLocalPopup}>
      <ReviewBlockViewContent block={block} beforeNode={beforeNode} patchIndex={patchIndex} />
    </ReviewLocalPopupSuppressedContext.Provider>
  );
}

/** hover 卡片"原文"用:把原始 before PM node 渲成真内容(表格合并单元格/嵌套列表/图表/公式所见即所得,
 *  与正文渲染同源),而不是把 markdown 源码散排。外层是块级 div(供 PatchStatePopup 走块布局)。
 *  `.pm-hover-original` 自带紧凑表格边框样式(不借 `.wf-doc`,避免吃到整篇纸张 padding/min-height 污染)。 */
export function ReviewBlocksStatic({ nodes }: { nodes: readonly PmBlockNode[] }) {
  return <div className="pm-static-view pm-hover-original">{renderPmNodes(nodes)}</div>;
}
