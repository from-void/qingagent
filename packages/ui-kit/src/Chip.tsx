import type { ReactNode } from "react";

export type ChipVariant = "default" | "solid" | "dashed" | "mono";

export interface ChipProps {
  variant?: ChipVariant;
  dot?: boolean;
  onRemove?: () => void;
  children?: ReactNode;
}

export function Chip({ variant = "default", dot, onRemove, children }: ChipProps) {
  const cls = ["wf-chip"];
  if (variant !== "default") cls.push(variant);
  return (
    <span data-wf="Chip" className={cls.join(" ")}>
      {dot ? <span className="dot" /> : null}
      {children}
      {onRemove ? (
        <span
          className="x"
          role="button"
          tabIndex={0}
          aria-label="remove"
          onClick={onRemove}
        >
          ×
        </span>
      ) : null}
    </span>
  );
}
