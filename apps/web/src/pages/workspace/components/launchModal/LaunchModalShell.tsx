import { useId, type ReactNode } from "react";

export function LaunchModalShell(props: {
  title: ReactNode;
  subtitle?: string;
  onBack?: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
  dataWf?: string;
  children: ReactNode;
}) {
  const titleId = useId();

  return (
    <div
      className="ws-folder-modal-overlay ws-launch-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.closeDisabled) props.onClose();
      }}
    >
      <section
        className="ws-folder-intro-modal ws-launch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-wf={props.dataWf ?? "LaunchModalShell"}
      >
        <header className="ws-launch-head">
          {props.onBack ? (
            <button type="button" className="ws-launch-back" disabled={props.closeDisabled} onClick={props.onBack}>‹ 返回</button>
          ) : null}
          <h2 id={titleId}>{props.title}</h2>
          {props.subtitle ? <span className="ws-launch-subtitle">{props.subtitle}</span> : null}
          <button type="button" className="ws-launch-close" aria-label="关闭" disabled={props.closeDisabled} onClick={props.onClose}>×</button>
        </header>
        <div className="ws-launch-body">{props.children}</div>
      </section>
    </div>
  );
}
