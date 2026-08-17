import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { normalizeSkillIconKey, SKILL_MENU_ICON_PATHS } from "./skillIcons";
import { SparkleIcon, SPARKLE_ICON_SVG } from "./icons";
import "./skill-menu.css";

// 技能菜单的单条动作(展示用)。新建页 / 编辑页共用同一份结构,避免两边各写一套又漂移。
export interface SkillMenuAction {
  id: string;
  label: string;
  /** 行内展示的短说明。 */
  description: string;
  /** tooltip 使用的完整说明；旧调用方未提供时回退到行内说明。 */
  fullDescription?: string;
  placeholder: string;
  icon: string;
}

/** DOM 版(给 contenteditable 里手搓的 chip 用)。显式给尺寸,否则无尺寸 inline SVG 会撑成 300×150。 */
export const SPARKLE_SVG = SPARKLE_ICON_SVG;

// 文件占位 chip 的线性文件图标(替代 📎 emoji)。DOM 版给 contenteditable 里手搓的 chip 用。
const FILE_CHIP_PATHS =
  '<path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9z"/><path d="M13.5 3.5V9H19"/>';
export const FILE_CHIP_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" style="display:inline-block;vertical-align:-1px">${FILE_CHIP_PATHS}</svg>`;

/** React 版文件图标(给气泡里的 chip badge 用)。 */
export function FileChipIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M13.5 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9z" />
      <path d="M13.5 3.5V9H19" />
    </svg>
  );
}

export { SparkleIcon };

export function SkillMenuIcon({ icon }: { icon: string }) {
  const iconKey = normalizeSkillIconKey(icon);
  return (
    <svg
      className="qa-skill-ico"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SKILL_MENU_ICON_PATHS[iconKey]}
    </svg>
  );
}

/**
 * 共享技能菜单浮层（单行「图标 + 粗名 + 行内说明」）。
 * 新建页与编辑页都渲染它,样式/图标/排版只此一处定义——彻底消除两边漂移。
 * 定位:绝对定位、贴在触发按钮上方(要求父元素 position:relative)。
 * 键盘导航:`selectedIndex` 由调用方驱动(反斜杠唤起后 ↑/↓ 改它、Enter 选中);
 * 鼠标 hover 也会高亮(CSS)。关闭(点外部 / Esc)由各自页面控制开合状态。
 */
/** 菜单宽度(与 skill-menu.css 的 width 一致),调用方夹紧 left 时用。 */
export const SKILL_MENU_WIDTH = 300;
/** 一行 = 12.5px × 1.4 行高 + 上下各 7px 内边距。 */
export const SKILL_MENU_ROW_HEIGHT = 31.5;
/** 7 行完整展示；更多项目时再露出下一行的一半，提示菜单可滚动。 */
export const SKILL_MENU_FULL_ROWS = 7;
const SKILL_MENU_CHROME_HEIGHT = 12; // 上下内边距 10px + 边框 2px
export const SKILL_MENU_PEEK_HEIGHT =
  SKILL_MENU_ROW_HEIGHT * (SKILL_MENU_FULL_ROWS + 0.5) + SKILL_MENU_CHROME_HEIGHT;
const DESCRIPTION_OVERFLOW_TOLERANCE_PX = 1;

/**
 * Range 保留亚像素文本宽度，避免 scrollWidth/clientWidth 取整后在缩放屏上误判。
 * jsdom 没有真实 Range 布局，回退到整数宽度也让 DOM 单测只负责逻辑、不伪装真布局。
 */
function isDescriptionTruncated(description: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(description);
  const textWidth = typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect().width
    : 0;
  const elementWidth = description.getBoundingClientRect().width;
  if (textWidth > 0 && elementWidth > 0) {
    return textWidth - elementWidth > DESCRIPTION_OVERFLOW_TOLERANCE_PX;
  }
  return description.scrollWidth - description.clientWidth > DESCRIPTION_OVERFLOW_TOLERANCE_PX;
}

function SkillMenuRow({
  skill,
  index,
  isActive,
  disabled,
  onPick,
  onHoverIndex,
}: {
  skill: SkillMenuAction;
  index: number;
  isActive: boolean;
  disabled?: boolean;
  onPick: (action: SkillMenuAction) => void;
  onHoverIndex?: (index: number) => void;
}) {
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const measureRafRef = useRef<number | null>(null);
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);

  const measureDescription = useCallback(() => {
    const description = descriptionRef.current;
    const truncated = Boolean(description && isDescriptionTruncated(description));
    setDescriptionTruncated((current) => current === truncated ? current : truncated);
  }, []);

  const scheduleDescriptionMeasure = useCallback(() => {
    if (measureRafRef.current !== null) {
      window.cancelAnimationFrame(measureRafRef.current);
    }
    measureRafRef.current = window.requestAnimationFrame(() => {
      measureRafRef.current = null;
      measureDescription();
    });
  }, [measureDescription]);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (!description) return undefined;

    let disposed = false;
    measureDescription();
    scheduleDescriptionMeasure();

    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      void fontsReady.then(() => {
        if (!disposed) scheduleDescriptionMeasure();
      });
    }

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleDescriptionMeasure);
    observer?.observe(description);
    return () => {
      disposed = true;
      observer?.disconnect();
      if (measureRafRef.current !== null) {
        window.cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
    };
  }, [measureDescription, scheduleDescriptionMeasure, skill.description]);

  return (
    <button
      type="button"
      className={`qa-skill-row${isActive ? " is-active" : ""}`}
      role="menuitem"
      // 只在右侧说明实际被截断时挂完整说明；工作区由统一 WorkspaceTooltip 接管并绘制提示。
      title={descriptionTruncated ? (skill.fullDescription ?? skill.description) : undefined}
      // mousedown 先于编辑器 blur 触发,保证点击能选中(不被失焦关闭抢先)。
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(skill);
      }}
      onMouseEnter={measureDescription}
      onMouseMove={() => onHoverIndex?.(index)}
      disabled={disabled}
    >
      <SkillMenuIcon icon={skill.icon} />
      <span className="qa-skill-name">{skill.label}</span>
      <span ref={descriptionRef} className="qa-skill-desc">{skill.description}</span>
    </button>
  );
}

export function SkillMenu({
  actions,
  onPick,
  disabled,
  selectedIndex = -1,
  onHoverIndex,
  anchor,
  dataWf,
}: {
  actions: SkillMenuAction[];
  onPick: (action: SkillMenuAction) => void;
  disabled?: boolean;
  /** 键盘高亮的行序号(-1 = 无高亮,纯靠鼠标 hover)。 */
  selectedIndex?: number;
  /** 鼠标移到某行时回传序号,让键盘高亮跟随鼠标(可选)。 */
  onHoverIndex?: (index: number) => void;
  /**
   * 光标锚点:`{left, bottom}` 是相对「触发容器」(position:relative 的父元素)的 absolute 坐标,
   * 由调用方按 光标rect - 容器rect 算好传入(`/` 唤起)。不传则默认贴触发按钮上方。
   * 不用 fixed:输入框祖先常有 backdrop-filter/transform,会让 fixed 改相对那个祖先而错位。
   */
  anchor?: { left: number; bottom: number } | null;
  dataWf?: string;
}) {
  const style: CSSProperties | undefined =
    anchor || actions.length > SKILL_MENU_FULL_ROWS
      ? {
          ...(anchor
            ? { left: anchor.left, bottom: anchor.bottom, top: "auto", right: "auto" }
            : {}),
          ...(actions.length > SKILL_MENU_FULL_ROWS
            ? { maxHeight: `min(60vh, ${SKILL_MENU_PEEK_HEIGHT}px)` }
            : {}),
        }
      : undefined;
  return (
    <div className="qa-skill-menu" style={style} data-wf={dataWf} role="menu">
      {actions.length === 0 ? (
        <div className="qa-skill-empty">暂无可用技能</div>
      ) : (
        actions.map((skill, i) => (
          <SkillMenuRow
            key={skill.id}
            skill={skill}
            index={i}
            isActive={i === selectedIndex}
            onPick={onPick}
            onHoverIndex={onHoverIndex}
            disabled={disabled}
          />
        ))
      )}
    </div>
  );
}
