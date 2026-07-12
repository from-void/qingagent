import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveSideFloatingPosition } from "../../data/floatingPosition";

export interface TableSize {
  rows: number;
  cols: number;
}

export interface TableSizePickerProps {
  anchor: HTMLElement;
  onSelect: (size: TableSize) => void;
  onClose: () => void;
  autoFocus?: boolean;
  portalTarget?: Element | DocumentFragment;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

const GRID_SIZE = 10;
const ESTIMATED_WIDTH = 238;
const ESTIMATED_HEIGHT = 264;

export function TableSizePicker({
  anchor,
  onSelect,
  onClose,
  autoFocus = false,
  portalTarget,
  onPointerEnter,
  onPointerLeave,
}: TableSizePickerProps) {
  const [size, setSize] = useState<TableSize>({ rows: 1, cols: 1 });
  const sizeRef = useRef(size);
  const [position, setPosition] = useState({ top: -9999, left: -9999, placement: "right" as "left" | "right" });
  const pickerRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    if (!anchor.isConnected) {
      onClose();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const panel = pickerRef.current;
    setPosition(resolveSideFloatingPosition(
      { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      { width: panel?.offsetWidth || ESTIMATED_WIDTH, height: panel?.offsetHeight || ESTIMATED_HEIGHT },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    measure();
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [measure]);

  useEffect(() => {
    if (autoFocus) pickerRef.current?.focus();
  }, [autoFocus]);

  const updateFromPointer = useCallback((target: EventTarget | null) => {
    const cell = target instanceof Element ? target.closest<HTMLElement>("[data-table-size-cell]") : null;
    if (!cell) return;
    const rows = Number(cell.dataset.row);
    const cols = Number(cell.dataset.col);
    if (Number.isInteger(rows) && Number.isInteger(cols)) {
      sizeRef.current = { rows, cols };
      setSize(sizeRef.current);
    }
  }, []);

  const content = (
    <div
      ref={pickerRef}
      className={`table-size-picker is-${position.placement}`}
      role="dialog"
      aria-label="选择表格尺寸"
      tabIndex={0}
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={(event) => updateFromPointer(event.target)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onSelect(sizeRef.current);
          return;
        }
        const delta = event.key === "ArrowLeft"
          ? { rows: 0, cols: -1 }
          : event.key === "ArrowRight"
            ? { rows: 0, cols: 1 }
            : event.key === "ArrowUp"
              ? { rows: -1, cols: 0 }
              : event.key === "ArrowDown"
                ? { rows: 1, cols: 0 }
                : null;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const current = sizeRef.current;
        const next = {
          rows: Math.min(GRID_SIZE, Math.max(1, current.rows + delta.rows)),
          cols: Math.min(GRID_SIZE, Math.max(1, current.cols + delta.cols)),
        };
        sizeRef.current = next;
        setSize(next);
      }}
    >
      <div className="table-size-picker__head">
        <span>插入表格</span>
        <output aria-live="polite">{size.rows} x {size.cols}</output>
      </div>
      <div className="table-size-picker__grid" role="grid" aria-rowcount={GRID_SIZE} aria-colcount={GRID_SIZE}>
        {Array.from({ length: GRID_SIZE }, (_, rowIndex) =>
          Array.from({ length: GRID_SIZE }, (_, colIndex) => {
            const rows = rowIndex + 1;
            const cols = colIndex + 1;
            const active = rows <= size.rows && cols <= size.cols;
            return (
              <button
                key={`${rows}-${cols}`}
                type="button"
                role="gridcell"
                tabIndex={-1}
                data-table-size-cell=""
                data-row={rows}
                data-col={cols}
                className={active ? "is-active" : ""}
                aria-label={`${rows} 行 ${cols} 列`}
                aria-selected={active}
                onFocus={() => {
                  sizeRef.current = { rows, cols };
                  setSize(sizeRef.current);
                }}
                onClick={() => onSelect({ rows, cols })}
              />
            );
          }),
        )}
      </div>
    </div>
  );

  const target = portalTarget ?? anchor.closest("#view-workspace") ?? document.body;
  return createPortal(content, target);
}
