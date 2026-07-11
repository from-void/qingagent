import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { pmTableSelectionCellTexts, type PmDoc } from "@qingagent/pm-schema";
import type { AiModifyTarget } from "../../data/aiModifyTarget";
import { createTableAiModifyTarget, tableHasSpanInDom } from "../../data/tableSelection";
import {
  applyTableToolbarFormat,
  isTableToolbarFormatCommand,
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

/* ───────────── Table controls (Feishu-style) ───────────── */

const COL_HDR = 8;
const ROW_HDR = 8;
const DOT_EXT = 8;

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
  hasSpan: boolean;
}
type Range2 = [number, number];

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
  const [openTableColor, setOpenTableColor] = useState<"text" | "cell" | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const toolbarUnlock = resolveToolbarUnlockConfig();

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
      const fr = table.querySelector("tr");
      const cols: ColInfo[] = fr
        ? Array.from(fr.cells).map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width, right: r.right }; })
        : [];
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
        hasSpan: tableHasSpanInDom(table),
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
  const cellCmd = useCallback(
    (rI: number, cI: number, fn: (c: ReturnType<Editor["chain"]>) => void) => {
      if (!editor.isEditable) return;
      if (!info) return;
      const cell = info.el.rows[rI]?.cells[cI];
      if (!cell) return;
      try { fn(editor.chain().focus().setTextSelection(editor.view.posAtDOM(cell, 0))); } catch { /* stale */ }
    }, [editor, info]);

  /* ── header mousedown → 真 CellSelection；mousemove 每帧最多 dispatch 一次 ── */
  const startHeaderDrag = useCallback((axis: "col" | "row", idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!editor.isEditable || !info || info.hasSpan) return;
    if (!info.blockId) {
      onToast?.("无法定位表格,请重新选择");
      return;
    }
    dragCleanupRef.current?.();
    const start = idx;
    let lastTarget = idx;
    let pendingTarget: number | null = null;
    let rafId: number | null = null;
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
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = null;
      pendingTarget = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const onUp = () => {
      flushPending();
      cleanup();
    };
    dragCleanupRef.current = cleanup;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [editor, info, onToast]);

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
    if (info.hasSpan) return;
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
    if (!selCols && !selRows) return;
    applyTableToolbarFormat(editor, cmd, normalizedValue);
    setOpenTableColor(null);
  }, [editor, info, selCols, selRows, toolbarUnlock]);

  const doDelete = useCallback(() => {
    if (!editor.isEditable || !info || info.hasSpan) return;
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
    const rows = Array.from(info.el.rows).map((row) =>
      Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? ""),
    );
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
  const hasSel = selCols !== null || selRows !== null;
  const portalTarget = resolveWorkspaceFloatingPortalTarget();

  if (info.hasSpan) {
    return createPortal(
      <div
        className="tbl-span-hint"
        role="status"
        style={{
          position: "fixed",
          top: Math.max(8, wrapperRect.top - 28),
          left: Math.max(8, wrapperRect.left),
        }}
      >
        含合并单元格的表格暂不支持行列操作
      </div>,
      portalTarget,
    );
  }

  const chromeTop = COL_HDR + DOT_EXT;
  const viewport = {
    top: wrapperRect.top - chromeTop,
    left: wrapperRect.left - ROW_HDR,
    width: wrapperRect.width + ROW_HDR,
    height: wrapperRect.height + chromeTop,
  };

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

        {cols[0] && (
          <button
            className="tbl-dot tbl-dot-col"
            data-table-insert="column-before"
            title="在最前插入列"
            style={{
              position: "absolute",
              top: rect.top - COL_HDR - 5 - viewport.top,
              left: cols[0].left - viewport.left,
              "--tbl-guide": `${rect.height + COL_HDR + 5}px`,
            } as React.CSSProperties}
            onClick={() => cellCmd(0, 0, (c) => c.addColumnBefore().run())}
            onMouseDown={prevent}
          >
            <span className="tbl-dot-mark">│</span>
          </button>
        )}
        {cols.map((col, i) => (
          <button key={`cd${i}`} className="tbl-dot tbl-dot-col" title="插入列"
            style={{
              position: "absolute",
              top: rect.top - COL_HDR - 5 - viewport.top,
              left: col.right - viewport.left,
              "--tbl-guide": `${rect.height + COL_HDR + 5}px`,
            } as React.CSSProperties}
            onClick={() => cellCmd(0, i, (c) => c.addColumnAfter().run())} onMouseDown={prevent}>
            <span className="tbl-dot-mark">│</span>
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
              left: rect.left - ROW_HDR - 5 - viewport.left,
              "--tbl-guide": `${rect.width + ROW_HDR + 5}px`,
            } as React.CSSProperties}
            onClick={() => cellCmd(0, 0, (c) => c.addRowBefore().run())}
            onMouseDown={prevent}
          >
            <span className="tbl-dot-mark">─</span>
          </button>
        )}
        {rows.map((row, i) => (
          <button key={`rd${i}`} className="tbl-dot tbl-dot-row" title="插入行"
            style={{
              position: "absolute",
              top: row.bottom - viewport.top,
              left: rect.left - ROW_HDR - 5 - viewport.left,
              "--tbl-guide": `${rect.width + ROW_HDR + 5}px`,
            } as React.CSSProperties}
            onClick={() => cellCmd(i, 0, (c) => c.addRowAfter().run())} onMouseDown={prevent}>
            <span className="tbl-dot-mark">─</span>
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
        const toolbarPos = resolveCenteredFloatingPosition(
          { top: rect.top - COL_HDR, bottom: rect.bottom, left: cX, width: 0 },
          { width: 360, height: 40 },
          { width: window.innerWidth, height: window.innerHeight },
          { gap: 8 },
        );
        return (
        <div className={`doc-toolbar on tbl-sel-toolbar${toolbarPos.placement === "below" ? " is-below" : ""}`} onMouseDown={prevent}
          style={{ position: "fixed", top: toolbarPos.top,
            left: toolbarPos.left, transform: "translateX(-50%)" }}>
          <button className="dt-btn" title="加粗" disabled={!toolbarUnlock.table} onClick={() => fmtSel("bold")}><b>B</b></button>
          <button className="dt-btn" title="斜体" disabled={!toolbarUnlock.table} onClick={() => fmtSel("italic")}><i>I</i></button>
          <button className="dt-btn" title="下划线" disabled={!toolbarUnlock.table} onClick={() => fmtSel("underline")}><u>U</u></button>
          <button className="dt-btn" title="删除线" disabled={!toolbarUnlock.table} onClick={() => fmtSel("strike")}><s>S</s></button>
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
            className="dt-btn dt-ai"
            title="发送到对话"
            onClick={() => { void doAiModify(); }}
          >
            <span className="dt-ai-ico">✨</span><span>修改选中文字</span>
          </button>
          <div className="dt-divider" />
          <button className="dt-btn" title={selCols ? "删除列" : "删除行"} onClick={doDelete} style={{color:"var(--mark)"}}>
            {selCols ? "删除列" : "删除行"}
          </button>
        </div>
        );
      })()}
    </>
  );

  return createPortal(controls, portalTarget);
}

function TableColorGrid({
  kind,
  onPick,
}: {
  kind: "text" | "cell";
  onPick: (color: ToolbarThemeColorKey | "transparent") => void;
}) {
  return (
    <div className="dt-color-menu dt-color-menu-compact">
      <div className="dt-color-label">{kind === "text" ? "文字颜色" : "单元格底色"}</div>
      <div className="dt-swatch-grid">
        {TOOLBAR_THEME_COLORS.map((color) => (
          <button
            key={`${kind}-${color.key}`}
            type="button"
            role="menuitem"
            className={`dt-swatch${kind === "text" ? " dt-swatch-text" : ""}`}
            title={`${kind === "text" ? "文字颜色" : "单元格底色"}：${color.label}`}
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
          title={kind === "text" ? "清除文字颜色" : "清除单元格底色"}
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

/* ───────────── ViewDocumentSnapshot → PM / HTML ───────────── */

/* ───────────── Read-only section / span renderers ───────────── */
