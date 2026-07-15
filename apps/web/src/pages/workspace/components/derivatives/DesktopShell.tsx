import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./desktopShell.css";

export const DESKTOP_FRAME = {
  width: 1232,
  height: 740,
  lidWidth: 1140,
  lidHeight: 730,
  viewportWidth: 1100,
  viewportHeight: 690,
  baseWidth: 1232,
  baseHeight: 10,
} as const;
export const DESKTOP_PAPER_INSET = { horizontal: 40, vertical: 80 } as const;
export const calculateDesktopScale = (availableWidth: number, availableHeight: number) =>
  Math.min(1, Math.max(0.42, Math.min(
    (availableWidth - DESKTOP_PAPER_INSET.horizontal * 2) / DESKTOP_FRAME.width,
    (availableHeight - DESKTOP_PAPER_INSET.vertical) / DESKTOP_FRAME.height,
  )));

export function DesktopShell({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const container = wrapper?.parentElement;
    const viewport = wrapper?.closest<HTMLElement>(".ws-right");
    if (!wrapper || !container || !viewport || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setScale(calculateDesktopScale(container.clientWidth, viewport.clientHeight))); };
    const observer = new ResizeObserver(measure);
    observer.observe(container); observer.observe(viewport); window.addEventListener("resize", measure); measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={wrapperRef} className="ws-desktop-slot" style={{ width: DESKTOP_FRAME.width * scale, height: DESKTOP_FRAME.height * scale }} data-scale={scale.toFixed(3)}><div className="ws-macbook" style={{ transform: `translateX(-50%) scale(${scale})` }}><div className="ws-macbook-lid"><div className="ws-macbook-bezel"><i className="ws-macbook-camera" aria-hidden="true"/><div className="ws-macbook-viewport" data-design-size={`${DESKTOP_FRAME.viewportWidth}x${DESKTOP_FRAME.viewportHeight}`} data-scroll="vertical">{children}</div></div></div><div className="ws-macbook-base" aria-hidden="true"><i className="ws-macbook-notch"/></div></div></div>;
}
