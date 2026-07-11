import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { AiModifyTarget } from "../../data/aiModifyTarget";
import { chatInputBus } from "../../../../system";
import {
  applyTableToolbarFormat,
  isTableToolbarFormatCommand,
  setTableCellSelectionFromDom,
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

interface ColInfo { left: number; width: number; right: number }
interface RowInfo { top: number; height: number; bottom: number }
interface TblInfo { rect: DOMRect; cols: ColInfo[]; rows: RowInfo[]; el: HTMLTableElement }
type Range2 = [number, number];

function inRange(i: number, r: Range2 | null): boolean {
  return r !== null && i >= Math.min(r[0], r[1]) && i <= Math.max(r[0], r[1]);
}

export function resolveWorkspaceFloatingPortalTarget(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>("#view-workspace") ?? doc.body;
}

export function TableControls({ editor, onAiModify: _onAiModify }: {
  editor: Editor;
  onAiModify: (target: AiModifyTarget) => Promise<boolean>;
}) {
  const [info, setInfo] = useState<TblInfo | null>(null);
  const [selCols, setSelCols] = useState<Range2 | null>(null);
  const [selRows, setSelRows] = useState<Range2 | null>(null);
  const [openTableColor, setOpenTableColor] = useState<"text" | "cell" | null>(null);
  const dragAnchor = useRef<{ axis: "col" | "row"; start: number } | null>(null);
  const toolbarUnlock = resolveToolbarUnlockConfig();

  /* ── measure ── */
  useEffect(() => {
    const measure = () => {
      if (!editor.isEditable) {
        setInfo(null);
        return;
      }
      if (!editor.isActive("table")) { setInfo(null); return; }
      const a = editor.view.domAtPos(editor.state.selection.anchor);
      const n = a.node instanceof HTMLElement ? a.node : a.node.parentElement;
      const table = n?.closest("table") as HTMLTableElement | null;
      if (!table) { setInfo(null); return; }
      const rect = table.getBoundingClientRect();
      const fr = table.querySelector("tr");
      const cols: ColInfo[] = fr
        ? Array.from(fr.cells).map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width, right: r.right }; })
        : [];
      const rows: RowInfo[] = Array.from(table.rows).map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, height: b.height, bottom: b.bottom }; });
      setInfo({ rect, cols, rows, el: table });
    };
    editor.on("selectionUpdate", measure);
    editor.on("update", measure);
    const ws = editor.view.dom.closest(".ws-right");
    ws?.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { editor.off("selectionUpdate", measure); editor.off("update", measure); ws?.removeEventListener("scroll", measure); };
  }, [editor]);

  /* ── highlight via injected <style> — immune to TipTap DOM rebuilds ── */
  useEffect(() => {
    if (!selCols && !selRows) return;

    const rules: string[] = [];
    const S = "#view-workspace .wf-doc table";

    if (selCols) {
      const lo = Math.min(selCols[0], selCols[1]);
      const hi = Math.max(selCols[0], selCols[1]);
      for (let ci = lo; ci <= hi; ci++) {
        const n = ci + 1;
        rules.push(`${S} td:nth-child(${n})`, `${S} th:nth-child(${n})`);
      }
    }
    if (selRows) {
      const lo = Math.min(selRows[0], selRows[1]);
      const hi = Math.max(selRows[0], selRows[1]);
      for (let ri = lo; ri <= hi; ri++) {
        const n = ri + 1;
        rules.push(
          `${S} tr:nth-child(${n}) td`, `${S} tr:nth-child(${n}) th`,
          `${S} tbody tr:nth-child(${n}) td`, `${S} tbody tr:nth-child(${n}) th`,
        );
      }
    }

    if (rules.length === 0) return;

    const style = document.createElement("style");
    style.textContent = `${rules.join(",")}{background:rgba(168,130,63,.18)!important}`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [selCols, selRows]);

  /* ── dismiss on click outside ── */
  useEffect(() => {
    if (!selCols && !selRows) return;
    const onClick = (e: MouseEvent) => {
      if (info?.el.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.(".tbl-sel-toolbar,.tbl-col-hdr,.tbl-row-hdr")) return;
      setSelCols(null); setSelRows(null); setOpenTableColor(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [selCols, selRows, info]);

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

  /* ── header mousedown → select + start drag ── */
  const onColDown = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!editor.isEditable) return;
    setSelCols([idx, idx]); setSelRows(null);
    cellCmd(0, idx, (c) => c.run());
    dragAnchor.current = { axis: "col", start: idx };
    const onMove = (me: MouseEvent) => {
      if (!info || dragAnchor.current?.axis !== "col") return;
      for (let i = 0; i < info.cols.length; i++) {
        const c = info.cols[i]!;
        if (me.clientX >= c.left && me.clientX <= c.right) { setSelCols([dragAnchor.current.start, i]); break; }
      }
    };
    const onUp = () => { dragAnchor.current = null; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [editor, info, cellCmd]);

  const onRowDown = useCallback((idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!editor.isEditable) return;
    setSelRows([idx, idx]); setSelCols(null);
    cellCmd(idx, 0, (c) => c.run());
    dragAnchor.current = { axis: "row", start: idx };
    const onMove = (me: MouseEvent) => {
      if (!info || dragAnchor.current?.axis !== "row") return;
      for (let i = 0; i < info.rows.length; i++) {
        const r = info.rows[i]!;
        if (me.clientY >= r.top && me.clientY <= r.bottom) { setSelRows([dragAnchor.current.start, i]); break; }
      }
    };
    const onUp = () => { dragAnchor.current = null; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [editor, info, cellCmd]);

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
    const range = selectedTableCellRange(info, selCols, selRows);
    if (!range) return;
    const selected = setTableCellSelectionFromDom(editor, range.anchor, range.head);
    if (selected) applyTableToolbarFormat(editor, cmd, normalizedValue);
    setOpenTableColor(null);
  }, [editor, info, selCols, selRows, toolbarUnlock]);

  const doDelete = useCallback(() => {
    if (!editor.isEditable) return;
    if (selCols) { cellCmd(0, Math.min(selCols[0], selCols[1]), (c) => c.deleteColumn().run()); setSelCols(null); }
    else if (selRows) { cellCmd(Math.min(selRows[0], selRows[1]), 0, (c) => c.deleteRow().run()); setSelRows(null); }
    setOpenTableColor(null);
  }, [editor, selCols, selRows, cellCmd]);

  const doAiModify = useCallback(() => {
    if (!editor.isEditable) return;
    if (!info) return;
    let text = "";
    if (selCols) {
      const [a, b] = [Math.min(selCols[0], selCols[1]), Math.max(selCols[0], selCols[1])];
      for (const row of Array.from(info.el.rows))
        for (let ci = a; ci <= b; ci++) text += (row.cells[ci]?.textContent?.trim() ?? "") + " ";
    } else if (selRows) {
      const [a, b] = [Math.min(selRows[0], selRows[1]), Math.max(selRows[0], selRows[1])];
      for (let ri = a; ri <= b; ri++) {
        const row = info.el.rows[ri];
        if (row) for (const cell of Array.from(row.cells)) text += (cell.textContent?.trim() ?? "") + " | ";
        text += "\n";
      }
    }
    text = text.trim();
    if (!text) return;
    // 审计修复:此处原是 require()——浏览器 ESM 里必抛 ReferenceError 且被空 catch
    // 吞掉,表格「AI 修改」推送聊天功能因此静默失效。改为顶部静态 import。
    chatInputBus.push(`§ "${text.length > 120 ? text.slice(0, 120) + "…" : text}"`);
    setSelCols(null); setSelRows(null);
  }, [editor, info, selCols, selRows]);

  if (!editor.isEditable || !info) return null;
  const { rect, cols, rows } = info;
  const hasSel = selCols !== null || selRows !== null;

  const controls = (
    <>
      {/* ── column headers (always visible when cursor in table) ── */}
      {cols.map((col, i) => (
        <div key={`ch${i}`}
          className={`tbl-col-hdr${inRange(i, selCols) ? " active" : ""}`}
          style={{ position: "fixed", top: rect.top - COL_HDR, left: col.left, width: col.width, height: COL_HDR }}
          onMouseDown={(e) => onColDown(i, e)} />
      ))}

      {/* ── row headers ── */}
      {rows.map((row, i) => (
        <div key={`rh${i}`}
          className={`tbl-row-hdr${inRange(i, selRows) ? " active" : ""}`}
          style={{ position: "fixed", top: row.top, left: rect.left - ROW_HDR, width: ROW_HDR, height: row.height }}
          onMouseDown={(e) => onRowDown(i, e)} />
      ))}

      {/* ── column dots (all col borders including last, above headers) ── */}
      {cols.map((col, i) => (
        <button key={`cd${i}`} className="tbl-dot tbl-dot-col" title="插入列"
          style={{ position: "fixed", top: rect.top - COL_HDR - 5, left: col.right, "--tbl-guide": `${rect.height + COL_HDR + 5}px` } as React.CSSProperties}
          onClick={() => cellCmd(0, i, (c) => c.addColumnAfter().run())} onMouseDown={prevent}>
          <span className="tbl-dot-mark">│</span>
        </button>
      ))}

      {/* ── row dots (all row borders including last, left of headers) ── */}
      {rows.map((row, i) => (
        <button key={`rd${i}`} className="tbl-dot tbl-dot-row" title="插入行"
          style={{ position: "fixed", top: row.bottom, left: rect.left - ROW_HDR - 5, "--tbl-guide": `${rect.width + ROW_HDR + 5}px` } as React.CSSProperties}
          onClick={() => cellCmd(i, 0, (c) => c.addRowAfter().run())} onMouseDown={prevent}>
          <span className="tbl-dot-mark">─</span>
        </button>
      ))}

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
          <button className="dt-btn dt-ai" title="发送到对话" onClick={doAiModify}>
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

  return createPortal(controls, resolveWorkspaceFloatingPortalTarget());
}

function selectedTableCellRange(
  info: TblInfo,
  selCols: Range2 | null,
  selRows: Range2 | null,
): { anchor: HTMLTableCellElement; head: HTMLTableCellElement } | null {
  if (selCols) {
    const start = Math.min(selCols[0], selCols[1]);
    const end = Math.max(selCols[0], selCols[1]);
    const anchor = info.el.rows[0]?.cells[start];
    const head = info.el.rows[info.el.rows.length - 1]?.cells[end];
    return anchor && head ? { anchor, head } : null;
  }
  if (selRows) {
    const start = Math.min(selRows[0], selRows[1]);
    const end = Math.max(selRows[0], selRows[1]);
    const anchor = info.el.rows[start]?.cells[0];
    const lastRow = info.el.rows[end];
    const head = lastRow?.cells[lastRow.cells.length - 1];
    return anchor && head ? { anchor, head } : null;
  }
  return null;
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

/* ───────────── ViewDocumentSnapshot → PM / HTML ───────────── */

/* ───────────── Read-only section / span renderers ───────────── */
