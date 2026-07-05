import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./MediaZoomFullscreen.css";

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

type Transform = {
  x: number;
  y: number;
  scale: number;
};

export function MediaZoomFullscreen({
  open,
  onClose,
  children,
  ariaLabel = "全屏查看",
  contentClassName,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
  contentClassName?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  // 仅拖拽平移期间挂 will-change:transform(合成层让拖拽顺滑);静止/缩放后撤掉,
  // 让 SVG 回到矢量渲染、保持清晰(否则常驻合成层会把矢量栅格化 → 全屏看图发糊)。
  const [panning, setPanning] = useState(false);

  const reset = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      setTransform({ x: 0, y: 0, scale: 1 });
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const contentWidth = contentRect.width || content.offsetWidth;
    const contentHeight = contentRect.height || content.offsetHeight;
    setTransform({
      scale: 1,
      x: (viewportRect.width - contentWidth) / 2,
      y: (viewportRect.height - contentHeight) / 2,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(reset);
    return () => window.cancelAnimationFrame(frame);
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    setTransform((current) => {
      const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const contentX = (localX - current.x) / current.scale;
      const contentY = (localY - current.y) / current.scale;
      return {
        scale: clampedScale,
        x: localX - contentX * clampedScale,
        y: localY - contentY * clampedScale,
      };
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, transform.scale * factor);
  }, [transform.scale, zoomAt]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="media-zoom-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="media-zoom-toolbar" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="media-zoom-btn" aria-label="放大" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <button type="button" className="media-zoom-btn" aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}>
          -
        </button>
        <button type="button" className="media-zoom-btn media-zoom-btn--text" onClick={reset}>
          复位
        </button>
        <button type="button" className="media-zoom-btn media-zoom-btn--text" onClick={onClose}>
          关闭
        </button>
      </div>
      <div
        ref={viewportRef}
        className="media-zoom-viewport"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onWheel={(event) => {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
          zoomAt(event.clientX, event.clientY, transform.scale * factor);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          reset();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setPanning(true);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: transform.x,
            originY: transform.y,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setTransform((current) => ({
            ...current,
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY,
          }));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setPanning(false);
          }
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setPanning(false);
          }
        }}
      >
        <div
          ref={contentRef}
          className={`media-zoom-content${contentClassName ? ` ${contentClassName}` : ""}`}
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            willChange: panning ? "transform" : undefined,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
