import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export interface PressableProps {
  className?: string;
  style?: CSSProperties;
  /** Activated by click, Enter, or Space. */
  onPress: () => void;
  ariaLabel?: string;
  ariaPressed?: boolean;
  title?: string;
  /** Additional `data-*` attrs forwarded to the root. */
  dataAttrs?: Record<string, string>;
  children: ReactNode;
}

/**
 * Div-based button used where the wireframe's CSS targets a non-`<button>`
 * element directly (e.g. `.hn-item`, `.s-card`). Replaces the demo's
 * inline `onclick=...` handlers with React + keyboard a11y, without
 * forcing a CSS reset for native `<button>` chrome.
 */
export function Pressable({
  className,
  style,
  onPress,
  ariaLabel,
  ariaPressed,
  title,
  dataAttrs,
  children,
}: PressableProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPress();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={className}
      style={style}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      onClick={onPress}
      onKeyDown={onKeyDown}
      {...dataAttrs}
    >
      {children}
    </div>
  );
}
