import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { legacySectionsToPm, upgradeMermaidCodeBlocksToDiagram } from "@qingagent/pm-schema";
import type { PmBlockNode, PmDoc, PmMark, PmTableCellNode } from "@qingagent/pm-schema";
import type {
  ViewBlock,
  ViewBlockSeqDiff,
  ViewColumnDiff,
  ViewDocSpan,
  ViewListRowDiff,
  ViewNestedListDiff,
  ReviewTarget,
  ViewTableCellDiff,
  ViewTableRowDiff,
} from "../../data/protocol";
import {
  PmBlockView,
  PmTableCellView,
  PmTableScroll,
  applyMarks,
  MathView,
  staticTableCellLogicalColumns,
  textAlignStyle,
} from "./PmStaticView";
import { placePatchPopupByAnchorRect } from "./patchHover";
import { viewSectionToLegacy } from "./viewDocHtml";

const ROW_POPUP_HIDE_DELAY_MS = 160;
const ReviewLocalPopupSuppressedContext = createContext(false);
const ReviewTargetContext = createContext<{
  byPath: ReadonlyMap<string, ReviewTarget>;
  activeTargetId?: string | null;
  fallbackIndex?: number;
}>({ byPath: new Map() });

// 审阅态"行级 diff"渲染:列表/待办清单不再整块替换(旧块划除 + 新块整显),而是逐行标注 ——
// 新增/改动行左侧绿条、删除行只留紧凑标记。每个保留/新增/改动行**都用原始 after PM item 走 PmBlockView**
// 渲染,保全嵌套子项 / marks / 行内公式(不经 legacy 拍平);只在行外套状态类。删除原文仅进 hover。
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

// 行内 spans 用 "\n" 承载 hardBreak(见 protocol.pmInlineSpans);字符级渲染需把它还原成 <br>,
// 否则换行会塌成空格、丢保真。无 "\n" 时与 applyMarks 等价。
function applyMarksWithBreaks(text: string, marks: PmMark[]): React.ReactNode {
  if (!text.includes("\n")) return applyMarks(text, marks);
  const parts = text.split("\n");
  return parts.map((part, i) => (
    <React.Fragment key={i}>
      {i > 0 ? <br /> : null}
      {applyMarks(part, marks)}
    </React.Fragment>
  ));
}

function ReviewSpan({ span }: { span: ViewDocSpan }) {
  switch (span.kind) {
    case "text":
      return <>{applyMarksWithBreaks(span.text, span.marks ?? [])}</>;
    case "math":
      return <MathView latex={span.latex} />;
    case "patchIns":
      return <span className="wf-row-ins">{applyMarksWithBreaks(span.text, span.marks ?? [])}</span>;
    case "patchDel":
      return null;
    case "patchInsMath":
      return (
        <span className="wf-row-ins">
          <MathView latex={span.latex} />
        </span>
      );
    case "patchDelMath":
      return null;
    case "patchMark":
      return <>{applyMarksWithBreaks(span.text, span.marks)}</>;
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
type ReviewPopupKind = "added" | "removed" | "changed";

function useReviewTarget(path: string) {
  const scope = useContext(ReviewTargetContext);
  const target = scope.byPath.get(path);
  return {
    target,
    targetIndex: target?.index ?? scope.fallbackIndex,
    targetClass: target && scope.activeTargetId === target.id ? " is-current" : "",
    targetAttrs: target ? {
      "data-review-target-id": target.id,
      "data-review-target-index": target.index,
    } : {},
  };
}

function shouldShowLocalPopup(event: React.MouseEvent<HTMLElement>): boolean {
  if (!(event.target instanceof Element)) return true;
  const closestTarget = event.target.closest("[data-review-target-id]");
  return !closestTarget || closestTarget === event.currentTarget;
}

function useReviewOriginalPopup<T extends HTMLElement>(content: React.ReactNode, targetIndex: number | undefined, kind: ReviewPopupKind) {
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
          <span className="patch-popup-title">{targetIndex !== undefined ? `#${targetIndex} · ${kind === "added" ? "新增" : kind === "removed" ? "删除" : "替换"}` : kind === "added" ? "新增" : kind === "removed" ? "删除" : "替换"}</span>
          {kind === "changed" ? (
            // 替换:hover 只显字符级改动片段(旧→新),不再弹整行原文(块级)
            <div className="patch-popup-original">{content}</div>
          ) : (
            <div className="patch-popup-original">
              <span className="patch-popup-label">{kind === "added" ? "本处" : "原文"}</span>
              <div className="patch-popup-original-text">{content}</div>
            </div>
          )}
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
  targetPath,
  children,
}: {
  isTask: boolean;
  checked: boolean;
  original: React.ReactNode;
  targetPath: string;
  children: React.ReactNode;
}) {
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLLIElement>(original, targetIndex, "changed");

  return (
    <li
      ref={anchorRef}
      className={`wf-list-row wf-list-row--changed wf-diff-inline${targetClass}`}
      {...targetAttrs}
      data-type={isTask ? "taskItem" : undefined}
      data-checked={isTask ? checked : undefined}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
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

function ReviewStateLi({
  status,
  isTask,
  checked,
  popupContent,
  targetPath,
  children,
}: {
  status: "added" | "removed";
  isTask: boolean;
  checked: boolean;
  popupContent: React.ReactNode;
  targetPath: string;
  children: React.ReactNode;
}) {
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLLIElement>(popupContent, targetIndex, status);
  return (
    <li
      ref={anchorRef}
      className={`wf-list-row wf-list-row--${status}${status === "added" ? " wf-diff-inline" : ""}${targetClass}`}
      {...targetAttrs}
      data-type={isTask ? "taskItem" : undefined}
      data-checked={isTask && status === "added" ? checked : undefined}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
      onMouseLeave={scheduleHide}
    >
      {status === "removed" ? (
        <>
          <span className="wf-review-delete-marker" aria-label="已删除内容，悬停查看原文" />
          {children}
        </>
      ) : isTask ? (
        <>
          <input type="checkbox" checked={checked} disabled readOnly />
          <div>{children}</div>
        </>
      ) : children}
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

/** changed 的 hover 不再弹整行原文(块级),而是从 diff spans 提取「旧片段 → 新片段」逐处显示
 *  (如 沉思 → 回味)。同一处连续的 patchDel/patchIns 配成一对;遇到未改文本即断开为下一处。
 *  纯增(只有 ins)显示 → 新;纯删(只有 del)显示 旧 →。无任何 patch 段时返回 null(交由兜底)。 */
function renderChangeFragments(spans: readonly ViewDocSpan[] | undefined): React.ReactNode | null {
  if (!spans || spans.length === 0) return null;
  const pairs: Array<{ del: React.ReactNode[]; ins: React.ReactNode[] }> = [];
  let del: React.ReactNode[] = [];
  let ins: React.ReactNode[] = [];
  const flush = () => {
    if (del.length || ins.length) pairs.push({ del, ins });
    del = [];
    ins = [];
  };
  for (const span of spans) {
    switch (span.kind) {
      case "patchDel": del.push(span.text); break;
      case "patchDelMath": del.push(<MathView latex={span.latex} />); break;
      case "patchIns": ins.push(span.text); break;
      case "patchInsMath": ins.push(<MathView latex={span.latex} />); break;
      default: flush(); break; // same/text/math 等未改内容:断开当前改动处
    }
  }
  flush();
  if (pairs.length === 0) return null;
  const seq = (nodes: React.ReactNode[]) => nodes.map((n, j) => <React.Fragment key={j}>{n}</React.Fragment>);
  return (
    <div className="patch-frag-list">
      {pairs.map((p, i) => (
        <div key={i} className="patch-frag">
          {p.del.length ? <span className="patch-frag-old">{seq(p.del)}</span> : null}
          {p.del.length && p.ins.length ? <span className="patch-frag-arrow">→</span> : null}
          {p.ins.length ? <span className="patch-frag-new">{seq(p.ins)}</span> : null}
        </div>
      ))}
    </div>
  );
}

function ReviewNestedLists({
  diffs,
  beforeItem,
  afterItem,
  targetPrefix,
}: {
  diffs: readonly ViewNestedListDiff[] | undefined;
  beforeItem: ListItemLike | undefined;
  afterItem: ListItemLike | undefined;
  targetPrefix: string;
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
          targetPrefix={`${targetPrefix}/nested:${index}`}
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
  targetPrefix,
  fallback,
}: {
  rowDiff: readonly ViewListRowDiff[];
  beforeNode?: PmBlockNode;
  afterNode?: PmBlockNode;
  targetPrefix: string;
  fallback?: { isTask: boolean; ordered: boolean; start?: number; listStyle?: string };
}) {
  const listNode = isListNode(afterNode) ? afterNode : isListNode(beforeNode) ? beforeNode : undefined;
  const isTask = listNode ? isTaskListNode(listNode) : fallback?.isTask ?? false;
  const beforeItems = isListNode(beforeNode) ? beforeNode.content as unknown as ListItemLike[] : [];
  const afterItems = isListNode(afterNode) ? afterNode.content as unknown as ListItemLike[] : [];
  let beforeCursor = 0;
  let afterCursor = 0;

  const items = rowDiff.map((row, i) => {
    const targetPath = `${targetPrefix}/row:${i}`;
    const beforeItem = row.status === "added" ? undefined : beforeItems[beforeCursor++];
    const afterItem = row.status === "removed" ? undefined : afterItems[afterCursor++];
    const cls = `wf-list-row wf-list-row--${row.status}`;
    const directContent = directListItemChildren(afterItem);
    // changed/added 行走字符级 inline diff(与普通段落一致):用 after 段落结构 + row.spans
    // (changed=inlineSpanDiffSpans 只标改动字;added=全 patchIns 整行绿),而不是整行新文本 + 块级底色。
    // 复杂/非文本叶子在 ReviewPmBlockWithSpans 里回退 PmBlockView。
    const body = row.status === "removed"
      ? null
      : (row.status === "changed" || row.status === "added") && directContent.length > 0
        ? <ReviewPmBlocksWithSpans nodes={directContent} spans={row.spans} />
        : directContent.length > 0
          ? directContent.map((child, j) => <PmBlockView key={child.attrs.blockId ?? j} node={child} />)
          : <ReviewSpans spans={row.spans} />;
    const nested = (
      <ReviewNestedLists
        diffs={row.childLists}
        beforeItem={beforeItem}
        afterItem={afterItem}
        targetPrefix={targetPath}
      />
    );
    const checked = afterItem?.attrs?.checked ?? row.checked ?? false;

    if (row.status === "changed") {
      // hover 只弹字符级改动片段(旧→新);无字符级 patch(如仅勾选变更)时兜底整行原文
      const beforeContent = renderChangeFragments(row.spans) ?? renderRowOriginal(beforeItem, row.oldText, isTask);
      return (
        <RowChangedLi key={i} isTask={isTask} checked={checked} original={beforeContent} targetPath={targetPath}>
          {body}
          {nested}
        </RowChangedLi>
      );
    }
    if (row.status === "added" || row.status === "removed") {
      const popupContent = row.status === "removed"
        ? renderRowOriginal(beforeItem, row.oldText, isTask)
        : renderRowOriginal(afterItem, "", isTask);
      return (
        <ReviewStateLi
          key={i}
          status={row.status}
          isTask={isTask}
          checked={checked}
          popupContent={popupContent}
          targetPath={targetPath}
        >
          {body}
          {nested}
        </ReviewStateLi>
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
  const listStyle = listNode?.type === "orderedList" ? listNode.attrs.listStyle : fallback?.listStyle;
  if (ordered) return <ol start={start ?? undefined} style={listStyle ? { listStyleType: listStyle } : undefined}>{items}</ol>;
  return <ul>{items}</ul>;
}

/** 列表/待办清单的递归行级 diff。原始 PM 行保全 marks/公式，嵌套列表按 childLists 下钻。 */
function ReviewListDiff({ block, beforeNode, targetPrefix }: { block: ListDiffBlock; beforeNode?: PmBlockNode; targetPrefix: string }) {
  const afterNode = (block as { node?: PmBlockNode }).node;
  return (
    <ReviewListLevel
      rowDiff={block.rowDiff}
      beforeNode={beforeNode}
      afterNode={afterNode}
      targetPrefix={`${targetPrefix}/list`}
      fallback={{
        isTask: block.kind === "taskList",
        ordered: block.kind === "list" && block.ordered,
        ...(block.kind === "list" && block.start !== undefined ? { start: block.start } : {}),
        ...(block.kind === "list" && block.listStyle ? { listStyle: block.listStyle } : {}),
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
  targetPath,
  logicalColumn,
}: {
  cell: PmTableCellNode;
  beforeCell?: PmTableCellNode;
  diff: Extract<ViewTableCellDiff, { status: "changed" }>;
  targetPath: string;
  logicalColumn?: number;
}) {
  const original = beforeCell
    ? <div className="wf-row-orig">{beforeCell.content.map((child, index) => <PmBlockView key={child.attrs.blockId ?? index} node={child} />)}</div>
    : <div className="wf-row-orig">{diff.oldText}</div>;
  const { target, targetClass, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLTableCellElement>(original, targetIndex, "changed");
  return (
    <PmTableCellView
      cell={cell}
      className={`wf-table-cell wf-table-cell--changed${targetClass}`}
      cellRef={anchorRef}
      reviewTargetId={target?.id}
      reviewTargetIndex={target?.index}
      logicalColumn={logicalColumn}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
      onMouseLeave={scheduleHide}
    >
      {/* 表格格子可能是多段/含 hardBreak/公式的复杂结构,保留整块 after node 渲染(不强上字符级),
          与"复杂块回退整块"一致;旧值进 hover。 */}
      {cell.content.map((child, index) => <PmBlockView key={child.attrs.blockId ?? index} node={child} />)}
      {popup}
    </PmTableCellView>
  );
}

function renderTableRowPopup(row: TableNode["content"][number] | undefined): React.ReactNode {
  if (!row) return null;
  return (
    <div className="pm-table-scroll wf-row-orig">
      <table><tbody><tr>{row.content.map((cell, index) => <PmTableCellView key={index} cell={cell} className="wf-table-cell" />)}</tr></tbody></table>
    </div>
  );
}

function ReviewTableStateRow({
  status,
  row,
  targetPath,
  logicalColumns,
}: {
  status: "added" | "removed";
  row: TableNode["content"][number];
  targetPath: string;
  logicalColumns?: ReadonlyMap<number, number>;
}) {
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLTableRowElement>(renderTableRowPopup(row), targetIndex, status);
  return (
    <tr
      ref={anchorRef}
      className={`wf-table-row wf-table-row--${status}${targetClass}`}
      {...targetAttrs}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
      onMouseLeave={scheduleHide}
    >
      {status === "removed" ? (
        <td className="wf-table-cell wf-table-delete-cell" colSpan={Math.max(1, row.content.length)}>
          <span className="wf-review-delete-marker" aria-label="已删除表格行，悬停查看原文" />
          {popup}
        </td>
      ) : (
        <>
          {row.content.map((cell, index) => (
            <PmTableCellView
              key={index}
              cell={cell}
              className="wf-table-cell"
              logicalColumn={logicalColumns?.get(index)}
            />
          ))}
          {popup}
        </>
      )}
    </tr>
  );
}

/** 原始 before/after 表行双游标对齐 cellDiff，单元格壳始终来自 PM node。 */
function ReviewTableDiff({
  node,
  beforeNode,
  cellDiff,
  targetPrefix,
}: {
  node: TableNode;
  beforeNode?: PmBlockNode;
  cellDiff: readonly ViewTableRowDiff[];
  targetPrefix: string;
}) {
  const beforeRows = isTableNode(beforeNode) ? beforeNode.content : [];
  const afterRows = node.content;
  const beforeLogicalColumns = isTableNode(beforeNode) ? staticTableCellLogicalColumns(beforeNode) : new Map<string, number>();
  const afterLogicalColumns = staticTableCellLogicalColumns(node);
  let beforeCursor = 0;
  let afterCursor = 0;
  const rows = cellDiff.map((rowDiff, rowIndex) => {
    const beforeRowIndex = rowDiff.status === "added" ? null : beforeCursor++;
    const afterRowIndex = rowDiff.status === "removed" ? null : afterCursor++;
    const beforeRow = beforeRowIndex === null ? undefined : beforeRows[beforeRowIndex];
    const afterRow = afterRowIndex === null ? undefined : afterRows[afterRowIndex];
    const row = afterRow ?? beforeRow;
    if (!row) return null;
    const rowPath = `${targetPrefix}/row:${rowIndex}`;
    if (rowDiff.status === "added" || rowDiff.status === "removed") {
      const sourceColumns = rowDiff.status === "added" ? afterLogicalColumns : beforeLogicalColumns;
      const sourceRowIndex = rowDiff.status === "added" ? afterRowIndex : beforeRowIndex;
      const logicalColumns = new Map(row.content.map((_, cellIndex) => [
        cellIndex,
        sourceColumns.get(`${sourceRowIndex}:${cellIndex}`) ?? cellIndex,
      ]));
      return (
        <ReviewTableStateRow
          key={rowIndex}
          status={rowDiff.status}
          row={row}
          targetPath={rowPath}
          logicalColumns={logicalColumns}
        />
      );
    }
    const rowClass = `wf-table-row wf-table-row--${rowDiff.status}`;
    return (
      <tr key={rowIndex} className={rowClass}>
        {Array.from({ length: Math.max(row.content.length, rowDiff.cells.length) }, (_, cellIndex) => {
          const afterCell = afterRow?.content[cellIndex];
          const beforeCell = beforeRow?.content[cellIndex];
          const cell = afterCell ?? beforeCell;
          if (!cell) return null;
          const logicalColumn = afterCell && afterRowIndex !== null
            ? afterLogicalColumns.get(`${afterRowIndex}:${cellIndex}`)
            : beforeRowIndex !== null ? beforeLogicalColumns.get(`${beforeRowIndex}:${cellIndex}`) : undefined;
          const diff = rowDiff.cells[cellIndex];
          if (rowDiff.status === "changed" && diff?.status === "changed") {
            return (
              <ChangedTableCell
                key={cellIndex}
                cell={cell}
                beforeCell={beforeCell}
                diff={diff}
                targetPath={`${rowPath}/cell:${cellIndex}`}
                logicalColumn={logicalColumn}
              />
            );
          }
          return <PmTableCellView
            key={cellIndex}
            cell={cell}
            className="wf-table-cell"
            logicalColumn={logicalColumn}
          />;
        })}
      </tr>
    );
  });
  return <PmTableScroll><table><tbody>{rows}</tbody></table></PmTableScroll>;
}

function ChangedContainerTextBlock({
  node,
  beforeNode,
  spans,
  oldText,
  targetPath,
}: {
  node: PmBlockNode;
  beforeNode?: PmBlockNode;
  spans: readonly ViewDocSpan[];
  oldText: string;
  targetPath: string;
}) {
  // hover 只弹字符级改动片段(旧→新);无字符级 patch 时兜底整块原文
  const original = renderChangeFragments(spans)
    ?? (beforeNode ? <PmBlockView node={beforeNode} /> : <div className="wf-row-orig">{oldText}</div>);
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLDivElement>(original, targetIndex, "changed");
  return (
    <div
      ref={anchorRef}
      className={`wf-container-block wf-container-block--changed wf-diff-inline${targetClass}`}
      {...targetAttrs}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
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
  targetPath,
}: {
  node: PmBlockNode;
  beforeNode?: PmBlockNode;
  targetPath: string;
}) {
  const original = beforeNode ? <PmBlockView node={beforeNode} /> : null;
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLDivElement>(original, targetIndex, "changed");
  return (
    <div
      ref={anchorRef}
      className={`wf-container-block wf-container-block--changed${targetClass}`}
      {...targetAttrs}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
      onMouseLeave={scheduleHide}
    >
      <PmBlockView node={node} />
      {popup}
    </div>
  );
}

function ReviewContainerStateBlock({
  status,
  node,
  targetPath,
}: {
  status: "added" | "removed";
  node: PmBlockNode;
  targetPath: string;
}) {
  const { targetClass, targetAttrs, targetIndex } = useReviewTarget(targetPath);
  const popupContent = status === "added" ? <PmBlockView node={node} /> : <PmBlockView node={node} />;
  const { anchorRef, show, scheduleHide, popup } = useReviewOriginalPopup<HTMLDivElement>(popupContent, targetIndex, status);
  return (
    <div
      ref={anchorRef}
      className={`wf-container-block wf-container-block--${status}${targetClass}`}
      {...targetAttrs}
      onMouseEnter={(event) => { if (shouldShowLocalPopup(event)) show(); }}
      onMouseLeave={scheduleHide}
    >
      {status === "removed"
        ? <span className="wf-review-delete-marker" aria-label="已删除内容，悬停查看原文" />
        : <PmBlockView node={node} />}
      {popup}
    </div>
  );
}

function ReviewBlockSeqDiffView({
  diff,
  beforeNodes,
  afterNodes,
  targetPrefix,
}: {
  diff: readonly ViewBlockSeqDiff[number][];
  beforeNodes: readonly PmBlockNode[];
  afterNodes: readonly PmBlockNode[];
  targetPrefix: string;
}) {
  let beforeCursor = 0;
  let afterCursor = 0;
  return (
    <>
      {diff.map((entry, index) => {
        const entryPath = `${targetPrefix}/entry:${index}`;
        const beforeBlock = entry.status === "added" ? undefined : beforeNodes[beforeCursor++];
        const afterBlock = entry.status === "removed" ? undefined : afterNodes[afterCursor++];
        if (entry.status === "same") return <PmBlockView key={index} node={afterBlock ?? entry.block} />;
        if (entry.status === "added") {
          return <ReviewContainerStateBlock key={index} status="added" node={afterBlock ?? entry.block} targetPath={entryPath} />;
        }
        if (entry.status === "removed") {
          const removedNode = beforeBlock ?? { type: "paragraph", attrs: {}, content: [{ type: "text", text: entry.oldText }] } as PmBlockNode;
          return <ReviewContainerStateBlock key={index} status="removed" node={removedNode} targetPath={entryPath} />;
        }
        if (entry.kind === "text") {
          return (
            <ChangedContainerTextBlock
              key={index}
              node={afterBlock ?? entry.node}
              beforeNode={beforeBlock}
              spans={entry.spans}
              oldText={entry.oldText}
              targetPath={entryPath}
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
              targetPrefix={`${entryPath}/list`}
            />
          );
        }
        if (entry.kind === "block") {
          return (
            <ChangedContainerBlock
              key={index}
              node={afterBlock ?? entry.node}
              beforeNode={beforeBlock}
              targetPath={entryPath}
            />
          );
        }
        return (
          <ReviewTableDiff
            key={index}
            node={(afterBlock ?? entry.node) as TableNode}
            beforeNode={beforeBlock}
            cellDiff={entry.cellDiff}
            targetPrefix={`${entryPath}/table`}
          />
        );
      })}
    </>
  );
}

function ReviewCalloutDiff({ block, beforeNode, targetPrefix }: { block: Extract<ViewBlock, { kind: "callout" }>; beforeNode?: PmBlockNode; targetPrefix: string }) {
  const node = block.node as CalloutNode;
  const beforeContent = isCalloutNode(beforeNode) ? beforeNode.content : [];
  return (
    <div className={`pm-callout pm-callout--${node.attrs.tone ?? "info"}`} data-pm-node="callout">
      <span className="pm-callout-emoji">{node.attrs.emoji ?? "💡"}</span>
      <div className="pm-callout-body">
        <ReviewBlockSeqDiffView diff={block.bodyDiff ?? []} beforeNodes={beforeContent} afterNodes={node.content} targetPrefix={`${targetPrefix}/body`} />
      </div>
    </div>
  );
}

function ReviewColumnListDiff({ block, beforeNode, targetPrefix }: { block: Extract<ViewBlock, { kind: "columnList" }>; beforeNode?: PmBlockNode; targetPrefix: string }) {
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
              targetPrefix={`${targetPrefix}/column:${displayIndex}/body`}
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
function ReviewBlockViewContent({ block, beforeNode, targetPrefix }: { block: ViewBlock; beforeNode?: PmBlockNode; targetPrefix: string }) {
  if ((block.kind === "list" || block.kind === "taskList") && block.rowDiff && block.rowDiff.length > 0) {
    return <ReviewListDiff block={block as ListDiffBlock} beforeNode={beforeNode} targetPrefix={targetPrefix} />;
  }
  if (block.kind === "table" && block.cellDiff && block.cellDiff.length > 0 && isTableNode(block.node)) {
    return <ReviewTableDiff node={block.node} beforeNode={beforeNode} cellDiff={block.cellDiff} targetPrefix={`${targetPrefix}/table`} />;
  }
  if (block.kind === "callout" && block.bodyDiff && block.bodyDiff.length > 0) {
    return <ReviewCalloutDiff block={block} beforeNode={beforeNode} targetPrefix={targetPrefix} />;
  }
  if (block.kind === "columnList" && block.columnsDiff && block.columnsDiff.length > 0) {
    return <ReviewColumnListDiff block={block} beforeNode={beforeNode} targetPrefix={targetPrefix} />;
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
  targetPrefix,
  reviewTargets = [],
  activeTargetId,
  patchIndex,
  suppressLocalPopup = false,
}: {
  block: ViewBlock;
  beforeNode?: PmBlockNode;
  targetPrefix: string;
  reviewTargets?: readonly ReviewTarget[];
  activeTargetId?: string | null;
  patchIndex?: number;
  suppressLocalPopup?: boolean;
}) {
  return (
    <ReviewTargetContext.Provider value={{
      byPath: new Map(reviewTargets.flatMap((target) => target.path ? [[target.path, target] as const] : [])),
      activeTargetId,
      fallbackIndex: patchIndex,
    }}>
      <ReviewLocalPopupSuppressedContext.Provider value={suppressLocalPopup}>
        <ReviewBlockViewContent block={block} beforeNode={beforeNode} targetPrefix={targetPrefix} />
      </ReviewLocalPopupSuppressedContext.Provider>
    </ReviewTargetContext.Provider>
  );
}

/** hover 卡片"原文"用:把原始 before PM node 渲成真内容(表格合并单元格/嵌套列表/图表/公式所见即所得,
 *  与正文渲染同源),而不是把 markdown 源码散排。外层是块级 div(供 PatchStatePopup 走块布局)。
 *  `.pm-hover-original` 自带紧凑表格边框样式(不借 `.wf-doc`,避免吃到整篇纸张 padding/min-height 污染)。 */
export function ReviewBlocksStatic({ nodes }: { nodes: readonly PmBlockNode[] }) {
  return <div className="pm-static-view pm-hover-original">{renderPmNodes(nodes)}</div>;
}
