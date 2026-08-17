// 档位 chip:收起只显示档名(Flash / K2.7),点开浮层才见每档说明与价格。
// 浮层 portal 到 body 并用既有 useAnchoredPopover 定位(与 SkinSelect 同一姿势),
// 因此不会被卡片或 .qj-sheet-body 的滚动容器/底部遮罩裁切。
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../system/useAnchoredPopover";
import { useOverlayDismiss } from "../../system/overlayDismissStack";
import { CaretIcon } from "../../system/icons";
import { MODEL_TIERS, VENDOR_META, providerWfKey } from "./modelVendorMeta";
import type { ModelProvider, ModelTier } from "./visitorKeyStore";

interface ModelTierChipProps {
  provider: ModelProvider;
  tier: ModelTier;
  disabled?: boolean;
  onChange: (tier: ModelTier) => void;
}

export function ModelTierChip({ provider, tier, disabled = false, onChange }: ModelTierChipProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const meta = VENDOR_META[provider];
  const selectedIndex = Math.max(0, MODEL_TIERS.indexOf(tier));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const position = useAnchoredPopover(open, anchorRef, panelRef);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  // 开着时进浮层关闭栈:Esc 由面板级守卫统一弹栈关闭,焦点不在 chip 上也能关
  useOverlayDismiss(open, () => {
    setOpen(false);
    anchorRef.current?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  const openAt = (index: number) => {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (index: number) => {
    const next = MODEL_TIERS[index];
    setOpen(false);
    anchorRef.current?.focus();
    if (next && next !== tier) onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (activeIndex + delta + MODEL_TIERS.length) % MODEL_TIERS.length;
        if (open) setActiveIndex(next);
        else openAt(next);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(activeIndex);
        else openAt(selectedIndex);
        break;
      case "Escape":
        // 设置弹层内 Esc 由面板级守卫走浮层关闭栈统一处理(先于本处捕获并消费);
        // 这里只兜住脱离设置弹层单独使用本组件的场景。
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
    }
  };

  const menu = open ? (
    <div
      ref={panelRef}
      id={listboxId}
      role="listbox"
      aria-label={`${meta.name} 模型档位`}
      className="skin-select__menu skin-select__menu--ink md-tier-menu"
      style={position}
    >
      {MODEL_TIERS.map((option, index) => (
        <button
          key={option}
          id={`${optionIdPrefix}-${index}`}
          type="button"
          role="option"
          aria-selected={option === tier}
          className={`skin-select__option md-tier-option${index === activeIndex ? " is-active" : ""}`}
          data-wf={`ModelTier${providerWfKey(provider)}${option === "pro" ? "Pro" : "Flash"}`}
          onPointerMove={() => setActiveIndex(index)}
          onClick={() => choose(index)}
        >
          <span className="md-tier-name">{meta.tiers[option].name}</span>
          <span className="md-tier-desc">{meta.tiers[option].desc}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <span className="vd-chipwrap">
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        className="vd-chip"
        aria-label={`${meta.name} 模型档位`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${optionIdPrefix}-${activeIndex}` : undefined}
        disabled={disabled}
        data-wf={`ModelTierChip${providerWfKey(provider)}`}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex))}
        onKeyDown={handleKeyDown}
      >
        {meta.tiers[tier].name}
        <CaretIcon size={10} />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}
