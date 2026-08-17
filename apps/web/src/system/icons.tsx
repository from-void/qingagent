// 全应用共用图标(描线 SVG,随 currentColor 着色)。
//
// 为什么统一收在这里:各页原先直接把 ✓ ⌄ ▾ ≡ ⬅ ↔ ➡ ↻ 这些**文字字符当图标用**,
// 字形随系统字体走 —— 粗细不一、基线歪、无法居中(用户点名「下拉箭头特别丑没居中」「勾很挫」)。
// 统一规格:viewBox 24 · stroke 1.6 · square cap / miter join · display:block(块级消除基线间隙,
// 放进 flex 容器天然水平垂直居中)。
import type { ReactNode } from "react";

interface IconBaseProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  rotate?: number;
  children: ReactNode;
}

const CLOSE_ICON_PATH = "M6 6l12 12M18 6 6 18";
const QUOTE_ICON_PATH = "M9.5 7H7a3 3 0 0 0-3 3v5h5v-5H6M20 7h-2.5a3 3 0 0 0-3 3v5h5v-5h-3";
const SPARKLE_ICON_PATH = "M10 3c0 5-2 7-7 7 5 0 7 2 7 7 0-5 2-7 7-7-5 0-7-2-7-7ZM18 3v5M15.5 5.5h5";

/** DOM 手工节点使用的关闭图标；与 React 版 CloseIcon 共用同一几何。 */
export const CLOSE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false" style="display:block;flex-shrink:0"><path d="${CLOSE_ICON_PATH}"/></svg>`;
export const QUOTE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false" style="display:block;flex-shrink:0"><path d="${QUOTE_ICON_PATH}"/></svg>`;
export const SPARKLE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-1px;flex-shrink:0"><path d="${SPARKLE_ICON_PATH}"/></svg>`;

function IconSvg({ size, className, strokeWidth = 1.6, rotate, children }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
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

/** 关闭：用于弹层、Toast、chip 等关闭入口。 */
export function CloseIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d={CLOSE_ICON_PATH} />
    </IconSvg>
  );
}

/** 设置：用于产品设置入口，齿轮轮廓随 currentColor 着色。 */
export function SettingsIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.7}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </IconSvg>
  );
}

/** AI 动作：线性双星，替代 ✨ / ✦ 字符。 */
export function SparkleIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.7}>
      <path d={SPARKLE_ICON_PATH} />
    </IconSvg>
  );
}

/** 文件夹：用于连接本地资料库入口。 */
export function FolderIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.7}>
      <path d="M3.5 6.5h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z" />
      <path d="M3.5 9h17" />
    </IconSvg>
  );
}

/** 警示：用于开发态审计提示，颜色由父级语义 token 决定。 */
export function WarningIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.7}>
      <path d="M12 3.5 21 20H3Z" />
      <path d="M12 9v5M12 17.2h.01" />
    </IconSvg>
  );
}

/** 合并单元格：网格与向内箭头。 */
export function MergeCellsIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.6}>
      <rect x="4" y="5" width="16" height="14" />
      <path d="M4 12h16M12 5v14M7 9l3 3-3 3M17 9l-3 3 3 3" />
    </IconSvg>
  );
}

/** 删除列：列框与叉号。 */
export function DeleteColumnIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.6}>
      <rect x="5" y="3.5" width="8" height="17" />
      <path d="m15.5 9 5 5M20.5 9l-5 5" />
    </IconSvg>
  );
}

/** 全屏：四个直角框角，替代 ⛶ 字符。 */
export function FullscreenIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
    </IconSvg>
  );
}

/** 引用：用于引用型 chip，替代 ❝ 字符。 */
export function QuoteIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d={QUOTE_ICON_PATH} />
    </IconSvg>
  );
}

/** 状态圆点：替代承担状态图标语义的 ● / ·。 */
export function StatusDotIcon({ size = 8, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={0}>
      <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

/** 状态方块：替代承担失败/中止状态语义的 ■。 */
export function StatusSquareIcon({ size = 8, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={0}>
      <rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

/** 搜索：放大镜线性图标。 */
export function SearchIcon({ size = 17, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </IconSvg>
  );
}

/** 新增：直角坐标内居中的加号。 */
export function PlusIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d="M12 5v14M5 12h14" />
    </IconSvg>
  );
}

/** 外部链接：替代链接卡片尾部的 ↗ 字符。 */
export function ExternalLinkIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
    </IconSvg>
  );
}

/** 斜向移动：用于形变调试入口，替代 ↘ / ↙ 字符。 */
export function DiagonalArrowIcon({
  direction,
  size = 12,
  className,
}: {
  direction: "down-right" | "down-left";
  size?: number;
  className?: string;
}) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8} rotate={direction === "down-right" ? 45 : 135}>
      <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />
    </IconSvg>
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
      strokeLinecap="square"
      strokeLinejoin="miter"
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
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0 }}
    >
      <path d="M12 5v14" />
      <path d="m6.5 13.5 5.5 5.5 5.5-5.5" />
    </svg>
  );
}

/** 向上箭头：用于上一处、向上查找。 */
export function ArrowUpIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={2}>
      <path d="M12 19V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
    </IconSvg>
  );
}

/** 横向交换：用于查找栏切换替换区。 */
export function SwapHorizontalIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <IconSvg size={size} className={className} strokeWidth={1.8}>
      <path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5" />
      <path d="M20 16H6M9.5 12.5 6 16l3.5 3.5" />
    </IconSvg>
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
