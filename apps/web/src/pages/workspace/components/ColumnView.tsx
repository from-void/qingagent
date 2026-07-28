import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { NodeViewRendererProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { ColumnListNode, ColumnNode } from "@qingagent/pm-schema/tiptap";
import { MAX_COLUMNS, createColumnDndPlugin, insertEmptyColumnTransaction, removeColumnTransaction } from "./ColumnDnD";
import type { Editor } from "@tiptap/core";

const MIN_COLUMN_RATIO = 0.12;
const MIN_COLUMN_WIDTH_PX = 110;

// 松手吸附：把分隔线两侧"左列占整行的比例"吸到这些好看的整比例上（1/5、1/4、1/3、2/5、1/2…），
// 阈值内吸附；否则退化为整数百分比对齐。无极拖拽时不吸附，仅 pointerup 落定时吸附。
const SNAP_NICE_RATIOS = [0.2, 0.25, 1 / 3, 0.4, 0.5, 0.6, 2 / 3, 0.75, 0.8];
const SNAP_THRESHOLD = 0.03;

interface ResizeColumnRatiosInput {
  ratios: readonly (number | null | undefined)[];
  index: number;
  deltaPx: number;
  availableWidth: number;
  minRatio?: number;
  minWidthPx?: number;
}

interface ColumnContext {
  pos: number;
  index: number;
  count: number;
  ratios: number[];
}

interface ColumnNodeViewProps {
  editor: NodeViewRendererProps["editor"];
  getPos: NodeViewRendererProps["getPos"];
  node: NodeViewRendererProps["node"];
}

interface DragState {
  pointerId: number;
  startClientX: number;
  index: number;
  ratios: number[];
  availableWidth: number;
  columnElements: HTMLElement[];
  handle: HTMLElement;
}

function roundRatio(value: number): number {
  return Number(value.toFixed(4));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeColumnRatios(ratios: readonly (number | null | undefined)[]): number[] {
  const count = ratios.length;
  if (count === 0) return [];
  const parsed = ratios.map((ratio) =>
    typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : null,
  );
  const allValid = parsed.every((ratio): ratio is number => ratio != null);
  if (!allValid) {
    const equal = 1 / count;
    const normalized = Array.from({ length: count }, () => equal);
    return roundRatiosWithLastRemainder(normalized);
  }
  const total = parsed.reduce((sum, ratio) => sum + ratio, 0);
  if (!Number.isFinite(total) || total <= 0) {
    const equal = 1 / count;
    return roundRatiosWithLastRemainder(Array.from({ length: count }, () => equal));
  }
  return roundRatiosWithLastRemainder(parsed.map((ratio) => ratio / total));
}

export function calculateColumnResizeRatios(input: ResizeColumnRatiosInput): number[] {
  const ratios = normalizeColumnRatios(input.ratios);
  const { index, deltaPx, availableWidth } = input;
  if (index < 0 || index >= ratios.length - 1) return ratios;
  if (!Number.isFinite(deltaPx) || !Number.isFinite(availableWidth) || availableWidth <= 0) {
    return ratios;
  }

  const left = ratios[index]!;
  const right = ratios[index + 1]!;
  const pairSum = left + right;
  const minByWidth = (input.minWidthPx ?? MIN_COLUMN_WIDTH_PX) / availableWidth;
  const minRatio = Math.max(input.minRatio ?? MIN_COLUMN_RATIO, minByWidth);
  const effectiveMin = Math.min(minRatio, pairSum / 2);
  const nextLeft = roundRatio(clamp(left + deltaPx / availableWidth, effectiveMin, pairSum - effectiveMin));
  const nextRight = roundRatio(pairSum - nextLeft);
  const next = ratios.slice();
  next[index] = nextLeft;
  next[index + 1] = nextRight;
  return next;
}

function roundRatiosWithLastRemainder(ratios: readonly number[]): number[] {
  if (ratios.length === 0) return [];
  if (ratios.length === 1) return [1];
  const next = ratios.map((ratio) => roundRatio(ratio));
  const sumExceptLast = next.slice(0, -1).reduce((sum, ratio) => sum + ratio, 0);
  next[next.length - 1] = roundRatio(Math.max(0, 1 - sumExceptLast));
  return next;
}

function styleForRatio(ratio: number | null): CSSProperties | undefined {
  if (ratio == null) return undefined;
  return { flex: `${ratio} 1 0%` };
}

function resolveColumnContext(props: ColumnNodeViewProps): ColumnContext | null {
  if (typeof props.getPos !== "function") return null;
  const pos = props.getPos();
  if (typeof pos !== "number") return null;
  const state = props.editor.state;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (parent.type.name !== "columnList") return null;
  const index = $pos.index();
  const ratios: Array<number | null> = [];
  for (let i = 0; i < parent.childCount; i++) {
    const attr = parent.child(i).attrs.widthRatio;
    ratios.push(typeof attr === "number" && Number.isFinite(attr) && attr > 0 ? attr : null);
  }
  return {
    pos,
    index,
    count: parent.childCount,
    ratios: normalizeColumnRatios(ratios),
  };
}

function collectColumnElements(column: HTMLElement): HTMLElement[] {
  const columnList = column.closest(".pm-column-list");
  if (!columnList) return [column];
  const columns = Array.from(
    columnList.querySelectorAll<HTMLElement>(".pm-column[data-pm-node='column']"),
  );
  return columns.length > 0 ? columns : [column];
}

function resolveAvailableWidth(columnElements: readonly HTMLElement[], fallback: HTMLElement): number {
  const parentWidth = columnElements[0]?.parentElement?.getBoundingClientRect().width ?? 0;
  if (parentWidth > 0) return parentWidth;
  const sum = columnElements.reduce((total, column) => total + column.getBoundingClientRect().width, 0);
  if (sum > 0) return sum;
  return fallback.getBoundingClientRect().width || 1;
}

function applyPreviewRatios(columnElements: readonly HTMLElement[], ratios: readonly number[]) {
  columnElements.forEach((column, index) => {
    const ratio = ratios[index];
    if (ratio == null) return;
    column.style.flex = `${ratio} 1 0%`;
    column.style.flexBasis = "0%";
  });
}

// 把分隔线左列比例吸到最近的好看比例；都不够近就对齐到整数百分比。
export function snapBoundaryRatio(leftRatio: number, pairSum: number, effectiveMin: number): number {
  let bestNice: number | null = null;
  let bestDist = SNAP_THRESHOLD;
  for (const candidate of SNAP_NICE_RATIOS) {
    if (candidate < effectiveMin || candidate > pairSum - effectiveMin) continue;
    const dist = Math.abs(leftRatio - candidate);
    if (dist <= bestDist) {
      bestDist = dist;
      bestNice = candidate;
    }
  }
  if (bestNice != null) return roundRatio(bestNice);
  return roundRatio(Math.round(leftRatio * 100) / 100);
}

// 拖拽时各列右上角的实时百分比徽标——用裸 DOM 直接挂到列 wrapper 上（与 applyPreviewRatios 同款
// 临时预览手法，不走 React/事务），pointerup 落定前必须先移除，避免 PM 重渲染时把它当内容。
function ensurePctBadge(column: HTMLElement): HTMLElement {
  let badge = column.querySelector<HTMLElement>(":scope > .pm-column-pct-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "pm-column-pct-badge";
    badge.setAttribute("contenteditable", "false");
    column.appendChild(badge);
  }
  return badge;
}

function showPctBadges(columnElements: readonly HTMLElement[], ratios: readonly number[]) {
  columnElements.forEach((column, index) => {
    const ratio = ratios[index];
    if (ratio == null) return;
    ensurePctBadge(column).textContent = `${Math.round(ratio * 100)}%`;
  });
}

function hidePctBadges(columnElements: readonly HTMLElement[]) {
  columnElements.forEach((column) => {
    column.querySelector(":scope > .pm-column-pct-badge")?.remove();
  });
}

function isColumnGutterEvent(event: Event): boolean {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".pm-column-gutter")) return false;
  return (
    event.type.startsWith("pointer") ||
    event.type.startsWith("mouse") ||
    event.type === "click" ||
    event.type === "dblclick" ||
    event.type === "contextmenu"
  );
}

function ColumnListComponent() {
  return (
    <NodeViewWrapper className="pm-column-list" data-pm-node="columnList">
      <NodeViewContent className="pm-column-list-content" />
    </NodeViewWrapper>
  );
}

function ColumnComponent(props: ColumnNodeViewProps) {
  const context = resolveColumnContext(props);
  const ratio = context?.ratios[context.index] ?? null;
  const isLastColumn = context ? context.index >= context.count - 1 : false;
  const columnRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const cleanupDrag = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    dragRef.current = null;
  }, []);

  const commitResize = useCallback(
    (drag: DragState, clientX: number) => {
      const nextContext = resolveColumnContext(props);
      if (!nextContext || nextContext.index >= nextContext.count - 1) return;
      const nextRatios = calculateColumnResizeRatios({
        ratios: drag.ratios,
        index: drag.index,
        deltaPx: clientX - drag.startClientX,
        availableWidth: drag.availableWidth,
      });
      const leftPos = nextContext.pos;
      const state = props.editor.state;
      const leftNode = state.doc.nodeAt(leftPos);
      if (!leftNode) return;
      const rightPos = leftPos + leftNode.nodeSize;
      const rightNode = state.doc.nodeAt(rightPos);
      if (!rightNode || rightNode.type.name !== "column") return;
      const rawLeft = nextRatios[nextContext.index];
      const rawRight = nextRatios[nextContext.index + 1];
      if (rawLeft == null || rawRight == null) return;
      // 落定吸附：在分隔线两侧的比例和内做吸附，保持 pairSum 不变（不影响其它列）。
      const pairSum = rawLeft + rawRight;
      const minByWidth = MIN_COLUMN_WIDTH_PX / drag.availableWidth;
      const effectiveMin = Math.min(Math.max(MIN_COLUMN_RATIO, minByWidth), pairSum / 2);
      const leftRatio = snapBoundaryRatio(rawLeft, pairSum, effectiveMin);
      const rightRatio = roundRatio(pairSum - leftRatio);
      const snappedRatios = nextContext.ratios.slice();
      snappedRatios[nextContext.index] = leftRatio;
      snappedRatios[nextContext.index + 1] = rightRatio;
      // pointermove 写入的是未吸附原始比例；即使吸附结果等于 attrs、不需要事务，
      // 松手时也必须先把预览 DOM 恢复到最终持久化比例。
      applyPreviewRatios(drag.columnElements, snappedRatios);
      if (leftRatio === nextContext.ratios[nextContext.index] && rightRatio === nextContext.ratios[nextContext.index + 1]) {
        return;
      }
      const tr = state.tr
        .setNodeMarkup(leftPos, undefined, { ...leftNode.attrs, widthRatio: leftRatio })
        .setNodeMarkup(rightPos, undefined, { ...rightNode.attrs, widthRatio: rightRatio });
      props.editor.view.dispatch(tr);
    },
    [props],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!props.editor.isEditable || isLastColumn) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const column = columnRef.current;
      const currentContext = resolveColumnContext(props);
      if (!column || !currentContext || currentContext.index >= currentContext.count - 1) return;

      event.preventDefault();
      event.stopPropagation();

      const handle = event.currentTarget;
      const columnElements = collectColumnElements(column);
      const drag: DragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        index: currentContext.index,
        ratios: currentContext.ratios,
        availableWidth: resolveAvailableWidth(columnElements, column),
        columnElements,
        handle,
      };
      dragRef.current = drag;
      handle.setPointerCapture?.(event.pointerId);
      column.closest(".pm-column-list")?.classList.add("pm-column-resizing");
      showPctBadges(columnElements, drag.ratios);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const active = dragRef.current;
        if (!active || moveEvent.pointerId !== active.pointerId) return;
        moveEvent.preventDefault();
        const nextRatios = calculateColumnResizeRatios({
          ratios: active.ratios,
          index: active.index,
          deltaPx: moveEvent.clientX - active.startClientX,
          availableWidth: active.availableWidth,
        });
        applyPreviewRatios(active.columnElements, nextRatios);
        showPctBadges(active.columnElements, nextRatios);
      };
      const finishDrag = (active: DragState) => {
        hidePctBadges(active.columnElements);
        active.columnElements[0]?.closest(".pm-column-list")?.classList.remove("pm-column-resizing");
        active.handle.releasePointerCapture?.(active.pointerId);
        cleanupDrag();
      };
      const onPointerUp = (upEvent: PointerEvent) => {
        const active = dragRef.current;
        if (!active || upEvent.pointerId !== active.pointerId) return;
        upEvent.preventDefault();
        hidePctBadges(active.columnElements);
        commitResize(active, upEvent.clientX);
        active.columnElements[0]?.closest(".pm-column-list")?.classList.remove("pm-column-resizing");
        active.handle.releasePointerCapture?.(active.pointerId);
        cleanupDrag();
      };
      const onPointerCancel = (cancelEvent: PointerEvent) => {
        const active = dragRef.current;
        if (!active || cancelEvent.pointerId !== active.pointerId) return;
        applyPreviewRatios(active.columnElements, active.ratios);
        finishDrag(active);
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerCancel);
      cleanupRef.current = () => {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerCancel);
      };
    },
    [cleanupDrag, commitResize, isLastColumn, props],
  );

  const onInsertColumn = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!props.editor.isEditable) return;
      const ctx = resolveColumnContext(props);
      if (!ctx || ctx.count >= MAX_COLUMNS) return;
      const state = props.editor.state;
      const listPos = state.doc.resolve(ctx.pos).before();
      const tr = insertEmptyColumnTransaction(state, listPos, ctx.index + 1);
      if (!tr) return;
      props.editor.view.dispatch(tr);
      props.editor.view.focus();
    },
    [props],
  );

  useEffect(() => cleanupDrag, [cleanupDrag]);

  const canInsertColumn = context ? context.count < MAX_COLUMNS : false;

  return (
    <NodeViewWrapper
      ref={columnRef}
      className="pm-column"
      data-pm-node="column"
      data-width-ratio={ratio == null ? undefined : String(ratio)}
      style={styleForRatio(ratio)}
    >
      <NodeViewContent className="pm-column-body" />
      {props.editor.isEditable && !isLastColumn && (
        <div className="pm-column-gutter" contentEditable={false}>
          <span
            className="pm-column-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整分栏宽度"
            onPointerDown={onPointerDown}
          />
          {canInsertColumn && (
            <button
              type="button"
              className="pm-column-insert-dot"
              aria-label="插入分栏"
              title="插入分栏"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onInsertColumn}
            >
              <span className="pm-column-insert-dot__icon" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {/* 末列右侧：无竖线(此处不可调宽),只放一个 hover 出现的加号,点击在末尾追加新分栏。
          gutter 本身 pointer-events:none(不挡末列文字点击),只有圆点可点。 */}
      {props.editor.isEditable && isLastColumn && canInsertColumn && (
        <div className="pm-column-gutter pm-column-gutter--end" contentEditable={false}>
          <button
            type="button"
            className="pm-column-insert-dot pm-column-insert-dot--end"
            aria-label="在右侧插入分栏"
            title="在右侧插入分栏"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onInsertColumn}
          >
            <span className="pm-column-insert-dot__icon" aria-hidden="true" />
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const ColumnListCM = ColumnListNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ColumnListComponent as never);
  },
  addProseMirrorPlugins() {
    return [createColumnDndPlugin()];
  },
});

// 光标在「空列」（只含一个空文本块）里按退格 → 删掉该列。返回 true 表示已处理。
function handleColumnBackspace(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name !== "column") continue;
    const onlyChild = node.childCount === 1 ? node.firstChild : null;
    const isEmptyColumn = !!onlyChild && onlyChild.isTextblock && onlyChild.content.size === 0;
    if (!isEmptyColumn) return false;
    const columnListPos = $from.before(d - 1);
    const columnIndex = $from.index(d - 1);
    const tr = removeColumnTransaction(state, columnListPos, columnIndex);
    if (!tr) return false;
    editor.view.dispatch(tr);
    return true;
  }
  return false;
}

export const ColumnCM = ColumnNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ColumnComponent as never, {
      stopEvent: ({ event }) => isColumnGutterEvent(event),
    });
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => handleColumnBackspace(this.editor),
    };
  },
});
