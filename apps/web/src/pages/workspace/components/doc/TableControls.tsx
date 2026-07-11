import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { findPmTableByBlockId, pmTableSelectionCellTexts, pmTableTextRows, type PmDoc } from "@qingagent/pm-schema";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import type { AiModifyTarget } from "../../data/aiModifyTarget";
import { createTableAiModifyTarget } from "../../data/tableSelection";
import {
  applyTableToolbarFormat,
  applyTableToolbarStructure,
  canApplyTableToolbarStructure,
  isSingleTableCellTextSelection,
  isTableToolbarFormatCommand,
  insertTableAxisAtBoundary,
  readTableAxisSelection,
  selectTableColumns,
  selectTableRows,
} from "../../data/tableToolbar";
import { resolveCenteredFloatingPosition } from "../../data/floatingPosition";
import {
  isTableToolbarCommandEnabled,
  normalizeToolbarHighlightColor,
  normalizeToolbarTextColor,
  resolveToolbarUnlockConfig,
  TOOLBAR_HIGHLIGHT_COLORS,
  TOOLBAR_TEXT_COLORS,
  TOOLBAR_THEME_COLORS,
  type ToolbarThemeColorKey,
} from "../../data/toolbarUnlock";
import { floatingAnchorFromElement, useToolbarLinkEditor } from "./ToolbarLinkEditor";
import { applyTableAxisDrop, inspectTableAxisDrop, type TableDragAxis } from "../../data/tableAxisDrag";
import {
  resolveTableChromeViewport,
  TABLE_COLUMN_HEADER_SIZE,
  TABLE_INSERT_DOT_GAP,
  TABLE_ROW_HEADER_SIZE,
} from "./tableChromeGeometry";

/* ───────────── Table controls (Feishu-style) ───────────── */

const COL_HDR = TABLE_COLUMN_HEADER_SIZE;
const ROW_HDR = TABLE_ROW_HEADER_SIZE;

interface ColInfo { left: number; width: number; right: number }
interface RowInfo { top: number; height: number; bottom: number }
interface TblInfo {
  rect: DOMRect;
  wrapperRect: DOMRect;
  cols: ColInfo[];
  rows: RowInfo[];
  el: HTMLTableElement;
  wrapper: HTMLElement;
  blockId: string;
}
type Range2 = [number, number];

interface AxisDragPreview {
  axis: TableDragAxis;
  sourceStart: number;
  sourceEnd: number;
  dropBoundary: number;
  allowed: boolean;
  clone: boolean;
}

const AXIS_REORDER_HOLD_MS = 180;
const AXIS_DRAG_THRESHOLD_PX = 4;

function TableInsertMark() {
  return (
    <svg className="tbl-dot-mark" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function inRange(i: number, r: Range2 | null): boolean {
  return r !== null && i >= Math.min(r[0], r[1]) && i <= Math.max(r[0], r[1]);
}

export function resolveWorkspaceFloatingPortalTarget(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>("#view-workspace") ?? doc.body;
}

export function TableControls({ editor, onAiModify, onToast }: {
  editor: Editor;
  onAiModify: (target: AiModifyTarget) => Promise<boolean>;
  onToast?: (message: string) => void;
}) {
  const [info, setInfo] = useState<TblInfo | null>(null);
  const [selCols, setSelCols] = useState<Range2 | null>(null);
  const [selRows, setSelRows] = useState<Range2 | null>(null);
  const [openTableColor, setOpenTableColor] = useState<"text" | "highlight" | "cell" | null>(null);
  const [axisDrag, setAxisDrag] = useState<AxisDragPreview | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarUnlock = resolveToolbarUnlockConfig();
  const singleCellTextSelection = isSingleTableCellTextSelection(editor);
  const { openLinkEditor, closeLinkEditor, linkEditor } = useToolbarLinkEditor({
    editor,
    onToast,
    ignoreRef: toolbarRef,
  });

  useEffect(() => {
    if (!singleCellTextSelection) closeLinkEditor();
  }, [closeLinkEditor, singleCellTextSelection]);

  /* ── measure ── */
  useEffect(() => {
    let rafId: number | null = null;
    let scrollWrapper: HTMLElement | null = null;
    let observedElements = new Set<Element>();
    const ws = editor.view.dom.closest<HTMLElement>(".ws-right");
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleMeasure());

    const resetSelectionProjection = () => {
      setSelCols(null);
      setSelRows(null);
      setOpenTableColor(null);
    };
    const clearMeasuredTargets = () => {
      scrollWrapper?.removeEventListener("scroll", scheduleMeasure);
      scrollWrapper = null;
      for (const element of observedElements) resizeObserver?.unobserve(element);
      observedElements.clear();
    };
    const hideControls = () => {
      clearMeasuredTargets();
      setInfo(null);
      resetSelectionProjection();
    };
    const measure = () => {
      if (!editor.isEditable) {
        hideControls();
        return;
      }
      if (!editor.isActive("table")) {
        hideControls();
        return;
      }
      const a = editor.view.domAtPos(editor.state.selection.anchor);
      const n = a.node instanceof HTMLElement ? a.node : a.node.parentElement;
      const table = n?.closest("table") as HTMLTableElement | null;
      if (!table) {
        hideControls();
        return;
      }
      const wrapper = table.closest<HTMLElement>(".tableWrapper") ?? table;
      if (scrollWrapper !== wrapper) {
        scrollWrapper?.removeEventListener("scroll", scheduleMeasure);
        scrollWrapper = wrapper;
        scrollWrapper.addEventListener("scroll", scheduleMeasure, { passive: true });
      }
      const rect = table.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      const cols = measureLogicalColumns(editor, blockIdFromTable(editor, table));
      const rows: RowInfo[] = Array.from(table.rows).map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, height: b.height, bottom: b.bottom }; });
      const blockId = resolveSelectedTableBlockId(editor);
      if (blockId && table.dataset.blockId !== blockId) table.dataset.blockId = blockId;
      const projected = blockId ? readTableAxisSelection(editor, blockId) : null;
      setSelCols(projected?.axis === "column" ? [projected.startIndex, projected.endIndex] : null);
      setSelRows(projected?.axis === "row" ? [projected.startIndex, projected.endIndex] : null);
      setInfo({
        rect,
        wrapperRect,
        cols,
        rows,
        el: table,
        wrapper,
        blockId,
      });
      const nextObserved = new Set<Element>([wrapper, table]);
      if (ws) nextObserved.add(ws);
      for (const element of observedElements) {
        if (!nextObserved.has(element)) resizeObserver?.unobserve(element);
      }
      for (const element of nextObserved) {
        if (!observedElements.has(element)) resizeObserver?.observe(element);
      }
      observedElements = nextObserved;
    };
    function scheduleMeasure() {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    }
    editor.on("selectionUpdate", measure);
    editor.on("update", scheduleMeasure);
    ws?.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure, { passive: true });
    measure();
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      editor.off("selectionUpdate", measure);
      editor.off("update", scheduleMeasure);
      ws?.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      clearMeasuredTargets();
      resizeObserver?.disconnect();
    };
  }, [editor]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  /* ── helpers ── */
  const prevent = useCallback((e: React.MouseEvent) => e.preventDefault(), []);
  /* ── header mousedown：快拖保留 B3 范围拖选；长按或 Alt 拖进入 A7 排序/克隆。 ── */
  const startHeaderDrag = useCallback((axis: "col" | "row", idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!editor.isEditable || !info) return;
    if (!info.blockId) {
      onToast?.("无法定位表格,请重新选择");
      return;
    }
    dragCleanupRef.current?.();
    const dragAxis: TableDragAxis = axis === "col" ? "column" : "row";
    const selectedRange = axis === "col" ? selCols : selRows;
    const sourceRange = selectedRange && inRange(idx, selectedRange)
      ? [Math.min(...selectedRange), Math.max(...selectedRange)] as Range2
      : [idx, idx] as Range2;
    const start = idx;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastTarget = idx;
    let pendingTarget: number | null = null;
    let rafId: number | null = null;
    let mode: "pending" | "select" | "reorder" = e.altKey ? "reorder" : "pending";
    let latestDropBoundary = sourceRange[0];
    let latestAllowed = true;
    let latestNoOp = true;
    let latestClone = e.altKey;
    const beginReorder = (clone: boolean) => {
      mode = "reorder";
      latestClone = clone;
      setAxisDrag({
        axis: dragAxis,
        sourceStart: sourceRange[0],
        sourceEnd: sourceRange[1],
        dropBoundary: latestDropBoundary,
        allowed: true,
        clone,
      });
    };
    const holdTimer = e.altKey
      ? null
      : window.setTimeout(() => beginReorder(false), AXIS_REORDER_HOLD_MS);
    if (mode === "reorder") beginReorder(true);
    const dispatchTarget = (target: number) => {
      if (target === lastTarget) return;
      lastTarget = target;
      if (axis === "col") selectTableColumns(editor, info.blockId, start, target);
      else selectTableRows(editor, info.blockId, start, target);
    };
    if (axis === "col") selectTableColumns(editor, info.blockId, idx, idx);
    else selectTableRows(editor, info.blockId, idx, idx);
    const flushPending = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pendingTarget === null) return;
      const target = pendingTarget;
      pendingTarget = null;
      dispatchTarget(target);
    };
    const onMove = (me: MouseEvent) => {
      const distance = Math.hypot(me.clientX - startX, me.clientY - startY);
      if (mode === "pending" && distance >= AXIS_DRAG_THRESHOLD_PX) {
        if (holdTimer !== null) window.clearTimeout(holdTimer);
        mode = "select";
      }
      if (mode === "reorder") {
        latestClone = me.altKey;
        const geometry = axis === "col" ? info.cols : info.rows;
        const point = axis === "col" ? me.clientX : me.clientY;
        const boundary = nearestAxisBoundary(geometry, point, axis);
        const inspected = inspectTableAxisDrop(editor, {
          blockId: info.blockId,
          axis: dragAxis,
          sourceStart: sourceRange[0],
          sourceEnd: sourceRange[1],
          dropBoundary: boundary,
        });
        latestDropBoundary = boundary;
        latestAllowed = inspected.allowed;
        latestNoOp = inspected.noOp;
        setAxisDrag({
          axis: dragAxis,
          sourceStart: sourceRange[0],
          sourceEnd: sourceRange[1],
          dropBoundary: boundary,
          allowed: inspected.allowed,
          clone: latestClone,
        });
        return;
      }
      if (mode !== "select") return;
      const geometry = axis === "col" ? info.cols : info.rows;
      const point = axis === "col" ? me.clientX : me.clientY;
      const target = geometry.findIndex((item) =>
        axis === "col"
          ? point >= (item as ColInfo).left && point <= (item as ColInfo).right
          : point >= (item as RowInfo).top && point <= (item as RowInfo).bottom,
      );
      if (target < 0 || target === lastTarget || target === pendingTarget) return;
      pendingTarget = target;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (pendingTarget === null) return;
        const nextTarget = pendingTarget;
        pendingTarget = null;
        dispatchTarget(nextTarget);
      });
    };
    const cleanup = () => {
      if (holdTimer !== null) window.clearTimeout(holdTimer);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = null;
      pendingTarget = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      setAxisDrag(null);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const onUp = (event: MouseEvent) => {
      if (mode === "reorder") {
        latestClone = event.altKey || latestClone;
        if (!latestAllowed) {
          onToast?.("合并单元格跨越移动边界，无法排序");
        } else if (!latestNoOp) {
          applyTableAxisDrop(editor, {
            blockId: info.blockId,
            axis: dragAxis,
            sourceStart: sourceRange[0],
            sourceEnd: sourceRange[1],
            dropBoundary: latestDropBoundary,
            clone: latestClone,
          });
        }
        cleanup();
        return;
      }
      flushPending();
      cleanup();
    };
    dragCleanupRef.current = cleanup;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [editor, info, onToast, selCols, selRows]);

  const onColDown = useCallback((idx: number, e: React.MouseEvent) => {
    startHeaderDrag("col", idx, e);
  }, [startHeaderDrag]);
  const onRowDown = useCallback((idx: number, e: React.MouseEvent) => {
    startHeaderDrag("row", idx, e);
  }, [startHeaderDrag]);

  /* ── toolbar actions ── */
  const fmtSel = useCallback((cmd: string, val?: string | null) => {
    if (!editor.isEditable) return;
    if (!info) return;
    if (!isTableToolbarFormatCommand(cmd) || !isTableToolbarCommandEnabled(cmd, toolbarUnlock)) return;
    let normalizedValue = val;
    if (cmd === "textColor") {
      normalizedValue = val === "transparent" ? "transparent" : normalizeToolbarTextColor(val);
      if (!normalizedValue) return;
    }
    if (cmd === "cellBackground") {
      normalizedValue = val === "transparent" ? "transparent" : normalizeToolbarHighlightColor(val);
      if (!normalizedValue) return;
    }
    if (cmd === "highlight") {
      normalizedValue = val === "transparent" ? "transparent" : normalizeToolbarHighlightColor(val);
      if (!normalizedValue) return;
    }
    if (!selCols && !selRows && !singleCellTextSelection) return;
    applyTableToolbarFormat(editor, cmd, normalizedValue);
    setOpenTableColor(null);
  }, [editor, info, selCols, selRows, singleCellTextSelection, toolbarUnlock]);

  const doDelete = useCallback(() => {
    if (!editor.isEditable || !info) return;
    if (selCols) editor.chain().focus().deleteColumn().run();
    else if (selRows) editor.chain().focus().deleteRow().run();
    setOpenTableColor(null);
  }, [editor, info, selCols, selRows]);

  const doAiModify = useCallback(async () => {
    if (!editor.isEditable) return;
    if (!info) return;
    const blockId = info.blockId;
    if (!blockId) {
      onToast?.("无法定位表格,请重新选择");
      return;
    }
    const json = editor.getJSON() as unknown as PmDoc;
    const pmTable = findPmTableByBlockId(json, blockId);
    const rows = pmTable ? pmTableTextRows(pmTable) : [];
    const axis: "row" | "column" | null = selCols ? "column" : selRows ? "row" : null;
    const range = selCols ?? selRows;
    if (!axis || !range) return;
    const normalized = {
      axis,
      startIndex: Math.min(range[0], range[1]),
      endIndex: Math.max(range[0], range[1]),
    };
    const signatureCellTexts = pmTableSelectionCellTexts(
      editor.getJSON() as unknown as PmDoc,
      blockId,
      normalized,
    );
    if (!signatureCellTexts) {
      onToast?.("无法读取表格选区,请重新选择");
      return;
    }
    const target = createTableAiModifyTarget({ blockId, rows, axis, range, signatureCellTexts });
    if (await onAiModify(target)) {
      const $near = editor.state.doc.resolve(editor.state.selection.from);
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($near)));
    }
  }, [editor, info, onAiModify, onToast, selCols, selRows]);

  if (!editor.isEditable || !info) return null;
  const { rect, wrapperRect, cols, rows } = info;
  const hasAxisSelection = selCols !== null || selRows !== null;
  const hasCellSelection = editor.state.selection instanceof CellSelection;
  const hasSel = hasAxisSelection || hasCellSelection || singleCellTextSelection;
  const portalTarget = resolveWorkspaceFloatingPortalTarget();

  const viewport = resolveTableChromeViewport(rect, wrapperRect);

  const controls = (
    <>
      <div
        className="tbl-chrome-viewport"
        data-table-block-id={info.blockId}
        style={{ position: "fixed", ...viewport }}
      >
        {/* 行列 chrome 全在该 fixed viewport 内，宽表横滚时由 overflow:clip 限于纸张。 */}
        {cols.map((col, i) => (
          <div key={`ch${i}`}
            className={`tbl-col-hdr${inRange(i, selCols) ? " active" : ""}`}
            style={{
              position: "absolute",
              top: rect.top - COL_HDR - viewport.top,
              left: col.left - viewport.left,
              width: col.width,
              height: COL_HDR,
            }}
            onMouseDown={(e) => onColDown(i, e)} />
        ))}
        {rows.map((row, i) => (
          <div key={`rh${i}`}
            className={`tbl-row-hdr${inRange(i, selRows) ? " active" : ""}`}
            style={{
              position: "absolute",
              top: row.top - viewport.top,
              left: rect.left - ROW_HDR - viewport.left,
              width: ROW_HDR,
              height: row.height,
            }}
            onMouseDown={(e) => onRowDown(i, e)} />
        ))}

        {axisDrag ? (
          <TableAxisDragPreview preview={axisDrag} info={info} viewport={viewport} />
        ) : null}

        {cols[0] && (
          <button
            className="tbl-dot tbl-dot-col"
            data-table-insert="column-before"
            title="在最前插入列"
            style={{
              position: "absolute",
              top: rect.top - COL_HDR - TABLE_INSERT_DOT_GAP - viewport.top,
              left: cols[0].left - viewport.left,
              "--tbl-guide": `${rect.height + COL_HDR + TABLE_INSERT_DOT_GAP}px`,
            } as React.CSSProperties}
            onClick={() => insertTableAxisAtBoundary(editor, info.blockId, "column", 0)}
            onMouseDown={prevent}
          >
            <TableInsertMark />
          </button>
        )}
        {cols.map((col, i) => (
          <button key={`cd${i}`} className="tbl-dot tbl-dot-col" title="插入列"
            style={{
              position: "absolute",
              top: rect.top - COL_HDR - TABLE_INSERT_DOT_GAP - viewport.top,
              left: col.right - viewport.left,
              "--tbl-guide": `${rect.height + COL_HDR + TABLE_INSERT_DOT_GAP}px`,
            } as React.CSSProperties}
            onClick={() => insertTableAxisAtBoundary(editor, info.blockId, "column", i + 1)} onMouseDown={prevent}>
            <TableInsertMark />
          </button>
        ))}

        {rows[0] && (
          <button
            className="tbl-dot tbl-dot-row"
            data-table-insert="row-before"
            title="在最前插入行"
            style={{
              position: "absolute",
              top: rows[0].top - viewport.top,
              left: rect.left - ROW_HDR - TABLE_INSERT_DOT_GAP - viewport.left,
              "--tbl-guide": `${rect.width + ROW_HDR + TABLE_INSERT_DOT_GAP}px`,
            } as React.CSSProperties}
            onClick={() => insertTableAxisAtBoundary(editor, info.blockId, "row", 0)}
            onMouseDown={prevent}
          >
            <TableInsertMark />
          </button>
        )}
        {rows.map((row, i) => (
          <button key={`rd${i}`} className="tbl-dot tbl-dot-row" title="插入行"
            style={{
              position: "absolute",
              top: row.bottom - viewport.top,
              left: rect.left - ROW_HDR - TABLE_INSERT_DOT_GAP - viewport.left,
              "--tbl-guide": `${rect.width + ROW_HDR + TABLE_INSERT_DOT_GAP}px`,
            } as React.CSSProperties}
            onClick={() => insertTableAxisAtBoundary(editor, info.blockId, "row", i + 1)} onMouseDown={prevent}>
            <TableInsertMark />
          </button>
        ))}
      </div>

      {/* ── selection toolbar ── */}
      {hasSel && (() => {
        let cX = rect.left + rect.width / 2;
        if (selCols) {
          const lo = cols[Math.min(selCols[0], selCols[1])];
          const hi = cols[Math.max(selCols[0], selCols[1])];
          if (lo && hi) cX = (lo.left + hi.right) / 2;
        } else if (selRows) {
          cX = rect.left + rect.width / 2;
        }
        let toolbarAnchor = { top: rect.top - COL_HDR, bottom: rect.bottom, left: cX, width: 0 };
        if (singleCellTextSelection) {
          try {
            const from = editor.view.coordsAtPos(editor.state.selection.from);
            const to = editor.view.coordsAtPos(editor.state.selection.to);
            const left = Math.min(from.left, to.left);
            toolbarAnchor = {
              top: Math.min(from.top, to.top),
              bottom: Math.max(from.bottom, to.bottom),
              left,
              width: Math.max(1, Math.max(from.right, to.right) - left),
            };
          } catch {
            // DOM 选区刚替换时沿用表格几何。
          }
        }
        const toolbarPos = resolveCenteredFloatingPosition(
          toolbarAnchor,
          { width: toolbarRef.current?.offsetWidth || 620, height: 40 },
          { width: window.innerWidth, height: window.innerHeight },
          { gap: 8 },
        );
        return (
        <div ref={toolbarRef} className={`doc-toolbar on tbl-sel-toolbar${toolbarPos.placement === "below" ? " is-below" : ""}`} onMouseDown={prevent}
          style={{ position: "fixed", top: toolbarPos.top,
            left: toolbarPos.left, transform: "translateX(-50%)" }}>
          <button className="dt-btn" title="加粗" disabled={!toolbarUnlock.table} onClick={() => fmtSel("bold")}><b>B</b></button>
          <button className="dt-btn" title="斜体" disabled={!toolbarUnlock.table} onClick={() => fmtSel("italic")}><i>I</i></button>
          <button className="dt-btn" title="下划线" disabled={!toolbarUnlock.table} onClick={() => fmtSel("underline")}><u>U</u></button>
          <button className="dt-btn" title="删除线" disabled={!toolbarUnlock.table} onClick={() => fmtSel("strike")}><s>S</s></button>
          <button className="dt-btn" title="行内代码" disabled={!toolbarUnlock.table} onClick={() => fmtSel("code")}><code>&lt;/&gt;</code></button>
          <div className={`dt-group dt-dropdown tbl-color-group${openTableColor === "text" ? " open" : ""}`}>
            <button
              className="dt-btn"
              title="文字颜色"
              disabled={!toolbarUnlock.table}
              onClick={() => setOpenTableColor((v) => (v === "text" ? null : "text"))}
            >
              <span className="dt-lbl dt-hi-lbl">A<span className="dt-text-bar" /></span>
            </button>
            {openTableColor === "text" && (
              <div className="dt-menu dt-menu-colors dt-menu-table-colors" role="menu">
                <TableColorGrid kind="text" onPick={(color) => fmtSel("textColor", color)} />
              </div>
            )}
          </div>
          <div className={`dt-group dt-dropdown tbl-color-group${openTableColor === "highlight" ? " open" : ""}`}>
            <button
              className="dt-btn"
              title="背景高亮"
              disabled={!toolbarUnlock.table}
              onClick={() => setOpenTableColor((value) => (value === "highlight" ? null : "highlight"))}
            >
              <span className="dt-lbl dt-hi-lbl">H<span className="dt-hi-bar" /></span>
            </button>
            {openTableColor === "highlight" && (
              <div className="dt-menu dt-menu-colors dt-menu-table-colors" role="menu">
                <TableColorGrid kind="highlight" onPick={(color) => fmtSel("highlight", color)} />
              </div>
            )}
          </div>
          <div className={`dt-group dt-dropdown tbl-color-group${openTableColor === "cell" ? " open" : ""}`}>
            <button
              className="dt-btn"
              title="单元格底色"
              disabled={!toolbarUnlock.table}
              onClick={() => setOpenTableColor((v) => (v === "cell" ? null : "cell"))}
            >
              <span className="dt-cell-fill-icon" aria-hidden="true">
                <span />
              </span>
            </button>
            {openTableColor === "cell" && (
              <div className="dt-menu dt-menu-colors dt-menu-table-colors" role="menu">
                <TableColorGrid kind="cell" onPick={(color) => fmtSel("cellBackground", color)} />
              </div>
            )}
          </div>
          <div className="dt-divider" />
          <button
            className="dt-btn"
            title="合并单元格"
            disabled={!canApplyTableToolbarStructure(editor, "mergeCells")}
            onClick={() => applyTableToolbarStructure(editor, "mergeCells")}
          >合并单元格</button>
          <button
            className="dt-btn"
            title="拆分单元格"
            disabled={!canApplyTableToolbarStructure(editor, "splitCell")}
            onClick={() => applyTableToolbarStructure(editor, "splitCell")}
          >拆分单元格</button>
          <div className="dt-divider" />
          <button className="dt-btn" title="左对齐" disabled={!toolbarUnlock.table} onClick={() => fmtSel("alignLeft")}>≡←</button>
          <button className="dt-btn" title="居中" disabled={!toolbarUnlock.table} onClick={() => fmtSel("alignCenter")}>≡</button>
          <button className="dt-btn" title="右对齐" disabled={!toolbarUnlock.table} onClick={() => fmtSel("alignRight")}>→≡</button>
          <button
            className="dt-btn"
            title="链接"
            disabled={!toolbarUnlock.table || !singleCellTextSelection}
            onClick={(event) => {
              setOpenTableColor(null);
              openLinkEditor(floatingAnchorFromElement(event.currentTarget));
            }}
          >
            <svg className="dt-svg" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.5 5.2l1.2-1.2c1.3-1.3 3.4-1.3 4.7 0s1.3 3.4 0 4.7l-1.5 1.5c-1.2 1.2-3.1 1.3-4.4.3" />
              <path d="M9.5 10.8l-1.2 1.2c-1.3 1.3-3.4 1.3-4.7 0s-1.3-3.4 0-4.7l1.5-1.5c1.2-1.2 3.1-1.3 4.4-.3M6.2 9.8l3.6-3.6" />
            </svg>
          </button>
          <div className="dt-divider" />
          <button
            className="dt-btn dt-ai"
            title="发送到对话"
            disabled={!hasAxisSelection}
            onClick={() => { void doAiModify(); }}
          >
            <span className="dt-ai-ico">✨</span><span>修改选中文字</span>
          </button>
          {hasAxisSelection ? (
            <>
              <div className="dt-divider" />
              <button className="dt-btn" title={selCols ? "删除列" : "删除行"} onClick={doDelete} style={{color:"var(--mark)"}}>
                {selCols ? "删除列" : "删除行"}
              </button>
            </>
          ) : null}
        </div>
        );
      })()}
      {linkEditor}
    </>
  );

  return createPortal(controls, portalTarget);
}

function TableAxisDragPreview({
  preview,
  info,
  viewport,
}: {
  preview: AxisDragPreview;
  info: TblInfo;
  viewport: { top: number; left: number; width: number; height: number };
}) {
  const sourceStart = preview.sourceStart;
  const sourceEnd = preview.sourceEnd;
  const isColumn = preview.axis === "column";
  const first = isColumn ? info.cols[sourceStart] : info.rows[sourceStart];
  const last = isColumn ? info.cols[sourceEnd] : info.rows[sourceEnd];
  if (!first || !last) return null;
  const ghostStyle = isColumn
    ? {
        left: (first as ColInfo).left - viewport.left,
        top: info.rect.top - viewport.top,
        width: (last as ColInfo).right - (first as ColInfo).left,
        height: info.rect.height,
      }
    : {
        left: info.rect.left - viewport.left,
        top: (first as RowInfo).top - viewport.top,
        width: info.rect.width,
        height: (last as RowInfo).bottom - (first as RowInfo).top,
      };
  const boundary = isColumn
    ? preview.dropBoundary === 0
      ? info.cols[0]?.left ?? info.rect.left
      : info.cols[preview.dropBoundary - 1]?.right ?? info.rect.right
    : preview.dropBoundary === 0
      ? info.rows[0]?.top ?? info.rect.top
      : info.rows[preview.dropBoundary - 1]?.bottom ?? info.rect.bottom;
  const lineStyle = isColumn
    ? {
        left: boundary - viewport.left,
        top: info.rect.top - viewport.top,
        height: info.rect.height,
      }
    : {
        left: info.rect.left - viewport.left,
        top: boundary - viewport.top,
        width: info.rect.width,
      };
  return (
    <>
      <div
        className="tbl-axis-drag-ghost"
        data-axis={preview.axis}
        data-clone={preview.clone ? "true" : "false"}
        style={{ position: "absolute", ...ghostStyle }}
      />
      <div
        className={`tbl-axis-drop-line${preview.allowed ? "" : " is-forbidden"}`}
        data-axis={preview.axis}
        data-drop-boundary={preview.dropBoundary}
        data-drop-allowed={preview.allowed ? "true" : "false"}
        style={{ position: "absolute", ...lineStyle }}
      />
    </>
  );
}

function nearestAxisBoundary(
  geometry: readonly (ColInfo | RowInfo)[],
  point: number,
  axis: "col" | "row",
): number {
  if (geometry.length === 0) return 0;
  const boundaries = [
    axis === "col" ? (geometry[0] as ColInfo).left : (geometry[0] as RowInfo).top,
    ...geometry.map((item) => axis === "col" ? (item as ColInfo).right : (item as RowInfo).bottom),
  ];
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  boundaries.forEach((boundary, index) => {
    const nextDistance = Math.abs(point - boundary);
    if (nextDistance < distance) {
      nearest = index;
      distance = nextDistance;
    }
  });
  return nearest;
}

function TableColorGrid({
  kind,
  onPick,
}: {
  kind: "text" | "highlight" | "cell";
  onPick: (color: ToolbarThemeColorKey | "transparent") => void;
}) {
  return (
    <div className="dt-color-menu dt-color-menu-compact">
      <div className="dt-color-label">{kind === "text" ? "文字颜色" : kind === "highlight" ? "背景高亮" : "单元格底色"}</div>
      <div className="dt-swatch-grid">
        {TOOLBAR_THEME_COLORS.map((color) => (
          <button
            key={`${kind}-${color.key}`}
            type="button"
            role="menuitem"
            className={`dt-swatch${kind === "text" ? " dt-swatch-text" : ""}`}
            title={`${kind === "text" ? "文字颜色" : kind === "highlight" ? "背景高亮" : "单元格底色"}：${color.label}`}
            onClick={() => onPick(color.key)}
          >
            <span
              className="dt-swatch-chip"
              style={{
                background: kind === "text" ? TOOLBAR_TEXT_COLORS[color.key] : TOOLBAR_HIGHLIGHT_COLORS[color.key],
                borderColor: kind === "text" ? TOOLBAR_TEXT_COLORS[color.key] : color.border,
              }}
            />
          </button>
        ))}
        <button
          type="button"
          role="menuitem"
          className="dt-swatch dt-swatch-clear"
          title={kind === "text" ? "清除文字颜色" : kind === "highlight" ? "清除背景高亮" : "清除单元格底色"}
          onClick={() => onPick("transparent")}
        >
          <span className="dt-color-none" />
        </button>
      </div>
    </div>
  );
}

function resolveSelectedTableBlockId(editor: Editor): string {
  const $anchor = editor.state.doc.resolve(editor.state.selection.anchor);
  for (let depth = $anchor.depth; depth >= 0; depth--) {
    const node = $anchor.node(depth);
    if (node.type.spec.tableRole === "table") {
      return typeof node.attrs.blockId === "string" ? node.attrs.blockId : "";
    }
  }
  return "";
}

function blockIdFromTable(editor: Editor, table: HTMLTableElement): string {
  return table.dataset.blockId || resolveSelectedTableBlockId(editor);
}

/** 按 TableMap 第一逻辑行定位 cell；colspan 内部边界优先按 colwidth 比例，否则均分。 */
export function measureLogicalColumns(editor: Editor, blockId: string): ColInfo[] {
  if (!blockId) return [];
  let tableNode: ReturnType<typeof editor.state.doc.nodeAt> | null = null;
  let tablePos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "table" && node.attrs.blockId === blockId) {
      tableNode = node;
      tablePos = pos;
      return false;
    }
    return true;
  });
  if (!tableNode || tablePos < 0) return [];
  const map = TableMap.get(tableNode);
  const tableStart = tablePos + 1;
  return Array.from({ length: map.width }, (_, columnIndex) => {
    const offset = map.map[columnIndex]!;
    const cell = tableNode!.nodeAt(offset);
    const dom = editor.view.nodeDOM(tableStart + offset) as HTMLTableCellElement | null;
    if (!cell || !dom) return { left: 0, width: 0, right: 0 };
    const cellRect = dom.getBoundingClientRect();
    const cellRectInMap = map.findCell(offset);
    const widths = Array.isArray(cell.attrs.colwidth) && cell.attrs.colwidth.length === cellRectInMap.right - cellRectInMap.left
      ? cell.attrs.colwidth.map((value: unknown) => typeof value === "number" && value > 0 ? value : 0)
      : null;
    const total = widths?.reduce((sum: number, value: number) => sum + value, 0) || 0;
    const ratios = widths && total > 0 ? widths.map((value: number) => value / total) : null;
    const relative = columnIndex - cellRectInMap.left;
    const before = ratios
      ? ratios.slice(0, relative).reduce((sum: number, value: number) => sum + value, 0)
      : relative / (cellRectInMap.right - cellRectInMap.left);
    const share = ratios?.[relative] ?? 1 / (cellRectInMap.right - cellRectInMap.left);
    const left = cellRect.left + cellRect.width * before;
    const width = cellRect.width * share;
    return { left, width, right: left + width };
  });
}

/* ───────────── ViewDocumentSnapshot → PM / HTML ───────────── */

/* ───────────── Read-only section / span renderers ───────────── */
