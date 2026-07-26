import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "./useAnchoredPopover";
import "./skinControls.css";

export interface SkinSelectOption {
  value: string;
  label: string;
}

interface SkinSelectProps {
  value: string;
  options: readonly SkinSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
  ariaBusy?: boolean;
  disabled?: boolean;
  className?: string;
  skin: "paper" | "ink";
}

function nextEnabledIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  return (current + delta + length) % length;
}

export function SkinSelect({
  value,
  options,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  ariaBusy,
  disabled = false,
  className = "",
  skin,
}: SkinSelectProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const position = useAnchoredPopover(open, anchorRef, panelRef);
  const selected = options[selectedIndex];

  const close = () => setOpen(false);
  const openAt = (index: number) => {
    if (disabled || options.length === 0) return;
    setActiveIndex(index);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
    anchorRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        if (!open) {
          openAt(nextEnabledIndex(selectedIndex, delta, options.length));
        } else {
          setActiveIndex((index) => nextEnabledIndex(index, delta, options.length));
        }
        break;
      }
      case "Home":
      case "End":
        event.preventDefault();
        openAt(event.key === "Home" ? 0 : options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(activeIndex);
        else openAt(selectedIndex);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close();
        }
        break;
    }
  };

  const menu = open ? (
    <div
      ref={panelRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      className={`skin-select__menu skin-select__menu--${skin}`}
      style={position}
    >
      {options.map((option, index) => {
        const selectedOption = option.value === value;
        return (
          <button
            key={option.value}
            id={`${optionIdPrefix}-${index}`}
            type="button"
            role="option"
            aria-selected={selectedOption}
            className={`skin-select__option${index === activeIndex ? " is-active" : ""}`}
            onPointerMove={(event: ReactPointerEvent) => {
              if (event.pointerType !== "touch") setActiveIndex(index);
            }}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            <span className="skin-select__check" aria-hidden>{selectedOption ? "✓" : ""}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <span className={`skin-select skin-select--${skin} ${className}`.trim()}>
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-busy={ariaBusy}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${optionIdPrefix}-${activeIndex}` : undefined}
        className="skin-select__trigger"
        disabled={disabled}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={handleKeyDown}
      >
        <span className="skin-select__value">{selected?.label ?? ""}</span>
        <span className="skin-select__caret" aria-hidden>⌄</span>
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}
