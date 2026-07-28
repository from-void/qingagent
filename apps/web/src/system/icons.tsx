// 全应用共用图标(描线 SVG,随 currentColor 着色)。
//
// 为什么统一收在这里:各页原先直接把 ✓ ⌄ ▾ ≡ ⬅ ↔ ➡ ↻ 这些**文字字符当图标用**,
// 字形随系统字体走 —— 粗细不一、基线歪、无法居中(用户点名「下拉箭头特别丑没居中」「勾很挫」)。
// 统一规格:viewBox 24 · stroke 1.6 · round cap/join · display:block(块级消除基线间隙,
// 放进 flex 容器天然水平垂直居中)。
import type { ReactNode } from "react";

interface IconBaseProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  rotate?: number;
  children: ReactNode;
}

function IconSvg({ size, className, strokeWidth = 1.6, rotate, children }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        display: "block",
        flexShrink: 0,
        ...(rotate ? { transform: `rotate(${rotate}deg)` } : null),
      }}
    >
      {children}
    </svg>
  );
}

/** 对勾:替代各处的文字勾符号(✓/√)。描线收笔,水墨描线风。 */
export function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0 }}
    >
      <path d="M4.5 12.8l4.6 4.7L19.5 6.6" />
    </svg>
  );
}

/** 向下箭头:用于聊天区回到底部按钮。 */
export function ArrowDownIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0 }}
    >
      <path d="M12 5v14" />
      <path d="m6.5 13.5 5.5 5.5 5.5-5.5" />
    </svg>
  );
}

export type CaretDirection = "down" | "up" | "left" | "right";

const CARET_ROTATION: Record<CaretDirection, number> = {
  down: 0,
  up: 180,
  left: 90,
  right: -90,
};

/** 折叠/下拉尖角:替代 ⌄ ∨ ▾ ▼ ▸ ‹ › 等字符。 */
export function CaretIcon({
  size = 12,
  direction = "down",
  className,
}: {
  size?: number;
  direction?: CaretDirection;
  className?: string;
}) {
  return (
    <IconSvg size={size} className={className} strokeWidth={2} rotate={CARET_ROTATION[direction]}>
      <path d="m6 9.5 6 6 6-6" />
    </IconSvg>
  );
}

/** 刷新/重来:替代 ↻ ⟳ 字符。 */
export function RefreshIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.6h-4.6" />
    </IconSvg>
  );
}

export type AlignVariant = "left" | "center" | "right" | "justify";

const ALIGN_LINES: Record<AlignVariant, string> = {
  // 四条横线,短线按对齐方向贴边 —— 比箭头更直白地表达"段落对齐"。
  left: "M4 6h16M4 11h10M4 16h16M4 21h10",
  center: "M4 6h16M7 11h10M4 16h16M7 21h10",
  right: "M4 6h16M10 11h10M4 16h16M10 21h10",
  justify: "M4 6h16M4 11h16M4 16h16M4 21h16",
};

/** 段落对齐:替代 ≡ ⬅ ↔ ➡ 字符,四项同族。 */
export function AlignIcon({
  align,
  size = 16,
  className,
}: {
  align: AlignVariant;
  size?: number;
  className?: string;
}) {
  return (
    <IconSvg size={size} className={className}>
      <path d={ALIGN_LINES[align]} />
    </IconSvg>
  );
}

/** 左向箭头:替代文字按钮里的 ← 字符。 */
export function ArrowLeftIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className}>
      <path d="M19 12H5" />
      <path d="m10.5 6.5-5.5 5.5 5.5 5.5" />
    </IconSvg>
  );
}

/** 右向箭头:替代文字按钮里的 → 字符。 */
export function ArrowRightIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className}>
      <path d="M5 12h14" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </IconSvg>
  );
}
