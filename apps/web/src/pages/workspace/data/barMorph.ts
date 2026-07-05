// 「同体 Magic Move」:把一个盒子从 fromRect 的几何(位置+尺寸)动画到目标几何,
// 位置和尺寸一起变(像 Keynote Magic Move / 共享元素过渡),用于编辑页
// 「输入框矩形 ⇄ 右侧操作条」的盒子形变。
// 关键:动画 left/top/width/height(真几何),不是 transform scale —— 这样金色边框始终 1px 清晰、不被拉糊。
// 纯 DOM、无 React 依赖,方便单测。

export interface MagicOpts {
  /** 形变时长(ms) */
  durationMs?: number;
  /** 缓动 */
  easing?: string;
  /** 到位回调(过渡结束 / 无需动画时同步触发) */
  onArrive?: () => void;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 可调参数(调试面板 Ctrl+Shift+H 实时改它;不传 opts 时读它当默认)。 */
export const morphTuning: { durationMs: number; easing: string } = {
  durationMs: 560,
  easing: "cubic-bezier(.34,1.28,.5,1)",
};

// kebab-case 供 removeProperty 用
const GEOM_KEYS_KEBAB = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "margin",
  "max-width",
  "box-sizing",
  "transition",
] as const;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
}

// 用 important 写,确保压过条 CSS 上的 `margin:0 auto !important` / `position:fixed !important` 等。
function setGeom(el: HTMLElement, prop: string, value: string): void {
  el.style.setProperty(prop, value, "important");
}

/** 把 el 用显式几何「钉」在 r(覆盖 fixed 条的 left/right/margin/max-width 居中定位)。 */
function pinGeom(el: HTMLElement, r: Rect): void {
  setGeom(el, "position", "fixed");
  setGeom(el, "left", `${r.left}px`);
  setGeom(el, "top", `${r.top}px`);
  setGeom(el, "right", "auto");
  setGeom(el, "bottom", "auto");
  setGeom(el, "width", `${r.width}px`);
  setGeom(el, "height", `${r.height}px`);
  setGeom(el, "margin", "0");
  setGeom(el, "max-width", "none");
  // getBoundingClientRect 是 border-box 量,锁 border-box 才能尺寸严格对齐
  setGeom(el, "box-sizing", "border-box");
}

/** 把 el 的几何动画到 r(尺寸+位置)。 */
function animateGeomTo(el: HTMLElement, r: Rect): void {
  setGeom(el, "left", `${r.left}px`);
  setGeom(el, "top", `${r.top}px`);
  setGeom(el, "width", `${r.width}px`);
  setGeom(el, "height", `${r.height}px`);
}

/** 清掉 pinGeom 打上的所有几何,让元素回到 CSS 自然定位。 */
function unpinGeom(el: HTMLElement): void {
  for (const k of GEOM_KEYS_KEBAB) el.style.removeProperty(k);
}

function geomTransition(durationMs: number, easing: string): string {
  return ["left", "top", "width", "height"]
    .map((p) => `${p} ${durationMs}ms ${easing}`)
    .join(", ");
}

/** 收尾(过渡结束或超时兜底,只触发一次)。 */
function settleOnce(el: HTMLElement, durationMs: number, done: () => void): void {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    el.removeEventListener("transitionend", onEnd);
    done();
  };
  const onEnd = (e: TransitionEvent) => {
    if (e.target === el && ["left", "top", "width", "height"].includes(e.propertyName)) {
      finish();
    }
  };
  el.addEventListener("transitionend", onEnd);
  window.setTimeout(finish, durationMs + 80);
}

/**
 * 进场:把 el 先「钉」到 fromRect 的几何(看起来还是输入框那个矩形),再动画到它自己的自然几何
 * (形变成条 + 移到右侧)。到位后清掉 inline、回到 CSS 自然态,并触发 onArrive。
 */
export function magicMoveFromRect(
  el: HTMLElement,
  fromRect: Rect | null,
  opts: MagicOpts = {},
): void {
  const { durationMs = morphTuning.durationMs, easing = morphTuning.easing, onArrive } = opts;
  const dest = el.getBoundingClientRect();
  if (!fromRect || (dest.width === 0 && dest.height === 0) || prefersReducedMotion()) {
    onArrive?.();
    return;
  }
  pinGeom(el, fromRect);
  void el.offsetWidth; // 让起始几何生效
  setGeom(el, "transition", geomTransition(durationMs, easing));
  animateGeomTo(el, dest);
  settleOnce(el, durationMs, () => {
    unpinGeom(el);
    onArrive?.();
  });
}

/**
 * 返回:把 el 从它当前自然几何动画「形变 + 移动」到 toRect 并停在那(不清 inline)。
 * 用于「条滑回输入框矩形」——条是移动+形变的那个元素,到位后由调用方卸载它、显示输入框,与进场严格对称。
 */
export function magicMoveToRect(
  el: HTMLElement,
  toRect: Rect | null,
  opts: MagicOpts = {},
): void {
  const { durationMs = morphTuning.durationMs, easing = morphTuning.easing, onArrive } = opts;
  if (!toRect || prefersReducedMotion()) {
    onArrive?.();
    return;
  }
  const cur = el.getBoundingClientRect();
  pinGeom(el, cur);
  void el.offsetWidth;
  setGeom(el, "transition", geomTransition(durationMs, easing));
  animateGeomTo(el, toRect);
  settleOnce(el, durationMs, () => {
    onArrive?.();
  });
}
