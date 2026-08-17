import { useId, type ReactNode } from "react";
import { useOverlayDismiss } from "../../../../system/overlayDismissStack";
import { CaretIcon, CloseIcon } from "../icons";

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

  // 审查与衍生稿配置共用同一 modal 壳。自身进栈后，确认卡等后开的浮层
  // 会自然排在上面；Esc 始终只弹栈顶，不会一并关掉底层配置或预览。
  useOverlayDismiss(true, () => {
    if (!props.closeDisabled) props.onClose();
  });

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
            <button type="button" className="ws-launch-back" disabled={props.closeDisabled} onClick={props.onBack}><CaretIcon size={13} direction="left" />返回</button>
          ) : null}
          <h2 id={titleId}>{props.title}</h2>
          {props.subtitle ? <span className="ws-launch-subtitle">{props.subtitle}</span> : null}
          <button type="button" className="ws-launch-close" aria-label="关闭" disabled={props.closeDisabled} onClick={props.onClose}><CloseIcon size={16} /></button>
        </header>
        <div className="ws-launch-body">{props.children}</div>
      </section>
    </div>
  );
}
