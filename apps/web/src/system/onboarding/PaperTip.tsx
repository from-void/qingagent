import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import "./paperTip.css";

export interface PaperTipProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  accent?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 锚定式说明浮层的统一纸签基座。定位、箭头和显隐仍由各使用场景负责。
 */
export const PaperTip = forwardRef<HTMLDivElement, PaperTipProps>(function PaperTip(
  {
    title,
    accent,
    actions,
    children,
    className,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`paper-tip${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <div className="paper-tip__title">
        <span
          className="paper-tip__title-dot"
          aria-hidden="true"
          style={accent ? { backgroundColor: accent } : undefined}
        />
        {title}
      </div>
      <div className="paper-tip__body">{children}</div>
      {actions ? <div className="paper-tip__footer">{actions}</div> : null}
    </div>
  );
});
