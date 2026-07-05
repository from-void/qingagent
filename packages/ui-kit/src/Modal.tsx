import type { ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
}

export function Modal({ open, title, onClose, children }: ModalProps) {
  const cls = ["wf-modal"];
  if (open) cls.push("open");
  return (
    <div data-wf="Modal" className={cls.join(" ")} aria-hidden={!open} role="dialog">
      <div className="card">
        <div className="head">
          <span>{title}</span>
          {onClose ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="close"
              onClick={onClose}
              style={{ cursor: "pointer" }}
            >
              ×
            </span>
          ) : null}
        </div>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}
