import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import {
  CARD_WIDTH,
  CardRenderer,
  createDefaultRegistry,
} from "../../../system/chinese-masonry";
import "../../../system/chinese-masonry/style.css";
import type { SelectorOptions } from "../../../system/chinese-masonry";
import type { HomeSession } from "../data/sessions";
import { clearOpenSettingsFlag, readOpenSettingsFlag } from "../../../system/modelKeyGate";
import {
  BIRD_WING_L,
  BIRD_WING_R,
  INK_PLANTS,
  buildFlock,
  decorateMotion,
  hashSeed,
  makeRng,
  type InkEl,
  type InkPlant,
} from "./inkBrush";
import { colorConfig, qingagentTemplateFilter } from "./masonryAdapters";
import { buildHomeCardEntries, type HomeCardEntry } from "./stableTemplateSelection";
import {
  clearHomeArrive,
  computeWorkspaceDocRect,
  peekHomeArrive,
  setWorkspaceArrive,
} from "../../new-session/transition/origin";
import {
  createHomeTransitionStage,
  type HomeTransitionStage,
} from "../../new-session/transition/homeStage";
import "./qingjian.css";
import { HomeSettingsSheet, type SettingsSheetTab } from "./HomeSettingsSheet";
import {
  SETTINGS_INK_VARIANT_LABEL,
  SETTINGS_INK_VARIANTS,
  type SettingsInkVariantId,
} from "./settingsInkVariants/types";

// ---------------------------------------------------------------------------
// 主题 / 进场动画常量
// ---------------------------------------------------------------------------

// 实际配色(data-theme 值):浅色宣纸 paper / 深色玄青 dark。深栗/黛青已下线。
const THEMES = ["paper", "dark"] as const;
type ThemeId = (typeof THEMES)[number];

// 明暗模式:白天(浅)/深夜(深)/跟随系统,解析为实际配色 paper|dark
const THEME_MODES = ["light", "dark", "system"] as const;
type ThemeMode = (typeof THEME_MODES)[number];
const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: "白天",
  dark: "深夜",
  system: "跟随系统",
};
const THEME_MODE_OPTIONS = THEME_MODES.map((id) => ({ id, label: THEME_MODE_LABEL[id] }));
function resolveTheme(_mode: ThemeMode, _systemDark: boolean): ThemeId {
  // 产品决定:只保留浅色宣纸,不再有深/浅模式(外观设置项已隐藏)。永远返回 paper。
  return "paper";
}

const ANIMS = ["fly", "rise", "ink", "drift"] as const;
type AnimId = (typeof ANIMS)[number];
const ANIM_LABEL: Record<AnimId, string> = {
  fly: "飞入",
  rise: "浮起",
  ink: "揭显",
  drift: "旋落",
};
const ANIM_OPTIONS = ANIMS.map((id) => ({ id, label: ANIM_LABEL[id] }));

// 字体统一走宋体家族;保留设置结构,旧本地偏好会回落到 serif。
const FONTS = ["serif"] as const;
type FontId = (typeof FONTS)[number];
const FONT_LABEL: Record<FontId, string> = {
  serif: "宋体",
};
const FONT_STACK: Record<FontId, string> = {
  serif: '"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif',
};
const FONT_OPTIONS = FONTS.map((id) => ({ id, label: FONT_LABEL[id] }));
function readFontPref(key: string): FontId {
  try {
    const v = localStorage.getItem(key);
    if (v && (FONTS as readonly string[]).includes(v)) return v as FontId;
  } catch {
    /* ignore */
  }
  return "serif";
}

const STORE_THEME_MODE = "qj-theme-mode";
const STORE_THEME_LEGACY = "qj-theme"; // 旧版四色配色,仅用于迁移
const STORE_ANIM = "qj-anim";
const STORE_REDUCE = "qj-reduce";
const STORE_FONT_PRIMARY = "qj-font-primary";
const STORE_FONT_SECONDARY = "qj-font-secondary";
const STORE_SETTINGS_INK = "qj-settings-ink-variant";
const STORE_OPENING_PLAYED = "qj-opening-scroll-played";

const SEAL_SRC = "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png";

// 布局常量(对齐 demo)
const GAP_X = 42;
const PAD_LEFT = 64;
const PAD_RIGHT = 28;
const SCROLL_FIXED_WIDTH = 52 + 26 + 168 + 26 + 26 + 130 + 26 + 52;
const SCROLL_RIGHT_GAP = 36;
const MAT_PAD = 38;
const PAD_TOP = 14;
const PAD_BOT = 14;
const NEW_CARD_H = 380;
const COLUMN_PATTERN = [3, 2, 3];
// 新建卡固定槽位:独占首列、不参与瀑布流随机分布。left = PAD_LEFT,top = 画心垂直居中。
// 同时把这个确定坐标导出到 origin,供新建页返回时精确飞回(像素级对准)。
const NEW_CARD_LEFT = PAD_LEFT;

function getOpeningRouteMode(): { isHome: boolean; forceReplay: boolean } {
  try {
    const hash = window.location.hash || "#/";
    const routeHash = hash.split(";")[0]?.replace(/\?.*$/, "") || "#/";
    const isHome = routeHash === "" || routeHash === "#" || routeHash === "#/";
    const params = new URLSearchParams(hash.split("?")[1]?.split(";")[0] ?? "");
    return {
      isHome,
      forceReplay: params.get("opening") === "1",
    };
  } catch {
    return { isHome: true, forceReplay: false };
  }
}

const openingRouteMode = getOpeningRouteMode();
let hasPlayedOpeningScroll =
  !openingRouteMode.isHome || (!openingRouteMode.forceReplay && readOpeningScrollPlayed());

function readOpeningScrollPlayed(): boolean {
  try {
    return sessionStorage.getItem(STORE_OPENING_PLAYED) === "1";
  } catch {
    return false;
  }
}

function markOpeningScrollPlayed() {
  hasPlayedOpeningScroll = true;
  try {
    sessionStorage.setItem(STORE_OPENING_PLAYED, "1");
  } catch {
    /* ignore */
  }
}

function shouldPlayOpeningScroll(): boolean {
  try {
    const reduceBySetting = localStorage.getItem(STORE_REDUCE) === "1";
    const reduceBySystem = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const routeMode = getOpeningRouteMode();
    if (routeMode.forceReplay) {
      return routeMode.isHome && !reduceBySetting && !reduceBySystem;
    }
    return (
      !hasPlayedOpeningScroll &&
      !readOpeningScrollPlayed() &&
      !reduceBySetting &&
      !reduceBySystem &&
      !peekHomeArrive()
    );
  } catch {
    return !hasPlayedOpeningScroll;
  }
}

interface QingjianScrollProps {
  sessions: HomeSession[];
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onOpenShelf?: () => void;
  cleanMode?: boolean;
  /** 外部(右键菜单「打开」)调用带动画打开的出口:组件把内部 triggerOpenSession 写进此 ref,
   *  外部调用即复用与左键点击完全一致的墨水过场;卡片不可见时 triggerOpenSession 自带直接导航兜底。 */
  openApiRef?: MutableRefObject<((sessionId: string) => void) | null>;
}

// 一张卡在序列中的渲染数据
type CardEntry = HomeCardEntry;

// 布局后每张卡的位置
interface PlacedSlot {
  entry: CardEntry;
  globalIdx: number;
  col: number;
  left: number;
  top: number;
  layer: number;
  enterX: number;
  enterY: number;
  enterRot: number;
}

interface BuiltLayout {
  slots: PlacedSlot[];
  stageMoments: StageMoment[];
  coreWidth: number;
  stageW: number;
  stageH: number;
  dateMin: string;
  dateMax: string;
}

// 装饰只有两类:plant(任一 INK_PLANTS 草木)与 birds(保留的飞鸟氛围)
type StageMomentKind = "plant" | "birds";
type StageMomentEdge = "top" | "bottom";
type SeasonalPlantId = "spring" | "summer" | "autumn" | "winter";

interface StageMomentPattern {
  kind: StageMomentKind;
  plantId?: string;
  edge: StageMomentEdge;
  layer: number;
  topPct: number;
  leftShift: number;
  triggerLead: number;
  w: number;
  h: number;
}

interface StageMoment {
  id: string;
  kind: StageMomentKind;
  plantId?: string;
  edge: StageMomentEdge;
  layer: number;
  left: number;
  topPct: number;
  triggerX: number;
  delayMs: number;
  w: number;
  h: number;
}

interface StageMomentSize {
  w: number;
  h: number;
}

interface StageRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function parseVb(vb: string): { w: number; h: number } {
  const p = vb.split(/\s+/).map(Number);
  return { w: p[2] || 260, h: p[3] || 180 };
}

// 装饰序列:上(垂枝)/下(生长)严格交替排布,保证沿长卷上下分布均匀;每 6 个插一次飞鸟。
function plantPattern(pl: InkPlant, idx: number): StageMomentPattern {
  const { w, h } = parseVb(pl.vb);
  return {
    kind: "plant",
    plantId: pl.id,
    edge: pl.edge,
    layer: 0,
    topPct: pl.edge === "top" ? 0 : 100,
    leftShift: ((idx % 4) - 1.5) * 50,
    triggerLead: 600,
    w,
    h,
  };
}

// 今日日期 → 稳定种子(年月日);每天换一组随机数,实现"每日轮换"
function dateToSeed(d: Date): number {
  return (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) >>> 0;
}

// 种子化洗牌(同一天稳定、不同天不同)
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rng = makeRng(seed >>> 0);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

// 按今日日期种子,把全部草木打乱后上(垂枝)/下(生长)严格交替排布:
// 既"每日轮换",又保持上下分布均匀(不连续一堆上/一堆下)。
function buildPlantPatterns(dateSeed: number): StageMomentPattern[] {
  const tops = seededShuffle(INK_PLANTS.filter((p) => p.edge === "top"), (dateSeed ^ 0x1357) >>> 0);
  const bottoms = seededShuffle(INK_PLANTS.filter((p) => p.edge === "bottom"), (dateSeed ^ 0x2468) >>> 0);
  const out: StageMomentPattern[] = [];
  const rounds = Math.max(tops.length, bottoms.length);
  let count = 0;
  for (let i = 0; i < rounds; i++) {
    const top = tops[i % tops.length];
    const bottom = bottoms[i % bottoms.length];
    if (top) out.push(plantPattern(top, count++));
    if (bottom) out.push(plantPattern(bottom, count++));
  }
  return out;
}

function getStageMomentSize(pattern: StageMomentPattern): StageMomentSize {
  if (pattern.kind === "birds") return { w: 440, h: 220 };
  return { w: pattern.w, h: pattern.h };
}

function getStageMomentBounds(
  pattern: StageMomentPattern,
  left: number,
  stageH: number,
): StageRect {
  const size = getStageMomentSize(pattern);
  const top = pattern.edge === "bottom" ? Math.max(0, stageH - size.h) : 0;
  return {
    left: left - size.w / 2,
    right: left + size.w / 2,
    top,
    bottom: top + size.h,
  };
}

function getStageMomentAvoidanceRect(
  pattern: StageMomentPattern,
  left: number,
  stageH: number,
): StageRect {
  const bounds = getStageMomentBounds(pattern, left, stageH);
  return expandStageRect(bounds, 150, 40);
}

function isAmbientStageMoment(kind: StageMomentKind): boolean {
  return kind === "birds";
}

function overlapsCard(
  bounds: StageRect,
  slot: PlacedSlot,
): boolean {
  const pad = 68;
  const cardLeft = slot.left - pad;
  const cardRight = slot.left + CARD_WIDTH + pad;
  const cardTop = slot.top - pad;
  const cardBottom = slot.top + slot.entry.height + pad;
  return (
    bounds.left < cardRight &&
    bounds.right > cardLeft &&
    bounds.top < cardBottom &&
    bounds.bottom > cardTop
  );
}

function getOverlapArea(
  a: StageRect,
  b: StageRect,
): number {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function getCardOverlapArea(
  bounds: StageRect,
  slot: PlacedSlot,
): number {
  const pad = 68;
  const left = Math.max(bounds.left, slot.left - pad);
  const right = Math.min(bounds.right, slot.left + CARD_WIDTH + pad);
  const top = Math.max(bounds.top, slot.top - pad);
  const bottom = Math.min(bounds.bottom, slot.top + slot.entry.height + pad);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function expandStageRect(rect: StageRect, xPad: number, yPad: number): StageRect {
  return {
    left: rect.left - xPad,
    right: rect.right + xPad,
    top: rect.top - yPad,
    bottom: rect.bottom + yPad,
  };
}

function findOpenStageMomentLeft(
  pattern: StageMomentPattern,
  desiredLeft: number,
  stageW: number,
  stageH: number,
  slots: PlacedSlot[],
  occupiedRects: StageRect[],
  options: { minLeft?: number; preferRight?: boolean } = {},
): number {
  const size = getStageMomentSize(pattern);
  const baseMinLeft = size.w / 2 + 24;
  const minLeft = Math.max(baseMinLeft, options.minLeft ?? baseMinLeft);
  const maxLeft = Math.max(minLeft, stageW - size.w / 2 - 24);
  if (isAmbientStageMoment(pattern.kind)) {
    return clamp(desiredLeft, minLeft, maxLeft);
  }
  const offsets = [0];
  const maxScan = Math.min(2600, Math.max(900, stageW * 0.45));
  for (let distance = 120; distance <= maxScan; distance += 120) {
    if (options.preferRight) {
      offsets.push(distance, -distance);
    } else {
      offsets.push(-distance, distance);
    }
  }
  let best = clamp(desiredLeft, minLeft, maxLeft);
  let bestScore = -Infinity;

  for (const offset of offsets) {
    const left = clamp(desiredLeft + offset, minLeft, maxLeft);
    const bounds = getStageMomentAvoidanceRect(pattern, left, stageH);
    const collisions = slots.filter((slot) => overlapsCard(bounds, slot)).length;
    const overlapArea = slots.reduce((sum, slot) => sum + getCardOverlapArea(bounds, slot), 0);
    const occupiedArea = occupiedRects.reduce((sum, rect) => sum + getOverlapArea(bounds, rect), 0);
    const occupiedCollisions = occupiedRects.filter((rect) => getOverlapArea(bounds, rect) > 0).length;
    const distancePenalty = Math.abs(left - desiredLeft) / 1200;
    const edgePenalty =
      pattern.edge === "bottom"
        ? slots.reduce((sum, slot) => {
            const dx = Math.max(0, Math.abs(slot.left + CARD_WIDTH / 2 - left) - CARD_WIDTH / 2);
            const verticalNear = Math.max(0, slot.top + slot.entry.height + 92 - bounds.top);
            return sum + Math.max(0, 140 - dx) * verticalNear;
          }, 0) / 1200
        : 0;
    const score =
      -collisions * 100 -
      occupiedCollisions * 80 -
      overlapArea / 900 -
      occupiedArea / 1100 -
      edgePenalty -
      distancePenalty;
    if (collisions === 0 && occupiedCollisions === 0) return left;
    if (score > bestScore) {
      best = left;
      bestScore = score;
    }
  }

  return best;
}

function buildStageMoments(
  stageW: number,
  stageH: number,
  viewportW: number,
  slots: PlacedSlot[],
  dateSeed: number,
  initialOccupiedRects: StageRect[] = [],
): StageMoment[] {
  if (stageW <= 0) return [];
  const safeViewportW = Math.max(720, viewportW || 0);
  const step = 760;
  const startX = clamp(safeViewportW * 1.12, 760, Math.max(760, stageW - 220));
  const endX = Math.max(startX, stageW - 180);
  const moments: StageMoment[] = [];
  const occupiedRects = [...initialOccupiedRects];
  // 每日轮换:按今日日期种子重排草木序列(仍上下交替均匀)
  const patterns = buildPlantPatterns(dateSeed);
  const fallbackPattern = patterns[0]!;
  if (!patterns.length) return moments;
  for (let x = startX, i = 0; x <= endX && i < 60; x += step + (i % 3) * 90, i++) {
    const pattern = patterns[i % patterns.length] ?? fallbackPattern;
    const desiredLeft = clamp(x + pattern.leftShift, 160, Math.max(160, stageW - 160));
    const left = findOpenStageMomentLeft(pattern, desiredLeft, stageW, stageH, slots, occupiedRects, {
      minLeft: Math.max(safeViewportW * 1.05, desiredLeft - 420),
      preferRight: true,
    });
    const triggerLead = Math.min(pattern.triggerLead, safeViewportW * 0.62);
    const maxTriggerX = Math.max(70, stageW - safeViewportW + 260);
    moments.push({
      id: `stage-moment-${i}-${pattern.plantId ?? pattern.kind}`,
      kind: pattern.kind,
      plantId: pattern.plantId,
      edge: pattern.edge,
      layer: pattern.layer,
      left,
      topPct: pattern.edge === "top" ? 0 : pattern.edge === "bottom" ? 100 : pattern.topPct,
      triggerX: clamp(left - triggerLead, 70, maxTriggerX),
      delayMs: (i % 3) * 90,
      w: pattern.w,
      h: pattern.h,
    });
    if (!isAmbientStageMoment(pattern.kind)) {
      occupiedRects.push(getStageMomentAvoidanceRect(pattern, left, stageH));
    }
  }

  // 飞鸟:疏朗地撒在长卷中后段(约十几二十篇文档之后才出现),飘在画面上方(层 3)。
  // 起点靠后、间距较大;飞鸟是氛围层、不占位、不与卡片/草木碰撞,单独等距铺设。
  const birdMaxTriggerX = Math.max(70, stageW - safeViewportW + 260);
  for (let bx = 5200, bi = 0; bx <= endX && bi < 24; bx += 2800, bi++) {
    const left = clamp(bx + (bi % 2 ? 120 : -120), 200, Math.max(200, stageW - 220));
    moments.push({
      id: `stage-birds-${bi}`,
      kind: "birds",
      edge: "top",
      layer: 3,
      left,
      topPct: 12 + (bi % 3) * 9,
      triggerX: clamp(left - 620, 70, birdMaxTriggerX),
      delayMs: 0,
      w: 440,
      h: 220,
    });
  }
  return moments;
}

function getCardLayer(globalIdx: number, col: number, kind: CardEntry["kind"]): number {
  if (kind === "new") return 2;
  return (globalIdx + col) % 4 === 0 ? 2 : 1;
}

function getCardZIndex(layer: number): number {
  return 20 + layer * 20;
}

function getStageMomentZIndex(layer: number): number {
  if (layer <= 0) return 10;
  return getCardZIndex(layer) + 10;
}

function getSeasonalPlant(date: Date): SeasonalPlantId {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}
// 用水墨笔法生成器渲染的装饰种类(变宽毛笔笔触 + 没骨花叶,见 inkBrush.ts)。
// viewBox 与各 kind 的尺寸一致;生成器按 moment.id 种子化,保证渲染稳定。
const PLANT_BY_ID = new Map<string, InkPlant>(INK_PLANTS.map((p) => [p.id, p]));

// 一处水墨草木:把生成的墨元素逐一渲染为 <path>,入场 + 一次性动效由 CSS(.qj-fired + .qj-ink-*/.qj-m-*)驱动。
function InkMomentArt({ moment, plant }: { moment: StageMoment; plant: InkPlant }) {
  const els = useMemo(() => decorateMotion(plant.gen(hashSeed(moment.id))), [plant, moment.id]);
  // 根部锚点:摇摆以此为支点(贴近树干/基部,不再像跷跷板从中间晃)
  const fallbackAnchor: [number, number] = moment.edge === "top" ? [0.14, 0.02] : [0.5, 1];
  const anchor = plant.anchor ?? fallbackAnchor;
  // 约一半的株做水平翻转,让枝条有左有右(确定性:按 id)
  const flip = hashSeed(`${moment.id}~flip`) % 2 === 1;
  const originStyle = {
    transformOrigin: `${(anchor[0] * 100).toFixed(1)}% ${(anchor[1] * 100).toFixed(1)}%`,
  } as CSSProperties;
  return (
    <svg className="qj-moment-art" viewBox={plant.vb} aria-hidden="true" focusable="false">
      {/* 外层 flip 组只做静态左右翻转(方向变化);内层 body 组以根部锚点为支点整株轻摆 */}
      <g
        className="qj-plant-flip"
        style={
          flip
            ? ({ transform: "scaleX(-1)", transformBox: "fill-box", transformOrigin: "50% 50%" } as CSSProperties)
            : undefined
        }
      >
        <g className={`qj-plant-body qj-plant-body-${moment.edge}`} style={originStyle}>
          {els.map((el, i) => (
            <path
              key={i}
              d={el.d}
              fill={el.fill}
              className={`qj-ink qj-ink-${el.reveal}${el.motion ? ` qj-m-${el.motion}` : ""}`}
              style={{ ["--qj-ink-d" as string]: `${el.delay}ms`, ...(el.vars ?? {}) } as CSSProperties}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}

function QingjianStageMoment({ moment }: { moment: StageMoment }) {
  const momentClassName = `qj-stage-moment qj-stage-moment-${moment.kind} qj-stage-moment-edge-${moment.edge}`;
  const style = {
    left: `${moment.left}px`,
    top: `${moment.topPct}%`,
    zIndex: getStageMomentZIndex(moment.layer),
    ["--qj-moment-delay" as string]: `${moment.delayMs}ms`,
  } as CSSProperties;

  if (moment.kind === "plant") {
    const plant = moment.plantId ? PLANT_BY_ID.get(moment.plantId) : undefined;
    if (plant) {
      return (
        <div
          className={momentClassName}
          data-trigger-x={moment.triggerX}
          data-edge={moment.edge}
          data-layer={moment.layer}
          style={{ ...style, width: `${moment.w}px`, height: `${moment.h}px` }}
          aria-hidden="true"
        >
          <InkMomentArt moment={moment} plant={plant} />
        </div>
      );
    }
  }

  // 飞鸟氛围:水墨群鸟自下而上飞入、展翅、飞完消失;层级最高,飞在卡片之上不被遮挡
  return (
    <div
      className={momentClassName}
      data-trigger-x={moment.triggerX}
      data-edge={moment.edge}
      data-layer={moment.layer}
      style={{ ...style, zIndex: 130 }}
      aria-hidden="true"
    >
      <BirdsMomentArt moment={moment} />
    </div>
  );
}

// 远飞群鸟:整群自下而上飞入、各鸟绕关节展翅扇动、飞完淡出消失(进入视野触发一次,可重播)
function BirdsMomentArt({ moment }: { moment: StageMoment }) {
  const flock = useMemo(() => buildFlock(hashSeed(moment.id)), [moment.id]);
  return (
    <svg className="qj-moment-art" viewBox="0 0 440 220" aria-hidden="true" focusable="false">
      <g className="qj-birds-flock">
        {flock.map((b, i) => (
          <g
            key={i}
            transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) scale(${b.s.toFixed(2)})`}
            style={{ ["--qj-flap-d" as string]: `${b.flapDelay}ms` } as CSSProperties}
          >
            <path className="qj-bird-wing qj-bird-wing-l" d={BIRD_WING_L} fill={b.fill} />
            <path className="qj-bird-wing qj-bird-wing-r" d={BIRD_WING_R} fill={b.fill} />
          </g>
        ))}
      </g>
    </svg>
  );
}

// 右侧竖排诗句轮播:三首含"青简"的诗,每隔几秒淡入淡出自动换;每次启动随机起一首。
const QJ_SIDE_VERSES = [
  "谁看青简一编书，不遣花虫粉空蠹",
  "厌从薄宦校青简，悔别故山思白云",
  "但吟诗句留青简，不与人间看白头",
];

function QingjianSideVerse() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * QJ_SIDE_VERSES.length));
  const [show, setShow] = useState(true);
  useEffect(() => {
    const SWITCH_MS = 7000;
    const FADE_MS = 600;
    const timer = window.setInterval(() => {
      setShow(false);
      window.setTimeout(() => {
        setIdx((i) => (i + 1) % QJ_SIDE_VERSES.length);
        setShow(true);
      }, FADE_MS);
    }, SWITCH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="qj-fp-side">
      <span className={`qj-fp-verse${show ? " qj-fp-verse-in" : ""}`}>{QJ_SIDE_VERSES[idx]}</span>
    </div>
  );
}

function formatPreviewDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day}`;
}

function countPreviewChars(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

// ---------------------------------------------------------------------------
// 新建卡的两张程序化噪点纹理(canvas → dataURL),整组件只生成一次
// ---------------------------------------------------------------------------

let cachedNoise: string | null = null;
let cachedInkTex: string | null = null;

function nkHash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function nkNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = nkHash(xi, yi);
  const b = nkHash(xi + 1, yi);
  const c = nkHash(xi, yi + 1);
  const d = nkHash(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function nkFbm(x: number, y: number): number {
  let s = 0;
  let amp = 0.5;
  for (let i = 0; i < 4; i++) {
    s += amp * nkNoise(x, y);
    x *= 2;
    y *= 2;
    amp *= 0.5;
  }
  return s;
}

function buildNewCardTextures(): { noise: string; inkTex: string } {
  if (cachedNoise && cachedInkTex) {
    return { noise: cachedNoise, inkTex: cachedInkTex };
  }
  // 颗粒噪点(同 V9)
  const s1 = 200;
  const cv1 = document.createElement("canvas");
  cv1.width = cv1.height = s1;
  const c1 = cv1.getContext("2d");
  let noise = "";
  if (c1) {
    const img = c1.createImageData(s1, s1);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() * 22) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
      img.data[i + 3] = (Math.random() * 16) | 0;
    }
    c1.putImageData(img, 0, 0);
    noise = `url(${cv1.toDataURL()})`;
  }
  // 文字水墨底纹(fbm 墨色浓淡 + 飞白)
  const s2 = 180;
  const cv2 = document.createElement("canvas");
  cv2.width = cv2.height = s2;
  const c2 = cv2.getContext("2d");
  let inkTex = "";
  if (c2) {
    const img = c2.createImageData(s2, s2);
    for (let y = 0; y < s2; y++) {
      for (let x = 0; x < s2; x++) {
        const v = nkFbm(x * 0.045 + 2.0, y * 0.045 + 7.0);
        const m = Math.min(1, Math.max(0, v * 1.25));
        const i = (y * s2 + x) * 4;
        img.data[i] = 30 + m * 34;
        img.data[i + 1] = 25 + m * 28;
        img.data[i + 2] = 16 + m * 20;
        img.data[i + 3] = 255 * Math.min(1, Math.max(0.55, 0.72 + (v - 0.5) * 0.9));
      }
    }
    c2.putImageData(img, 0, 0);
    inkTex = `url(${cv2.toDataURL()})`;
  }
  cachedNoise = noise;
  cachedInkTex = inkTex;
  return { noise, inkTex };
}

// ---------------------------------------------------------------------------
// 布局算法(移植 demo build():列模式 [3,2,3] + 每列错落绝对定位)
// ---------------------------------------------------------------------------

function buildLayout(
  entries: CardEntry[],
  containerH: number,
  containerW: number,
  currentSeason: SeasonalPlantId,
  dateSeed: number,
): BuiltLayout {
  const stageH = containerH - MAT_PAD * 2;
  const usableH = Math.max(120, stageH - PAD_TOP - PAD_BOT);

  // 当季首株:按当前中国季节 + 今日日期种子,从当季草木里挑一株(每日轮换)。
  // 它固定挂在第一列「新建文档」卡的上方或下方(由其自身 edge 决定),卡的位置据此反向避让。
  const seasonPlants = INK_PLANTS.filter((p) => p.season === currentSeason);
  const seasonFirst = seasonPlants.length
    ? seasonPlants[Math.floor(makeRng((dateSeed ^ 0x5eed) >>> 0)() * seasonPlants.length)]!
    : null;

  // 分列
  interface ColSlot {
    entry: CardEntry;
    globalIdx: number;
    col: number;
  }
  const colSlots: ColSlot[] = [];

  // —— 新建卡特判:独占第 0 列、固定 left/top,绝不进入下面的随机列分布 ——
  // 这样它在任意 session 数据、任意挂载/返回下都恒定在同一位置(根治返回位置漂移)。
  const newEntry = entries.find((e) => e.kind === "new");
  const newGlobalIdx = newEntry ? entries.indexOf(newEntry) : -1;
  const newColReserved = newEntry ? 1 : 0;

  // 真实卡从第 1 列起排(把新建卡从待排序列剔除)
  const realForLayout = entries.filter((e) => e.kind !== "new");

  let i = 0;
  let col = newColReserved; // 0 号列预留给新建卡
  let pIdx = 0;
  while (i < realForLayout.length) {
    const per = COLUMN_PATTERN[pIdx % COLUMN_PATTERN.length] ?? 3;
    const colCards = realForLayout.slice(i, i + per);
    const sumH = () => colCards.reduce((s, c) => s + c.height, 0);
    while (colCards.length > 1 && sumH() + (colCards.length - 1) * 22 > usableH) {
      colCards.pop();
    }
    colCards.forEach((c) => {
      colSlots.push({ entry: c, globalIdx: entries.indexOf(c), col });
    });
    i += colCards.length;
    col++;
    pIdx++;
  }
  const totalCols = col;

  const colX = (c: number) => PAD_LEFT + c * (CARD_WIDTH + GAP_X);
  const naturalStageW = PAD_LEFT + totalCols * (CARD_WIDTH + GAP_X) - GAP_X + PAD_RIGHT;
  const minCoreWidth = Math.max(0, containerW - SCROLL_FIXED_WIDTH - SCROLL_RIGHT_GAP);
  // 长卷宽度只取「内容宽 / 窗口可视宽」较大者:内容少/空画布时正好铺满当前窗口、不再横向拉长;
  // 当季草木等装饰只在这个宽度内分布,不再为铺开整排草木而把空画布额外撑长。
  const coreWidth = Math.max(naturalStageW + MAT_PAD * 2, minCoreWidth);
  const stageW = coreWidth - MAT_PAD * 2;

  // 按列分组,列内按权重错落分布
  const byCol = new Map<number, ColSlot[]>();
  colSlots.forEach((s) => {
    const list = byCol.get(s.col) ?? [];
    list.push(s);
    byCol.set(s.col, list);
  });

  const placed: PlacedSlot[] = [];

  // 新建卡:固定 left/top(画心垂直居中),确定且与 session 数据无关。
  if (newEntry) {
    const freeY = Math.max(0, usableH - NEW_CARD_H);
    // 当季首株在上(垂枝)→ 卡放下半部、留出上方空白;在下(生长)→ 卡放上半部、留出下方空白
    const newCardTopRatio = seasonFirst ? (seasonFirst.edge === "top" ? 0.66 : 0.3) : 0.5;
    const newTop = clamp(PAD_TOP + freeY * newCardTopRatio, PAD_TOP, PAD_TOP + freeY);
    placed.push({
      entry: newEntry,
      globalIdx: newGlobalIdx,
      col: 0,
      left: NEW_CARD_LEFT,
      top: newTop,
      layer: getCardLayer(newGlobalIdx, 0, newEntry.kind),
      // 进场动画:用固定值,不随机(保证视觉确定)
      enterX: -30,
      enterY: 0,
      enterRot: 0,
    });
  }

  byCol.forEach((list, c) => {
    const heights = list.map((s) => s.entry.height);
    const totalH = heights.reduce((a, b) => a + b, 0);
    const slack = Math.max(0, usableH - totalH);
    const n = list.length;
    const seed = (c * 2654435761) >>> 0;
    const rnd = (k: number) => {
      let x = (seed ^ (k * 40503)) >>> 0;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5;
      x >>>= 0;
      return (x % 1000) / 1000;
    };
    const w: number[] = [];
    let wsum = 0;
    for (let k = 0; k <= n; k++) {
      const v = 0.6 + rnd(k) * 0.9;
      w.push(v);
      wsum += v;
    }
    list.forEach((s, k) => {
      const y =
        PAD_TOP +
        slack * (w.slice(0, k + 1).reduce((a, b) => a + b, 0) / wsum) +
        heights.slice(0, k).reduce((a, b) => a + b, 0);
      const jitterX = (rnd(k + 7) - 0.5) * 7;
      const enterX = -1 * (18 + rnd(k + 11) * 26);
      const enterY = (rnd(k + 13) - 0.5) * 40;
      const enterRot = (rnd(k + 17) - 0.5) * 14;
      placed.push({
        entry: s.entry,
        globalIdx: s.globalIdx,
        col: c,
        left: colX(c) + jitterX,
        top: y,
        layer: getCardLayer(s.globalIdx, c, s.entry.kind),
        enterX,
        enterY,
        enterRot,
      });
    });
  });

  const realEntries = entries.filter((e) => e.kind === "real");
  const dateMin = realEntries[0]?.date ?? "";
  const dateMax = realEntries[realEntries.length - 1]?.date ?? "";
  const stageOccupiedRects: StageRect[] = [];
  const preludeStageMoments: StageMoment[] = [];
  // 第一列「新建文档」卡上下固定放当季首株(seasonFirst,已在上方按今日种子选定)
  {
    if (seasonFirst) {
      const pick = seasonFirst;
      const { w, h } = parseVb(pick.vb);
      const firstPattern: StageMomentPattern = {
        kind: "plant",
        plantId: pick.id,
        edge: pick.edge,
        layer: 0,
        topPct: pick.edge === "top" ? 0 : 100,
        leftShift: 0,
        triggerLead: 520,
        w,
        h,
      };
      // 固定在新建卡所在的第一列(其上方/下方空白处)
      const left = clamp(NEW_CARD_LEFT + CARD_WIDTH / 2, w / 2 + 10, Math.max(w / 2 + 10, stageW - w / 2 - 10));
      preludeStageMoments.push({
        id: "stage-moment-season-first",
        kind: "plant",
        plantId: pick.id,
        edge: pick.edge,
        layer: 0,
        left,
        topPct: pick.edge === "top" ? 0 : 100,
        triggerX: 70,
        delayMs: 0,
        w,
        h,
      });
      stageOccupiedRects.push(getStageMomentAvoidanceRect(firstPattern, left, stageH));
    }
  }
  if (realEntries.length === 0) {
    // 空画布也先来一群飞鸟(保留的氛围),草木由主序列补上
    const emptyCanvasPatterns: StageMomentPattern[] = [
      { kind: "birds", edge: "top", layer: 3, topPct: 28, leftShift: 0, triggerLead: 430, w: 440, h: 220 },
    ];
    emptyCanvasPatterns.forEach((pattern, index) => {
      const safeViewportW = Math.max(720, containerW || 0);
      const left = clamp(safeViewportW * 0.2, 220, Math.max(220, stageW - 220));
      preludeStageMoments.push({
        id: `stage-moment-empty-${pattern.kind}`,
        kind: pattern.kind,
        plantId: pattern.plantId,
        edge: pattern.edge,
        layer: pattern.layer,
        left,
        topPct: pattern.topPct,
        triggerX: 70 + index * 80,
        delayMs: 120 + index * 180,
        w: pattern.w,
        h: pattern.h,
      });
      if (!isAmbientStageMoment(pattern.kind)) {
        stageOccupiedRects.push(getStageMomentAvoidanceRect(pattern, left, stageH));
      }
    });
  }
  const stageMoments = [
    ...preludeStageMoments,
    ...buildStageMoments(stageW, stageH, containerW, placed, dateSeed, stageOccupiedRects),
  ];

  return { slots: placed, stageMoments, coreWidth, stageW, stageH, dateMin, dateMax };
}

const SearchIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
);

const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export function QingjianScroll({
  sessions,
  onOpenSession,
  onNewSession,
  onOpenShelf,
  cleanMode = false,
  openApiRef,
}: QingjianScrollProps) {
  // —— 持久化设置(主题 / 进场 / 减少动效)——
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const v = localStorage.getItem(STORE_THEME_MODE);
      if (v && (THEME_MODES as readonly string[]).includes(v)) return v as ThemeMode;
      // 迁移旧版四色配色:宣纸→白天,其余暗色→深夜
      const legacy = localStorage.getItem(STORE_THEME_LEGACY);
      if (legacy === "paper") return "light";
      if (legacy) return "dark";
    } catch {
      /* ignore */
    }
    // themeMode 已无实际作用:resolveTheme 恒返回 paper(产品只保留浅色宣纸、无深/浅模式)。
    // 保留该状态仅为兼容旧存储,不影响渲染。
    return "light";
  });
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    } catch {
      return false;
    }
  });
  const theme: ThemeId = resolveTheme(themeMode, systemDark);
  const [anim, setAnim] = useState<AnimId>(() => {
    try {
      const v = localStorage.getItem(STORE_ANIM);
      if (v && (ANIMS as readonly string[]).includes(v)) return v as AnimId;
    } catch {
      /* ignore */
    }
    return "fly";
  });
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORE_REDUCE) === "1";
    } catch {
      return false;
    }
  });
  const [primaryFont, setPrimaryFont] = useState<FontId>(() => readFontPref(STORE_FONT_PRIMARY));
  const [secondaryFont, setSecondaryFont] = useState<FontId>(() => readFontPref(STORE_FONT_SECONDARY));
  // 全部设置统一从首页 ⚙ 打开弹框,不再保留右上角二级浮层。
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsSheetTab>("model");
  // 从编辑/新建页「去配置」返回:消费信号 → 略等返回转场落定后打开设置(默认第一个 tab=模型)。
  useEffect(() => {
    const target = readOpenSettingsFlag();
    if (!target) return;
    const t = window.setTimeout(() => {
      setSettingsInitialTab(target);
      setSettingsSheetOpen(true);
      clearOpenSettingsFlag();
    }, 650);
    return () => window.clearTimeout(t);
  }, []);
  const [inkDebugOpen, setInkDebugOpen] = useState(false);
  const [openingScroll, setOpeningScroll] = useState(() => shouldPlayOpeningScroll());
  const [settingsInkVariant, setSettingsInkVariant] = useState<SettingsInkVariantId>(() => {
    try {
      const v = localStorage.getItem(STORE_SETTINGS_INK);
      if (v && (SETTINGS_INK_VARIANTS as readonly string[]).includes(v)) {
        return v as SettingsInkVariantId;
      }
    } catch {
      /* ignore */
    }
    return "coalesce";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 进度条 hover 预览小卡:命中的卡片索引 + 水平定位(相对 dock 容器左侧)
  const [preview, setPreview] = useState<{ idx: number; left: number } | null>(null);

  useEffect(() => {
    if (!openingScroll) return;
    const markPlayedTimer = window.setTimeout(() => {
      markOpeningScrollPlayed();
    }, 120);
    const finishTimer = window.setTimeout(() => setOpeningScroll(false), 2850);
    return () => {
      window.clearTimeout(markPlayedTimer);
      window.clearTimeout(finishTimer);
    };
  }, [openingScroll]);

  useEffect(() => {
    const replayOpeningFromHash = () => {
      const routeMode = getOpeningRouteMode();
      if (!routeMode.isHome || !routeMode.forceReplay) return;
      hasPlayedOpeningScroll = false;
      setOpeningScroll(false);
      window.requestAnimationFrame(() => setOpeningScroll(shouldPlayOpeningScroll()));
    };
    window.addEventListener("hashchange", replayOpeningFromHash);
    return () => window.removeEventListener("hashchange", replayOpeningFromHash);
  }, []);

  const textures = useMemo(() => buildNewCardTextures(), []);

  // —— 把 sessions 转为时间升序的卡片序列(新建卡置首)——
  const entries = useMemo<CardEntry[]>(() => {
    const registry = createDefaultRegistry();
    const selectorOptions: SelectorOptions = {
      allowFallback: true,
      templateFilter: qingagentTemplateFilter,
    };
    // 模板预览模式(URL 带 ?mock):暂时关掉打分/过滤算法,改为按注册表顺序轮流取"全部"模板,
    // 方便把所有模板挨个看一遍;只在 mock 预览下生效,不影响真实首页的选择逻辑。
    const reviewAll = /[?&]mock=/.test(window.location.href);
    return buildHomeCardEntries({
      sessions,
      registry,
      selectorOptions,
      reviewAll,
      newCardHeight: NEW_CARD_H,
    });
  }, [sessions]);

  // —— 容器高度(用于布局);随容器尺寸更新 ——
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockProgRef = useRef<HTMLDivElement>(null);
  const dockFillRef = useRef<HTMLDivElement>(null);
  const dockCursorRef = useRef<HTMLDivElement>(null);
  const newFabRef = useRef<HTMLButtonElement>(null);

  // 方案4:首页核心动效舞台(墨水 + 卡飞 + 背景变深)。整页生命周期内复用一份。
  const txStageRef = useRef<HomeTransitionStage | null>(null);
  // 正在跑「进场核心动效」标记:屏蔽期间的重复点击 / 滚动触发。
  const transitioningRef = useRef(false);
  const initialHomeViewXRef = useRef<number | null>(null);

  const [containerH, setContainerH] = useState(0);
  const [containerW, setContainerW] = useState(0);

  const replayVisibleCards = useCallback(() => {
    const stage = stageRef.current;
    const scroller = scrollRef.current;
    if (!stage || !scroller) return;

    const slots = Array.from(stage.querySelectorAll<HTMLElement>(".qj-card-slot"));
    slots.forEach((slot) => {
      slot.style.transition = "none";
      slot.classList.remove("qj-in");
      slot.style.transitionDelay = "0ms";
    });
    void stage.offsetWidth;
    slots.forEach((slot) => {
      slot.style.transition = "";
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scRect = scroller.getBoundingClientRect();
        const vw = scroller.clientWidth;
        let seq = 0;
        slots.forEach((slot) => {
          const rect = slot.getBoundingClientRect();
          const x = rect.left - scRect.left;
          if (x < vw + 240 && x > -CARD_WIDTH - 240) {
            const delay = Math.min(seq, 7) * 70;
            seq++;
            slot.style.transitionDelay = `${delay}ms`;
            slot.classList.add("qj-in");
          }
        });
      });
    });
  }, []);

  // useLayoutEffect:首帧 paint 前就量到真实容器宽高,避免画心宽度先按 0 渲染再跳一次
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => {
      setContainerH(node.clientHeight);
      setContainerW(node.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // 新建卡的「确定化屏幕 rect」:从槽位固定 left/top(stage 坐标)+ stage 屏幕偏移推算,
  // 剔除 .qj-sway 旋转/hover 抬升 → 进场起点 = 返回落点,完全一致(像素级对齐)。
  const computeNewCardScreenRect = useCallback((): {
    rect: { left: number; top: number; width: number; height: number };
    centerX: number;
    centerY: number;
  } | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const newSlotEl = stage.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]');
    if (!newSlotEl) return null;
    const stageRect = stage.getBoundingClientRect();
    const slotLeft = parseFloat(newSlotEl.style.left) || 0;
    const slotTop = parseFloat(newSlotEl.style.top) || 0;
    const left = stageRect.left + slotLeft;
    const top = stageRect.top + slotTop;
    return {
      rect: { left, top, width: CARD_WIDTH, height: NEW_CARD_H },
      centerX: left + CARD_WIDTH / 2,
      centerY: top + NEW_CARD_H / 2,
    };
  }, []);

  const findArticleSlot = useCallback((sessionId: string): HTMLElement | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const slots = Array.from(stage.querySelectorAll<HTMLElement>('.qj-card-slot[data-kind="real"]'));
    return slots.find((slot) => slot.dataset.id === sessionId) ?? null;
  }, []);

  const computeArticleCardScreenRect = useCallback((sessionId: string): {
    rect: { left: number; top: number; width: number; height: number };
    centerX: number;
    centerY: number;
  } | null => {
    const slot = findArticleSlot(sessionId);
    if (!slot) return null;
    const card = slot.querySelector<HTMLElement>(".cm-card") ?? slot.querySelector<HTMLElement>(".qj-sway");
    const measured = (card ?? slot).getBoundingClientRect();
    const width = measured.width || CARD_WIDTH;
    const height = measured.height || 360;
    const left = measured.left;
    const top = measured.top;
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) {
      return null;
    }
    return {
      rect: { left, top, width, height },
      centerX: left + width / 2,
      centerY: top + height / 2,
    };
  }, [findArticleSlot]);

  const computeArticleHomeViewX = useCallback((sessionId: string): number | null => {
    const scroller = scrollRef.current;
    const inner = innerRef.current;
    const stage = stageRef.current;
    const core = coreRef.current;
    const slot = findArticleSlot(sessionId);
    if (!scroller || !inner || !stage || !core || !slot) return null;
    const maxX = Math.max(0, inner.scrollWidth - scroller.clientWidth);
    const stageStartX = core.offsetLeft + stage.offsetLeft;
    const slotLeft = parseFloat(slot.style.left) || 0;
    const cardCenter = stageStartX + slotLeft + CARD_WIDTH / 2;
    return clamp(cardCenter - scroller.clientWidth / 2, 0, maxX);
  }, [findArticleSlot]);

  // —— 方案4:首页核心动效舞台 + 返回到达态编排 ——
  // 舞台整页生命周期内复用一份;返回到达态在首页挂载后跑反向核心动效再淡回内容。
  // ⚠️ 用 useLayoutEffect:返回到达态(snapArrived 置深背景 + 卡静停 + 隐藏内容)必须在
  //    **首帧 paint 前**完成,否则会先闪一帧浅色首页(漏白),再被置深 → 切换瞬间闪。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const stage = createHomeTransitionStage(root);
    txStageRef.current = stage;

    // 若是从新建页「返回」过来:首页挂载即到达态(卡在落点 + 背景已深),
    // 跑反向核心动效(卡飞回新建卡固定位 + 墨退回宣纸),再淡回首页内容。
    // peek 语义:不在此清除(防 StrictMode 第一次被丢弃的挂载误消费),
    // 待反向动效真正启动(下方 rAF 内)再 clearHomeArrive。
    const arrive = peekHomeArrive();
    let cancelled = false;
    if (arrive) {
      root.classList.add("qj-arriving");
      if (arrive.source === "workspace" && arrive.sessionId) {
        const viewX = computeArticleHomeViewX(arrive.sessionId);
        const inner = innerRef.current;
        if (viewX !== null && inner) {
          initialHomeViewXRef.current = viewX;
          inner.style.transform = `translate3d(${(-viewX).toFixed(2)}px,0,0)`;
        }
      }
      // 首帧(paint 前):卡静停在「离开新建页时的顶层卡 rect」,背景瞬时已深(零入场动画)
      stage.snapArrived(arrive.rect);
      // 等布局稳定(新建卡槽位就位)再算反向落点 → 飞回 + 墨退
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          clearHomeArrive(); // 动效已启动,此刻消费到达态(避开 StrictMode 误清)
          const dest =
            arrive.source === "workspace" && arrive.sessionId
              ? computeArticleCardScreenRect(arrive.sessionId)
              : computeNewCardScreenRect();
          const to = dest
            ? dest.rect
            : { left: NEW_CARD_LEFT, top: window.innerHeight / 2 - NEW_CARD_H / 2, width: CARD_WIDTH, height: NEW_CARD_H };
          const inkOrigin = dest
            ? { x: dest.centerX, y: dest.centerY }
            : { x: to.left + CARD_WIDTH / 2, y: to.top + NEW_CARD_H / 2 };
          stage
            // 新建页返回保留形变动效;文档编辑页返回只淡出(animate=false)
            .playReturn(arrive.rect, to, inkOrigin, arrive.source !== "workspace")
            .then(() => {
              if (cancelled) return;
              // 反向核心动效到达正常首页静止帧:淡回内容,settle。
              root.classList.remove("qj-arriving");
              root.classList.add("qj-content-fadein");
              window.setTimeout(() => {
                if (!cancelled) root.classList.remove("qj-content-fadein");
              }, 800);
            });
        });
      });
    }

    return () => {
      cancelled = true;
      stage.dispose();
      txStageRef.current = null;
      root.classList.remove("qj-arriving", "qj-content-fadein", "qj-transitioning");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 搜索有内容时:命中卡前置(最左),未命中卡后置(最右,仍半透明显示)。
  // 重排会触发重新布局 → 滚动 effect 重置 viewX=0,自动滚到最左。
  const orderedEntries = useMemo<CardEntry[]>(() => {
    const kw = searchQuery.trim().toLowerCase();
    if (!kw) return entries;
    const specials: CardEntry[] = [];
    const matched: CardEntry[] = [];
    const unmatched: CardEntry[] = [];
    for (const e of entries) {
      if (e.kind !== "real") {
        specials.push(e);
        continue;
      }
      const hit = e.title.toLowerCase().includes(kw) || e.category.toLowerCase().includes(kw);
      (hit ? matched : unmatched).push(e);
    }
    return [...specials, ...matched, ...unmatched];
  }, [entries, searchQuery]);

  const currentSeason = useMemo(() => getSeasonalPlant(new Date()), []);
  // 今日日期种子:同一天稳定、每天轮换(草木序列与当季首株都用它)
  const dateSeed = useMemo(() => dateToSeed(new Date()), []);
  const layout = useMemo<BuiltLayout>(
    () => buildLayout(orderedEntries, containerH || 600, containerW || 0, currentSeason, dateSeed),
    [orderedEntries, containerH, containerW, currentSeason, dateSeed],
  );

  // —— 把布局尺寸写到 silkcore 宽度 ——
  useEffect(() => {
    if (coreRef.current) coreRef.current.style.width = `${layout.coreWidth}px`;
  }, [layout.coreWidth]);

  // —— 持久化 ——
  useEffect(() => {
    try {
      localStorage.setItem(STORE_THEME_MODE, themeMode);
    } catch {
      /* ignore */
    }
  }, [themeMode]);
  // 跟随系统:监听操作系统明暗偏好变化(仅 themeMode==="system" 时影响实际配色)
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return undefined;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_ANIM, anim);
    } catch {
      /* ignore */
    }
  }, [anim]);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_REDUCE, reduceMotion ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [reduceMotion]);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_SETTINGS_INK, settingsInkVariant);
    } catch {
      /* ignore */
    }
  }, [settingsInkVariant]);
  // —— 字体:持久化 + 写入 CSS 变量(主字体=标题/界面,辅助字体=正文/说明)——
  useEffect(() => {
    try {
      localStorage.setItem(STORE_FONT_PRIMARY, primaryFont);
      localStorage.setItem(STORE_FONT_SECONDARY, secondaryFont);
    } catch {
      /* ignore */
    }
    const el = rootRef.current;
    if (el) {
      el.style.setProperty("--qj-font-primary", FONT_STACK[primaryFont]);
      el.style.setProperty("--qj-font-secondary", FONT_STACK[secondaryFont]);
    }
  }, [primaryFont, secondaryFont]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setInkDebugOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // —— 搜索过滤:对 slot 加/去 .qj-dimmed ——
  const matchedCount = useMemo(() => {
    const kw = searchQuery.trim().toLowerCase();
    if (!kw) return 0;
    return layout.slots.filter((s) => {
      if (s.entry.kind !== "real") return false;
      return (
        s.entry.title.toLowerCase().includes(kw) ||
        s.entry.category.toLowerCase().includes(kw)
      );
    }).length;
  }, [searchQuery, layout.slots]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const kw = searchQuery.trim().toLowerCase();
    stage.querySelectorAll<HTMLElement>(".qj-card-slot").forEach((slot) => {
      const kind = slot.dataset.kind;
      const title = (slot.dataset.title ?? "").toLowerCase();
      const category = (slot.dataset.category ?? "").toLowerCase();
      if (kind !== "real" || !kw) {
        slot.classList.remove("qj-dimmed");
        return;
      }
      const hit = title.includes(kw) || category.includes(kw);
      slot.classList.toggle("qj-dimmed", !hit);
    });
  }, [searchQuery, layout.slots]);

  // —— 阻尼/惯性横滚 + 轻摆 + 进场揭示 + dock/新建钮显隐(全部 imperative)——
  // reduceMotion 通过 ref 让动画帧实时读取最新值
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  // 搜索框有内容时 dock 常驻(供滚动 effect 内的 showDock 判断)
  const searchActiveRef = useRef(false);
  searchActiveRef.current = searchQuery.trim().length > 0;

  // 搜索有内容 → 立即常驻显示 dock(清空后恢复自动隐藏)
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    if (searchQuery.trim()) dock.classList.add("qj-show");
  }, [searchQuery]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const inner = innerRef.current;
    const stage = stageRef.current;
    const core = coreRef.current;
    const dock = dockRef.current;
    const dockProg = dockProgRef.current;
    const dockFill = dockFillRef.current;
    const dockCursor = dockCursorRef.current;
    const newFab = newFabRef.current;
    if (!scroller || !inner || !stage || !core) return;
    const scrollerEl = scroller;
    const stageEl = stage;
    const coreEl = core;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const initialViewX = initialHomeViewXRef.current ?? 0;
    initialHomeViewXRef.current = null;
    let viewX = initialViewX;
    let targetX = initialViewX;
    let velocity = 0;
    let maxX = 1;
    let dragging = false;
    let lastPointerX = 0;
    let downPointerX = 0; // 本次按下的起点 x:用于「累计位移超阈值才算拖拽」,避免微抖把点击误判成拖拽
    let lastMoveT = 0;
    let dragVel = 0;
    let raf = 0;
    let swayAngle = 0;
    let swayVel = 0;
    let movedFlag = false;
    let revealSeq = 0;
    let revealResetTimer: ReturnType<typeof setTimeout> | undefined;
    let dockHover = false;
    let dockHotspotHover = false;
    let dockHideTimer: ReturnType<typeof setTimeout> | undefined;
    let stageStartX = 0;

    const swayNodes = Array.from(stage.querySelectorAll<HTMLElement>(".qj-sway"));
    const momentNodes = Array.from(stage.querySelectorAll<HTMLElement>(".qj-stage-moment"));

    // scrollIndex: 让某卡居中所需的 viewX(供进度条 hover / 跳转 / 预览)
    let scrollIndex: { idx: number; x: number }[] = [];
    function buildScrollIndex() {
      if (!stage || !inner || !scroller) return;
      const stageRect = stage.getBoundingClientRect();
      const innerRect = inner.getBoundingClientRect();
      const stageOffset = stageRect.left - innerRect.left + viewX;
      const vw = scroller.clientWidth;
      scrollIndex = [];
      stage.querySelectorAll<HTMLElement>(".qj-card-slot").forEach((slot) => {
        const idx = Number(slot.dataset.idx);
        const left = parseFloat(slot.style.left) || 0;
        const centerInScroll = stageOffset + left + CARD_WIDTH / 2;
        scrollIndex.push({ idx, x: centerInScroll - vw / 2 });
      });
      scrollIndex.sort((a, b) => a.x - b.x);
    }

    function measure() {
      if (!inner || !scroller) return;
      maxX = Math.max(0, inner.scrollWidth - scroller.clientWidth);
      stageStartX = coreEl.offsetLeft + stageEl.offsetLeft;
      targetX = clamp(targetX, 0, maxX);
      viewX = clamp(viewX, 0, maxX);
    }

    function updateStageMoments() {
      if (!momentNodes.length) return;
      const reduce = reduceMotionRef.current || prefersReduced;
      const viewportW = scrollerEl.clientWidth || window.innerWidth;
      for (const node of momentNodes) {
        const triggerX = Number(node.dataset.triggerX);
        if (!Number.isFinite(triggerX)) continue;
        const screenTriggerX = stageStartX + triggerX - viewX;
        const fired = node.classList.contains("qj-fired");
        // 进入视野带内触发;滚过左侧很远 / 滚回右侧屏外则撤销 —— 再次进入会重播一次动效
        const offLeft = screenTriggerX < -940;
        const offRight = screenTriggerX > viewportW + 40;
        const inBand = screenTriggerX <= viewportW - 120 && !offLeft;
        // 飞鸟只播一次(刷新后),不随来回滚动反复出现——触发后永不撤销
        const once = node.classList.contains("qj-stage-moment-birds");
        if (!fired && inBand) {
          node.classList.add("qj-fired");
          if (reduce) node.classList.add("qj-reduced-fired");
        } else if (fired && !once && (offLeft || offRight)) {
          node.classList.remove("qj-fired");
          node.classList.remove("qj-reduced-fired");
        }
      }
    }

    function showDock() {
      if (!dock) return;
      dock.classList.add("qj-show");
      clearTimeout(dockHideTimer);
      // hover dock / 右下触发区 或 搜索框有内容 → 常驻,不自动隐藏
      if (!dockHover && !dockHotspotHover && !searchActiveRef.current) {
        dockHideTimer = setTimeout(() => {
          if (!dockHover && !dockHotspotHover && !searchActiveRef.current) dock.classList.remove("qj-show");
        }, 800);
      }
    }

    function scheduleDockHide(delay = 220) {
      if (!dock) return;
      clearTimeout(dockHideTimer);
      dockHideTimer = setTimeout(() => {
        if (!dockHover && !dockHotspotHover && !searchActiveRef.current) dock.classList.remove("qj-show");
      }, delay);
    }

    function isInDockHotspot(event: PointerEvent) {
      const width = Math.min(window.innerWidth * 0.48, 460);
      return event.clientX >= window.innerWidth - width && event.clientY >= window.innerHeight - 116;
    }

    function updateDockHotspot(event: PointerEvent) {
      const next = isInDockHotspot(event);
      if (next === dockHotspotHover) return;
      dockHotspotHover = next;
      if (next) {
        dock?.classList.add("qj-show");
        clearTimeout(dockHideTimer);
        return;
      }
      scheduleDockHide();
    }

    function updateNewFab() {
      if (!newFab || !scroller || !stage) return;
      const newSlot = stage.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]');
      if (!newSlot) return;
      const rect = newSlot.getBoundingClientRect();
      const scRect = scroller.getBoundingClientRect();
      const visible = rect.right > scRect.left && rect.left < scRect.right;
      newFab.classList.toggle("qj-show", !visible);
    }

    function pollReveal() {
      if (!scroller || !stage) return;
      const scRect = scroller.getBoundingClientRect();
      const vw = scroller.clientWidth;
      stage.querySelectorAll<HTMLElement>(".qj-card-slot:not(.qj-in)").forEach((slot) => {
        const rect = slot.getBoundingClientRect();
        const x = rect.left - scRect.left;
        if (x < vw + 240 && x > -CARD_WIDTH - 240) {
          const delay = Math.min(revealSeq, 7) * 70;
          revealSeq++;
          slot.style.transitionDelay = `${delay}ms`;
          slot.classList.add("qj-in");
        }
      });
      clearTimeout(revealResetTimer);
      revealResetTimer = setTimeout(() => {
        revealSeq = 0;
      }, 500);
    }

    function frame() {
      raf = 0;
      if (!inner) return;
      measure();
      const reduce = reduceMotionRef.current || prefersReduced;

      if (!dragging) {
        if (Math.abs(velocity) > 0.05) {
          targetX = clamp(targetX + velocity, 0, maxX);
          velocity *= 0.92;
          if (targetX <= 0 || targetX >= maxX) velocity = 0;
        } else {
          velocity = 0;
        }
      }
      const prevView = viewX;
      const stiffness = reduce ? 1 : 0.16;
      viewX += (targetX - viewX) * stiffness;
      if (Math.abs(targetX - viewX) < 0.06) viewX = targetX;
      inner.style.transform = `translate3d(${(-viewX).toFixed(2)}px,0,0)`;
      updateStageMoments();

      const moveDelta = viewX - prevView;
      if (!reduce) {
        swayVel += -moveDelta * 0.014;
        swayVel += (0 - swayAngle) * 0.2;
        swayVel *= 0.62;
        swayAngle += swayVel;
        swayAngle = clamp(swayAngle, -2.6, 2.6);
        if (Math.abs(swayAngle) < 0.01 && Math.abs(swayVel) < 0.01) {
          swayAngle = 0;
          swayVel = 0;
        }
        const t = `rotate(${swayAngle.toFixed(3)}deg)`;
        for (const node of swayNodes) node.style.transform = t;
      }

      const pct = maxX > 0 ? viewX / maxX : 0;
      // 填充条用 scaleX(合成层,不触发 layout);游标保留 left%(单个 11px 点,layout 成本可忽略),
      // 避免与 .qj-dp-cursor 的 transition:transform(hover 缩放)冲突导致游标跟随滞后(铁律:high 档零改)。
      const pctRounded = Number((pct * 100).toFixed(2)) / 100;
      if (dockFill) dockFill.style.transform = `scaleX(${pctRounded})`;
      if (dockCursor) dockCursor.style.left = `${(pct * 100).toFixed(2)}%`;

      if (Math.abs(moveDelta) > 0.05) {
        pollReveal();
        showDock();
        updateNewFab();
      }

      if (
        Math.abs(targetX - viewX) > 0.08 ||
        Math.abs(velocity) > 0.05 ||
        Math.abs(swayAngle) > 0.01 ||
        Math.abs(swayVel) > 0.01
      ) {
        requestFrame();
      }
    }
    function requestFrame() {
      if (!raf) raf = requestAnimationFrame(frame);
    }

    // —— 滚轮:纵向滚轮 → 横向展卷 ——
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      targetX = clamp(targetX + d, 0, maxX);
      velocity = clamp(velocity + d * 0.1, -38, 38);
      e.preventDefault();
      requestFrame();
      pollReveal();
    };
    const onNativeDragStart = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // —— 拖拽展卷(带惯性)——
    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      velocity = 0;
      dragVel = 0;
      movedFlag = false;
      lastPointerX = e.clientX;
      downPointerX = e.clientX;
      lastMoveT = performance.now();
      scroller.classList.add("qj-dragging");
      scroller.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      // 累计位移超过阈值(5px)才算真正拖拽 —— 否则点击时的微抖不该吞掉 click
      if (Math.abs(e.clientX - downPointerX) > 5) movedFlag = true;
      const now = performance.now();
      const dx = e.clientX - lastPointerX;
      targetX = clamp(targetX - dx, 0, maxX);
      const dt = Math.max(1, now - lastMoveT);
      dragVel = (-dx / dt) * 16;
      lastPointerX = e.clientX;
      lastMoveT = now;
      requestFrame();
      pollReveal();
    };
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      scroller.classList.remove("qj-dragging");
      velocity = clamp(dragVel, -40, 40);
      requestFrame();
    };
    // 方案4:触发「首页 → 编辑页」过渡。核心动效(卡飞 + 墨水/背景变深)整段在首页跑完,
    // 卡落定 + 背景已深的那一帧才切路由(onNewSession → workspace)。把「已到达态」交给编辑页,
    // 使其挂载即静帧渲染,再淡入正文。
    const triggerNewSession = () => {
      if (transitioningRef.current) return;
      const txStage = txStageRef.current;
      const newSlotEl = stage.querySelector<HTMLElement>('.qj-card-slot[data-kind="new"]');
      // 起点 = 新建卡确定化屏幕 rect(剔除 sway/hover 抖动,与返回落点同一坐标)。
      const stageRect = stage.getBoundingClientRect();
      const slotLeft = newSlotEl ? parseFloat(newSlotEl.style.left) || 0 : NEW_CARD_LEFT;
      const slotTop = newSlotEl ? parseFloat(newSlotEl.style.top) || 0 : 0;
      const fromRect = {
        left: stageRect.left + slotLeft,
        top: stageRect.top + slotTop,
        width: CARD_WIDTH,
        height: NEW_CARD_H,
      };
      // 落点 = workspace 编辑页文档纸张 rect,与文章打开路径保持同一几何。
      const landing = computeWorkspaceDocRect();

      // 兜底:无舞台(理论不会)时退回旧式「直接切路由,新建页自播进场」。
      if (!txStage) {
        onNewSession();
        return;
      }

      transitioningRef.current = true;
      const root = rootRef.current;
      root?.classList.add("qj-transitioning"); // 首页额外内容淡出(核心卡由 morph 接管)
      // 墨水起点 = 被点的新建卡中心(fromRect),墨从这张卡背后渗开 —— 与返回墨退 origin
      // (新建卡中心)对称。剔除点击抖动用卡中心而非 cx/cy,与返回落点同一坐标系。
      const inkOrigin = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
      txStage
        .playForward(fromRect, landing, inkOrigin, true)
        .then(() => {
          // 卡落定 + 背景已深的静止帧:交付到达态 → 切路由。编辑页挂载即静帧渲染。
          setWorkspaceArrive({
            rect: landing,
            x: inkOrigin.x,
            y: inkOrigin.y,
            sessionId: null,
          });
          onNewSession();
        });
    };

    const triggerOpenSession = (sessionId: string) => {
      if (transitioningRef.current) return;
      const txStage = txStageRef.current;
      const from = computeArticleCardScreenRect(sessionId);
      if (!txStage || !from) {
        onOpenSession(sessionId);
        return;
      }

      const landing = computeWorkspaceDocRect();
      transitioningRef.current = true;
      const root = rootRef.current;
      root?.classList.add("qj-transitioning");
      const inkOrigin = { x: from.centerX, y: from.centerY };
      txStage
        // plain=true:点击文章卡瞬间先把飞卡切成纯净纸,和工作区文档一致,再形变进场
        .playForward(from.rect, landing, inkOrigin, true)
        .then(() => {
          setWorkspaceArrive({
            rect: landing,
            x: inkOrigin.x,
            y: inkOrigin.y,
            sessionId,
          });
          onOpenSession(sessionId);
        });
    };

    // 把带动画的打开出口暴露给外部(右键菜单「打开」复用同一墨水过场)。
    if (openApiRef) openApiRef.current = triggerOpenSession;

    // 拖拽后短暂吞掉 click,避免误触卡片;否则坐标命中真正的卡片补发点击
    const onClickCapture = (e: MouseEvent) => {
      if (movedFlag) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const slot = hit?.closest?.(".qj-card-slot") as HTMLElement | null;
      if (!slot) return;
      const kind = slot.dataset.kind;
      const id = slot.dataset.id;
      if (kind === "new") {
        triggerNewSession();
      } else if (id) {
        triggerOpenSession(id);
      }
    };

    // —— 键盘 ← → Home End ——
    const onKey = (e: KeyboardEvent) => {
      // 只在长卷可见且未聚焦输入框时响应
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") {
        targetX = clamp(targetX + 320, 0, maxX);
        velocity = 12;
        requestFrame();
      } else if (e.key === "ArrowLeft") {
        targetX = clamp(targetX - 320, 0, maxX);
        velocity = -12;
        requestFrame();
      } else if (e.key === "Home") {
        targetX = 0;
        velocity = 0;
        requestFrame();
      } else if (e.key === "End") {
        targetX = maxX;
        velocity = 0;
        requestFrame();
      }
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("dragstart", onNativeDragStart, true);
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerup", endDrag);
    scroller.addEventListener("pointercancel", endDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointermove", updateDockHotspot);
    scroller.addEventListener("click", onClickCapture, true);
    scroller.addEventListener("keydown", onKey);

    // —— dock hover 常驻 ——
    const onDockEnter = () => {
      dockHover = true;
      clearTimeout(dockHideTimer);
      dock?.classList.add("qj-show");
    };
    const onDockLeave = () => {
      dockHover = false;
      if (dockHotspotHover || searchActiveRef.current) {
        showDock();
      } else {
        scheduleDockHide();
      }
    };
    dock?.addEventListener("pointerenter", onDockEnter);
    dock?.addEventListener("pointerleave", onDockLeave);

    // —— 进度条 hover 预览 + 点击跳转 ——
    function cardAtRatio(ratio: number) {
      if (!scrollIndex.length) return null;
      const wantX = ratio * maxX;
      let best = scrollIndex[0];
      let bestD = Infinity;
      for (const it of scrollIndex) {
        const cx = clamp(it.x, 0, maxX);
        const d = Math.abs(cx - wantX);
        if (d < bestD) {
          bestD = d;
          best = it;
        }
      }
      return best;
    }
    function ratioFromEvent(e: PointerEvent | MouseEvent) {
      if (!dockProg) return 0;
      const r = dockProg.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    }
    const onProgClick = (e: MouseEvent) => {
      const hit = cardAtRatio(ratioFromEvent(e));
      if (!hit) return;
      targetX = clamp(hit.x, 0, maxX);
      velocity = 0;
      requestFrame();
    };
    dockProg?.addEventListener("click", onProgClick);

    // —— 进度条 hover 预览小卡 ——
    const onProgMove = (e: PointerEvent) => {
      if (!dockProg || !dock) return;
      const hit = cardAtRatio(ratioFromEvent(e));
      // 新建卡(globalIdx 0)不预览
      if (!hit || hit.idx <= 0) {
        setPreview(null);
        return;
      }
      const dockRect = dock.getBoundingClientRect();
      const px = clamp(e.clientX - dockRect.left, 80, dockRect.width - 80);
      setPreview({ idx: hit.idx, left: px });
    };
    const onProgLeave = () => setPreview(null);
    dockProg?.addEventListener("pointermove", onProgMove);
    dockProg?.addEventListener("pointerleave", onProgLeave);

    // —— 左下＋:先平滑滚回最左让新建卡进入视口,再从其 rect 触发过渡 ——
    const onFabClick = () => {
      targetX = 0;
      velocity = 0;
      requestFrame();
      window.setTimeout(() => {
        triggerNewSession();
      }, 420);
    };
    newFab?.addEventListener("click", onFabClick);

    // —— resize 重新测量(布局由 React 重渲染负责)——
    const onResize = () => {
      measure();
      buildScrollIndex();
      requestFrame();
      requestAnimationFrame(pollReveal);
    };
    window.addEventListener("resize", onResize);

    // —— 初始化 ——
    // 先把所有卡片复位到起点态,再揭示首屏(避免停在起点态被裁)
    measure();
    buildScrollIndex();
    updateStageMoments();
    requestFrame();
    requestAnimationFrame(() => {
      pollReveal();
      updateNewFab();
    });
    // 兜底轮询:仍有未揭示卡片就继续揭示
    const revealInterval = setInterval(() => {
      if (stage.querySelector(".qj-card-slot:not(.qj-in)")) pollReveal();
    }, 400);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(revealResetTimer);
      clearTimeout(dockHideTimer);
      clearInterval(revealInterval);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("dragstart", onNativeDragStart, true);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerup", endDrag);
      scroller.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointermove", updateDockHotspot);
      scroller.removeEventListener("click", onClickCapture, true);
      scroller.removeEventListener("keydown", onKey);
      dock?.removeEventListener("pointerenter", onDockEnter);
      dock?.removeEventListener("pointerleave", onDockLeave);
      dockProg?.removeEventListener("click", onProgClick);
      dockProg?.removeEventListener("pointermove", onProgMove);
      dockProg?.removeEventListener("pointerleave", onProgLeave);
      newFab?.removeEventListener("click", onFabClick);
      window.removeEventListener("resize", onResize);
    };
    // 依赖 layout(布局变化时重建)+ 回调
  }, [layout, onOpenSession, onNewSession, computeArticleCardScreenRect, openApiRef]);

  const onSearchToggle = useCallback(() => {
    setSearchOpen((v) => {
      const next = !v;
      if (!next) setSearchQuery("");
      return next;
    });
    dockRef.current?.classList.add("qj-show");
  }, []);

  return (
    <div
      className={`qj-root${openingScroll ? " qj-opening" : ""}`}
      ref={rootRef}
      data-theme={theme}
      data-anim={anim}
      data-wf="QingjianScroll"
      data-clean={cleanMode ? "true" : "false"}
      data-reduce-motion={reduceMotion ? "true" : "false"}
    >
      {/* 右上 ⚙ 设置 */}
      <div className="qj-topctrl">
        <div className="qj-settings-wrap">
          <button
            type="button"
            className={`qj-settings-btn${settingsSheetOpen ? " qj-on" : ""}`}
            title="设置"
            aria-label="设置"
            aria-expanded={settingsSheetOpen}
            onClick={(e) => {
              e.stopPropagation();
              setSettingsSheetOpen(true);
            }}
          >
            ⚙
          </button>
        </div>
      </div>

      {settingsSheetOpen && (
        <HomeSettingsSheet
          initialTab={settingsInitialTab}
          inkVariant={settingsInkVariant}
          themeMode={themeMode}
          themeModeOptions={THEME_MODE_OPTIONS}
          anim={anim}
          animOptions={ANIM_OPTIONS}
          reduceMotion={reduceMotion}
          primaryFont={primaryFont}
          secondaryFont={secondaryFont}
          fontOptions={FONT_OPTIONS}
          onThemeModeChange={setThemeMode}
          onAnimChange={(nextAnim) => {
            rootRef.current?.setAttribute("data-anim", nextAnim);
            setAnim(nextAnim);
            replayVisibleCards();
          }}
          onReduceMotionToggle={() => setReduceMotion((v) => !v)}
          onPrimaryFontChange={setPrimaryFont}
          onSecondaryFontChange={setSecondaryFont}
          onOpenShelf={onOpenShelf}
          onClose={() => setSettingsSheetOpen(false)}
        />
      )}

      {inkDebugOpen ? (
        <div className="qj-ink-debug" role="group" aria-label="泼墨弹窗调试">
          <div className="qj-ink-debug-title">泼墨弹窗</div>
          <div className="qj-ink-debug-actions">
            {SETTINGS_INK_VARIANTS.map((variant) => (
              <button
                key={variant}
                type="button"
                className={`qj-ink-debug-btn${settingsInkVariant === variant ? " qj-active" : ""}`}
                aria-pressed={settingsInkVariant === variant}
                onClick={() => setSettingsInkVariant(variant)}
              >
                {SETTINGS_INK_VARIANT_LABEL[variant]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="qj-ink-debug-preview"
            onClick={() => setSettingsSheetOpen(true)}
          >
            预览当前版本
          </button>
        </div>
      ) : null}

      {/* 长卷视口 */}
      <div className="qj-scroll" ref={scrollRef} tabIndex={0}>
        <div className="qj-inner" ref={innerRef}>
          {/* 卷首 */}
          <div className="qj-roller qj-head" />
          <div className="qj-silk qj-left" />
          <div className="qj-frontispiece">
            <div className="qj-fp-title" aria-label="青简">
              <span className="qj-fp-title-char" data-qj-char="青" aria-hidden="true">
                青
              </span>
              <span className="qj-fp-title-char" data-qj-char="简" aria-hidden="true">
                简
              </span>
            </div>
            <QingjianSideVerse />
            <img className="qj-fp-sealimg" src={SEAL_SRC} alt="印" />
          </div>
          <div className="qj-silk qj-right" />

          {/* 画心 */}
          <div className="qj-silkcore" ref={coreRef} style={{ width: `${layout.coreWidth}px` }}>
            <div className="qj-stage" ref={stageRef}>
              {layout.stageMoments.map((moment) => (
                <QingjianStageMoment key={moment.id} moment={moment} />
              ))}
              {layout.slots.map((slot) => (
                <div
                  key={slot.entry.id}
                  className="qj-card-slot"
                  data-idx={slot.globalIdx}
                  data-kind={slot.entry.kind}
                  data-id={slot.entry.id}
                  data-layer={slot.layer}
                  data-title={slot.entry.title}
                  data-category={slot.entry.category}
                  style={{
                    left: `${slot.left}px`,
                    top: `${slot.top}px`,
                    ["--qj-card-z" as string]: String(getCardZIndex(slot.layer)),
                    ["--qj-card-hover-z" as string]: String(getCardZIndex(slot.layer) + 120),
                    ["--qj-enter-x" as string]: `${slot.enterX.toFixed(1)}px`,
                    ["--qj-enter-y" as string]: `${slot.enterY.toFixed(1)}px`,
                    ["--qj-enter-rot" as string]: `${slot.enterRot.toFixed(1)}deg`,
                  }}
                >
                  <div className="qj-sway">
                    {slot.entry.kind === "new" ? (
                      <NewCard textures={textures} />
                    ) : slot.entry.article && slot.entry.template ? (
                      <CardRenderer
                        article={slot.entry.article}
                        template={slot.entry.template}
                        colorConfig={colorConfig}
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 卷尾 */}
          <div className="qj-silk qj-left" />
          <div className="qj-colophon">
            <div className="qj-fp-seal">卷终</div>
          </div>
          <div className="qj-silk qj-right" />
          <div className="qj-roller qj-tail" />
        </div>
      </div>

      <div className="qj-dock-hotspot" aria-hidden="true" />

      {/* 右下:进度 + 搜索 dock */}
      <div className="qj-dock" ref={dockRef} aria-label="展卷进度与搜索">
        {/* hover 预览小卡(进度条上方) */}
        {(() => {
          const entry = preview ? entries[preview.idx] : undefined;
          if (!preview || !entry || !entry.article || !entry.template) return null;
          const previewText = entry.brief.trim() || entry.article.description?.trim() || "暂无正文预览";
          const previewDate = formatPreviewDate(entry.createdAt);
          const previewChars = countPreviewChars(previewText);
          return (
            <div
              className="qj-dock-preview qj-show"
              aria-hidden="true"
              style={{ left: `${preview.left}px` }}
            >
              <div className="qj-dock-preview-card">
                <div className="qj-dock-preview-title">{entry.title}</div>
                <div className="qj-dock-preview-body">{previewText}</div>
              </div>
              <div className="qj-dock-preview-meta">
                <span>{previewDate}</span>
                <span aria-hidden="true">·</span>
                <span>{previewChars} 字</span>
              </div>
            </div>
          );
        })()}
        <div className="qj-dock-bar">
          <div className="qj-dock-prog" ref={dockProgRef} title="时间轴进度 · 点击跳转">
            <div className="qj-dp-track">
              <div className="qj-dp-fill" ref={dockFillRef} />
              <div className="qj-dp-cursor" ref={dockCursorRef} />
            </div>
            <div className="qj-dp-scale">
              <span>{layout.dateMin || "—"}</span>
              <span>{layout.dateMax || "—"}</span>
            </div>
          </div>
          <button
            type="button"
            className={`qj-dock-search-btn${searchOpen ? " qj-on" : ""}`}
            title="搜索"
            aria-label="搜索"
            aria-expanded={searchOpen}
            onClick={onSearchToggle}
          >
            <SearchIcon />
          </button>
          <div className={`qj-dock-search-wrap${searchOpen ? " qj-open" : ""}`}>
            <input
              className="qj-dock-search-input"
              type="text"
              placeholder="搜标题 / 分类…"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  setSearchOpen(false);
                }
              }}
            />
            <span className="qj-dock-search-count">
              {searchQuery.trim() ? `找到 ${matchedCount} 篇` : ""}
            </span>
          </div>
        </div>
      </div>

      {/* 左下「＋」新建浮钮 */}
      <button
        type="button"
        className="qj-new-fab"
        ref={newFabRef}
        title="新建文档"
        aria-label="新建文档"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

// 「新建文档」卡(第 5 版:双线回框 + 对角朱砂折角 + V9 噪点纸 + 竖排墨纹标题)
function NewCard({ textures }: { textures: { noise: string; inkTex: string } }) {
  return (
    <article
      className="cm-card qj-new-card"
      style={{ width: `${CARD_WIDTH}px`, height: `${NEW_CARD_H}px` }}
    >
      <div className="qj-nc-tex" style={{ background: `${textures.noise} repeat` }} />
      <div className="qj-nc-shade" />
      <div className="qj-nc-frame" />
      <span className="qj-nc-corner qj-tl" />
      <span className="qj-nc-corner qj-br" />
      <div
        className="qj-nc-title"
        style={{
          background: textures.inkTex,
          backgroundSize: "150px 150px",
          backgroundPosition: "center",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}
      >
        新建文档
      </div>
    </article>
  );
}
