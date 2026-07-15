import { useEffect, useRef, type RefObject } from "react";

/** 审查图标:放大镜内一枚对勾,线宽/尺寸对齐 RightPane 的 ExportIcon。 */
export function ReviewIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20 20" />
      <path d="M7.8 10.6l1.9 1.9 3.4-3.6" />
    </svg>
  );
}

interface ReviewMenuProps {
  anchorRef?: RefObject<HTMLElement>;
  onClose: () => void;
  onSensitiveReview: () => void;
  onDeaiReview: () => void;
  onSourceCheck: () => void;
  onConsistencyReview: () => void;
  onPrivacyReview: () => void;
  onFormatReview: () => void;
  onRoleReview: () => void;
  onCustomReview: () => void;
}

export function ReviewMenu({
  anchorRef,
  onClose,
  onSensitiveReview,
  onDeaiReview,
  onSourceCheck,
  onConsistencyReview,
  onPrivacyReview,
  onFormatReview,
  onRoleReview,
  onCustomReview,
}: ReviewMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchorRef?.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  return (
    <div ref={ref} className="ws-export-menu" role="menu" data-wf="ReviewMenu">
      <button type="button" role="menuitem" className="ws-export-item" onClick={onSourceCheck}>来源核查</button>
      <button type="button" role="menuitem" className="ws-export-item" onClick={onConsistencyReview}>一致性审查</button>
      <div className="ws-export-separator" role="separator" />
      <button type="button" role="menuitem" className="ws-export-item" onClick={onSensitiveReview}>敏感词审查</button>
      <button type="button" role="menuitem" className="ws-export-item" onClick={onPrivacyReview}>隐私泄露审查</button>
      <div className="ws-export-separator" role="separator" />
      <button type="button" role="menuitem" className="ws-export-item" onClick={onDeaiReview}>去AI味</button>
      <button type="button" role="menuitem" className="ws-export-item" onClick={onFormatReview}>格式规范审查</button>
      <div className="ws-export-separator" role="separator" />
      <button type="button" role="menuitem" className="ws-export-item" onClick={onRoleReview}>角色审查</button>
      <button type="button" role="menuitem" className="ws-export-item" onClick={onCustomReview}>自定义审查</button>
    </div>
  );
}
