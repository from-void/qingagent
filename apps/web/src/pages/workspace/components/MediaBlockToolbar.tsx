import type { MouseEvent as ReactMouseEvent } from "react";
import "./MediaBlockToolbar.css";

export type MediaBlockAlign = "left" | "center" | "right";

export function MediaBlockToolbar({
  align,
  onAlignChange,
  onFullscreen,
  ariaLabel,
  fullscreenAriaLabel,
  className,
}: {
  align: MediaBlockAlign;
  onAlignChange?: (align: MediaBlockAlign) => void;
  onFullscreen: () => void;
  ariaLabel: string;
  fullscreenAriaLabel: string;
  className?: string;
}) {
  const stop = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className={`pm-image-toolbar pm-image-chrome${className ? ` ${className}` : ""}`}
      contentEditable={false}
      role="toolbar"
      aria-label={ariaLabel}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {onAlignChange
        ? (["left", "center", "right"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`pm-image-tool${align === option ? " is-active" : ""}`}
              aria-label={alignTitle(option)}
              aria-pressed={align === option}
              title={alignTitle(option)}
              onMouseDown={(event) => {
                stop(event);
                onAlignChange(option);
              }}
            >
              {alignLabel(option)}
            </button>
          ))
        : null}
      <button
        type="button"
        className="pm-image-tool pm-image-tool--wide"
        aria-label={fullscreenAriaLabel}
        title="全屏查看"
        onMouseDown={(event) => {
          stop(event);
          onFullscreen();
        }}
      >
        全屏
      </button>
    </div>
  );
}

function alignTitle(align: MediaBlockAlign): string {
  if (align === "left") return "左对齐";
  if (align === "right") return "右对齐";
  return "居中";
}

function alignLabel(align: MediaBlockAlign): string {
  if (align === "left") return "左";
  if (align === "right") return "右";
  return "中";
}
