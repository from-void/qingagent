import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./phoneShell.css";

export const calculatePhoneScale = (availableHeight: number) => Math.max(560 / 812, Math.min(1, availableHeight / 812));

function StatusIcons() {
  return <span className="ps-status-icons" aria-label="蜂窝网络、无线网络、电量 80%">
    <svg className="ps-cellular" viewBox="0 0 18 12" aria-hidden="true">
      <rect x="0" y="8" width="3" height="4" rx="1.5"/><rect x="5" y="6" width="3" height="6" rx="1.5"/>
      <rect x="10" y="3" width="3" height="9" rx="1.5"/><rect x="15" y="0" width="3" height="12" rx="1.5"/>
    </svg>
    <svg className="ps-wifi" viewBox="0 0 16 12" aria-hidden="true">
      <path d="M1 4.2a10 10 0 0 1 14 0"/><path d="M3.5 6.7a6.5 6.5 0 0 1 9 0"/><path d="M6 9.1a2.9 2.9 0 0 1 4 0"/><circle cx="8" cy="11" r="1"/>
    </svg>
    <svg className="ps-battery" viewBox="0 0 25 12" aria-hidden="true">
      <rect className="ps-battery-case" x=".6" y=".6" width="21.2" height="10.8" rx="2.4"/>
      <rect className="ps-battery-fill" x="2.5" y="2.5" width="16.2" height="7" rx="1.3"/>
      <path className="ps-battery-cap" d="M23 4v4c1 0 1.5-.6 1.5-1.5v-1C24.5 4.6 24 4 23 4Z"/>
    </svg>
  </span>;
}

export function PhoneShell({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const container = wrapper?.parentElement;
    const viewport = wrapper?.closest<HTMLElement>(".ws-right");
    if (!wrapper || !container || !viewport || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 衍生纸会随内容自然长高；缩放预算直接取 .ws-right 的视口高，
        // 纸内 segmented/padding 由自然高度承接，不能再次挤压手机壳。
        setScale(calculatePhoneScale(viewport.clientHeight));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(frame); };
  }, []);

  return <div ref={wrapperRef} className="ws-phone-slot" style={{ width: 375 * scale, height: 812 * scale }} data-scale={scale.toFixed(3)}><div className="ws-phone" style={{ transform: `translateX(-50%) scale(${scale})` }}><div className="ws-phone-screen">
    <div className="ps-statusbar"><span className="ps-status-time">{new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span><StatusIcons/></div>
    {children}
    <div className="ws-phone-home"/>
  </div></div></div>;
}
