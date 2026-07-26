import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "./useAnchoredPopover";
import "./skinControls.css";

interface CalendarDatePickerProps {
  value: string;
  onChange: (value: string) => void;
  max?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  skin: "paper" | "ink";
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function toYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year!, month! - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthDays(view: Date): Array<{ ymd: string; day: number; currentMonth: boolean }> {
  const year = view.getFullYear();
  const month = view.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(year, month, index - startOffset + 1);
    return {
      ymd: toYmd(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      currentMonth: date.getMonth() === month,
    };
  });
}

export function CalendarDatePicker({
  value,
  onChange,
  max,
  disabled = false,
  title,
  ariaLabel,
  skin,
}: CalendarDatePickerProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedDate = parseYmd(value);
  const initialDate = selectedDate ?? parseYmd(max ?? "") ?? new Date();
  const [view, setView] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));
  const [open, setOpen] = useState(false);
  const position = useAnchoredPopover(open, anchorRef, panelRef);
  const days = useMemo(() => monthDays(view), [view]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || !selectedDate) return;
    setView(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  }, [open, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const shiftMonth = (delta: number) => {
    setView((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  const panel = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="选择日期"
      className={`skin-calendar skin-calendar--${skin}`}
      style={position}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setOpen(false);
        anchorRef.current?.focus();
      }}
    >
      <div className="skin-calendar__head">
        <button type="button" aria-label="上个月" onClick={() => shiftMonth(-1)}>‹</button>
        <strong>{view.getFullYear()} 年 {view.getMonth() + 1} 月</strong>
        <button type="button" aria-label="下个月" onClick={() => shiftMonth(1)}>›</button>
      </div>
      <div className="skin-calendar__week" aria-hidden>
        {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="skin-calendar__grid">
        {days.map((date) => {
          const isDisabled = Boolean(max && date.ymd > max);
          return (
            <button
              key={date.ymd}
              type="button"
              className={[
                "skin-calendar__day",
                date.currentMonth ? "" : "is-adjacent",
                date.ymd === value ? "is-selected" : "",
              ].filter(Boolean).join(" ")}
              aria-label={date.ymd}
              aria-pressed={date.ymd === value}
              disabled={isDisabled}
              onClick={() => {
                onChange(date.ymd);
                setOpen(false);
                anchorRef.current?.focus();
              }}
            >
              {date.day}
            </button>
          );
        })}
      </div>
      <div className="skin-calendar__foot">
        <button
          type="button"
          className="skin-calendar__clear"
          disabled={!value}
          onClick={() => {
            onChange("");
            setOpen(false);
            anchorRef.current?.focus();
          }}
        >
          清除日期
        </button>
      </div>
    </div>
  ) : null;

  return (
    <span className={`skin-date skin-date--${skin}`}>
      <button
        ref={anchorRef}
        type="button"
        className="skin-date__trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span>{value || "选择日期"}</span>
        <span aria-hidden>日</span>
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </span>
  );
}
