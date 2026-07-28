// 多选下拉:与 SkinSelect 同一套皮肤(skin-select__* 类 + --qj-* 令牌)与同一套浮层纪律
// (进关闭栈 / Esc 弹栈 / 点外关闭 / 焦点回触发钮),只是选项语义从"单选"换成"复选"。
// 顶部固定一项「全部」= 全选;触发钮显示「全部」或「N 个模型」这类摘要。
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
import { useOverlayDismiss } from "./overlayDismissStack";
import "./skinControls.css";

export interface SkinMultiSelectOption {
  value: string;
  label: string;
}

interface SkinMultiSelectProps {
  options: readonly SkinMultiSelectOption[];
  /** 当前勾选的 value 集合 */
  selected: readonly string[];
  /** 单项勾选切换(是否允许取消最后一项由调用方决定) */
  onToggle: (value: string) => void;
  /** 「全部」项:一律回到全选 */
  onSelectAll: () => void;
  /** 触发钮上的摘要文案,如「全部」/「2 个模型」 */
  summaryLabel: string;
  /** 「全部」项的显示名 */
  allLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  skin: "paper" | "ink";
  dataWf?: string;
}

export function SkinMultiSelect({
  options,
  selected,
  onToggle,
  onSelectAll,
  summaryLabel,
  allLabel = "全部",
  ariaLabel,
  disabled = false,
  className = "",
  skin,
  dataWf,
}: SkinMultiSelectProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // 索引 0 恒为「全部」,其后依次是各选项
  const [activeIndex, setActiveIndex] = useState(0);
  const position = useAnchoredPopover(open, anchorRef, panelRef);
  const selectedSet = new Set(selected);
  const allSelected = options.length > 0 && selected.length === options.length;
  const rowCount = options.length + 1;

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

  // 开着时进浮层关闭栈:Esc 由外层弹层的守卫统一弹栈关闭,焦点不在触发器上也能关
  useOverlayDismiss(open, () => {
    close();
    anchorRef.current?.focus();
  });

  // 多选浮层不关:连续勾选是常态,关掉反而要一项项重开
  const choose = (index: number) => {
    if (index === 0) {
      onSelectAll();
      return;
    }
    const option = options[index - 1];
    if (option) onToggle(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        if (!open) openAt(0);
        else setActiveIndex((index) => (index + delta + rowCount) % rowCount);
        break;
      }
      case "Home":
      case "End":
        event.preventDefault();
        openAt(event.key === "Home" ? 0 : rowCount - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(activeIndex);
        else openAt(0);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close();
        }
        break;
    }
  };

  const renderRow = (index: number, label: string, checked: boolean, key: string) => (
    <button
      key={key}
      id={`${optionIdPrefix}-${index}`}
      type="button"
      role="option"
      aria-selected={checked}
      className={`skin-select__option${index === activeIndex ? " is-active" : ""}${
        index === 0 ? " skin-select__option--all" : ""
      }`}
      onPointerMove={(event: ReactPointerEvent) => {
        if (event.pointerType !== "touch") setActiveIndex(index);
      }}
      onClick={() => choose(index)}
    >
      <span>{label}</span>
      <span className="skin-select__check" aria-hidden>{checked ? "✓" : ""}</span>
    </button>
  );

  const menu = open ? (
    <div
      ref={panelRef}
      id={listboxId}
      role="listbox"
      aria-multiselectable
      aria-label={ariaLabel}
      className={`skin-select__menu skin-select__menu--${skin}`}
      style={position}
      data-wf={dataWf ? `${dataWf}Menu` : undefined}
    >
      {renderRow(0, allLabel, allSelected, "__all__")}
      {options.map((option, index) =>
        renderRow(index + 1, option.label, selectedSet.has(option.value), option.value),
      )}
    </div>
  ) : null;

  return (
    <span className={`skin-select skin-select--${skin} ${className}`.trim()}>
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${optionIdPrefix}-${activeIndex}` : undefined}
        className="skin-select__trigger"
        disabled={disabled}
        data-wf={dataWf}
        onClick={() => (open ? close() : openAt(0))}
        onKeyDown={handleKeyDown}
      >
        <span className="skin-select__value">{summaryLabel}</span>
        <span className="skin-select__caret" aria-hidden>⌄</span>
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}
