import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { PmTableNode } from "@qingagent/pm-schema";
import { PmBlockView, PmTableCellView } from "./PmStaticView";
import { resolveWorkspaceFloatingPortalTarget } from "./TableControls";

interface TableHeaderOverlayState {
  table: PmTableNode;
  tablePos: number;
  top: number;
  left: number;
  width: number;
  height: number;
  tableLeft: number;
  tableWidth: number;
  cellWidths: number[];
  trueCells: HTMLTableCellElement[];
}

interface TableCandidate {
  table: PmTableNode;
  tablePos: number;
  element: HTMLTableElement;
  wrapper: HTMLElement;
}

export function TableHeaderOverlay({ editor }: { editor: Editor }) {
  const [overlay, setOverlay] = useState<TableHeaderOverlayState | null>(null);

  useEffect(() => {
    let rafId: number | null = null;
    let measuredWrappers = new Set<HTMLElement>();
    let observedElements = new Set<Element>();
    const ws = editor.view.dom.closest<HTMLElement>(".ws-right");
    if (!ws) {
      setOverlay(null);
      return;
    }
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleMeasure());

    const clearMeasuredTargets = () => {
      for (const wrapper of measuredWrappers) wrapper.removeEventListener("scroll", scheduleMeasure);
      measuredWrappers.clear();
      for (const element of observedElements) resizeObserver?.unobserve(element);
      observedElements.clear();
    };

    const syncMeasuredTargets = (candidates: TableCandidate[]) => {
      const nextWrappers = new Set(candidates.map((candidate) => candidate.wrapper));
      for (const wrapper of measuredWrappers) {
        if (!nextWrappers.has(wrapper)) wrapper.removeEventListener("scroll", scheduleMeasure);
      }
      for (const wrapper of nextWrappers) {
        if (!measuredWrappers.has(wrapper)) wrapper.addEventListener("scroll", scheduleMeasure, { passive: true });
      }
      measuredWrappers = nextWrappers;

      const nextObserved = new Set<Element>();
      if (ws) nextObserved.add(ws);
      for (const candidate of candidates) {
        nextObserved.add(candidate.wrapper);
        nextObserved.add(candidate.element);
        const headerRow = candidate.element.rows[0];
        if (headerRow) for (const cell of Array.from(headerRow.cells)) nextObserved.add(cell);
      }
      for (const element of observedElements) {
        if (!nextObserved.has(element)) resizeObserver?.unobserve(element);
      }
      for (const element of nextObserved) {
        if (!observedElements.has(element)) resizeObserver?.observe(element);
      }
      observedElements = nextObserved;
    };

    const measure = () => {
      if (!editor.isEditable || editor.isDestroyed) {
        clearMeasuredTargets();
        setOverlay(null);
        return;
      }
      const candidates = findHeaderTableCandidates(editor);
      syncMeasuredTargets(candidates);

      const wsRect = ws.getBoundingClientRect();
      let next: TableHeaderOverlayState | null = null;
      for (const candidate of candidates) {
        const headerRow = candidate.element.rows[0];
        if (!headerRow) continue;
        const tableRect = candidate.element.getBoundingClientRect();
        const headerRect = headerRow.getBoundingClientRect();
        const wrapperRect = candidate.wrapper.getBoundingClientRect();
        const bodyStillVisible = tableRect.bottom > wsRect.top && tableRect.top < wsRect.bottom;
        if (headerRect.bottom > wsRect.top || !bodyStillVisible) continue;
        const left = Math.max(wrapperRect.left, wsRect.left);
        const right = Math.min(wrapperRect.right, wsRect.right);
        if (right <= left || headerRect.height <= 0) continue;
        const trueCells = Array.from(headerRow.cells);
        next = {
          table: candidate.table,
          tablePos: candidate.tablePos,
          top: wsRect.top,
          left,
          width: right - left,
          height: headerRect.height,
          tableLeft: tableRect.left - left,
          tableWidth: tableRect.width,
          cellWidths: trueCells.map((cell) => cell.getBoundingClientRect().width),
          trueCells,
        };
        break;
      }
      setOverlay(next);
    };

    function scheduleMeasure() {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    }

    const onSelectionUpdate = () => measure();
    editor.on("selectionUpdate", onSelectionUpdate);
    editor.on("update", scheduleMeasure);
    ws.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure, { passive: true });
    measure();
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      editor.off("selectionUpdate", onSelectionUpdate);
      editor.off("update", scheduleMeasure);
      ws.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      clearMeasuredTargets();
      resizeObserver?.disconnect();
    };
  }, [editor]);

  const focusTrueCell = useCallback((cellIndex: number) => {
    const cell = overlay?.trueCells[cellIndex];
    if (!cell?.isConnected || !editor.isEditable) return;
    try {
      const pos = editor.view.posAtDOM(cell, 0);
      editor.chain().focus().setTextSelection(pos).run();
      cell.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      // 几何刷新前 DOM 已替换时忽略本次点击。
    }
  }, [editor, overlay]);

  if (!editor.isEditable || !overlay) return null;
  const firstRow = overlay.table.content[0];
  if (!firstRow) return null;
  const content = (
    <div
      className="table-header-overlay-viewport"
      data-table-pos={overlay.tablePos}
      style={{
        position: "fixed",
        top: overlay.top,
        left: overlay.left,
        width: overlay.width,
        height: overlay.height,
      }}
    >
      <div className="wf-doc table-header-overlay-content">
        <table
          className="table-header-overlay__table"
          style={{
            position: "absolute",
            top: 0,
            left: overlay.tableLeft,
            width: overlay.tableWidth,
            tableLayout: "fixed",
          }}
        >
          <tbody>
            <tr>
              {firstRow.content.map((cell, cellIndex) => (
                <PmTableCellView
                  key={cellIndex}
                  cell={cell}
                  cellStyle={{ width: overlay.cellWidths[cellIndex] }}
                  onClick={() => focusTrueCell(cellIndex)}
                >
                  {cell.content.map((block, blockIndex) => <PmBlockView key={block.attrs.blockId ?? blockIndex} node={block} />)}
                </PmTableCellView>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
  return createPortal(content, resolveWorkspaceFloatingPortalTarget());
}

function findHeaderTableCandidates(editor: Editor): TableCandidate[] {
  const candidates: TableCandidate[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== "table") return true;
    const firstRow = node.firstChild;
    if (!firstRow || firstRow.childCount === 0) return false;
    const hasHeaderRow = Array.from({ length: firstRow.childCount }, (_, index) => firstRow.child(index))
      .every((cell) => cell.type.name === "tableHeader");
    if (!hasHeaderRow) return false;
    const nodeDom = editor.view.nodeDOM(pos);
    const root = nodeDom instanceof HTMLElement ? nodeDom : null;
    const element = root instanceof HTMLTableElement ? root : root?.querySelector<HTMLTableElement>("table");
    if (!element) return false;
    candidates.push({
      table: node.toJSON() as PmTableNode,
      tablePos: pos,
      element,
      wrapper: element.closest<HTMLElement>(".tableWrapper") ?? element,
    });
    return false;
  });
  return candidates;
}
