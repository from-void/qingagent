import type { MouseEvent as ReactMouseEvent } from "react";
import "./MediaBlockToolbar.css";

export type MediaBlockAlign = "left" | "center" | "right";

export function MediaBlockToolbar({
  align,
  onAlignChange,
  onZoomIn,
  onZoomOut,
  onFullscreen,
  ariaLabel,
  fullscreenAriaLabel,
  className,
}: {
  align: MediaBlockAlign;
  onAlignChange?: (align: MediaBlockAlign) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
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
      {onZoomIn && onZoomOut ? (
        <>
          <button
            type="button"
            className="pm-image-tool pm-image-tool--icon"
            aria-label="放大图表"
            title="放大图表"
            onMouseDown={(event) => {
              stop(event);
              onZoomIn();
            }}
          >
            <ZoomIcon direction="in" />
          </button>
          <button
            type="button"
            className="pm-image-tool pm-image-tool--icon"
            aria-label="缩小图表"
            title="缩小图表"
            onMouseDown={(event) => {
              stop(event);
              onZoomOut();
            }}
          >
            <ZoomIcon direction="out" />
          </button>
        </>
      ) : null}
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

// 缩放钮改图标(与画布左下角的 zoom-in/zoom-out 同一套线形),文字语义留在 aria-label/title。
function ZoomIcon({ direction }: { direction: "in" | "out" }) {
  return (
    <svg className="pm-image-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={direction === "in" ? "M3.2 8h9.6M8 3.2v9.6" : "M3.2 8h9.6"}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
