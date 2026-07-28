import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { usePerfTier, type PerfTier } from "../../../system/perf/motionTier";
import {
  createVisibilityPausedInterval,
  useVisibilityPausedRaf,
} from "../../../system/perf/visibilityScheduler";
import {
  HANZI_MATRIX_POOLS,
  HANZI_MATRIX_PRESETS,
  HANZI_PULSE_DURATION_MAX_S,
  HANZI_PULSE_DURATION_MIN_S,
  getHanziMatrixConfig,
  subscribeHanziMatrixConfig,
  type HanziMatrixConfig,
} from "../data/hanziMatrixConfig";

// 「汉字矩阵」背景层(移植自 uiverse wet-lionfish 片假名矩阵,换中文字符池)。
// Batch 3 起由 DOM span 网格改为单 canvas:布局/字符序/发光脉冲/converge 仍按旧 DOM 实现复刻。

const LOW_TIER_HANZI_HI_RATIO = 0.15;
const LOW_TIER_HANZI_CELL = 52;
const TICK_MS = 260;
const PULSE_DRAW_INTERVAL_MS = 1000 / 30;
const HIGH_PULSE_DRAW_INTERVAL_MS = 0;
const PULSE_ADAPTIVE_FRAME_BUDGET_MS = 14;
const PULSE_ADAPTIVE_SLOW_FRAME_LIMIT = 8;
const PULSE_ADAPTIVE_RECOVER_FRAME_MS = 10;
const PULSE_ADAPTIVE_RECOVER_FRAME_LIMIT = 12;
const GLYPH_PREHEAT_CHUNK_SIZE = 16;
const FLY_SPREAD = 0.62;
const BASE_SHADOW_BLUR = 5;
const FLY_GLOW_RGB = "200, 169, 106";
const PULSE_EASE = [0.42, 0, 0.58, 1] as const;
const FLY_TRANSFORM_EASE = [0.5, 0.02, 0.78, 0.08] as const;
const FLY_OPACITY_EASE = [0.6, 0, 0.85, 0.25] as const;
const FLY_COLOR_EASE = [0.25, 0.1, 0.25, 1] as const;
const MAX_GLYPH_SPRITES = 1200;
const MAX_FLY_FILL_SPRITES = 320;
const CENTER_BLUR_MASK_CENTER_X = 0.5;
const CENTER_BLUR_MASK_CENTER_Y = 0.47;
const CENTER_BLUR_MASK_SOLID_STOP = 0.26;
const CENTER_BLUR_MASK_TRANSPARENT_STOP = 0.82;
const CENTER_BLUR_BAKE_FALLBACK_MS = 200;

export type HanziMatrixSeed = string | number;

export interface HanziMatrixProps {
  seed?: HanziMatrixSeed;
}

export interface HanziMatrixCellSnapshot {
  ch: string;
  col: number;
  height: number;
  index: number;
  row: number;
  width: number;
  x: number;
  y: number;
}

export interface HanziMatrixLayout {
  cells: HanziMatrixCellSnapshot[];
  colWidth: number;
  cols: number;
  fontSize: number;
  height: number;
  rowOffsetY: number;
  rows: number;
  width: number;
}

export interface HanziCenterBlurMaskGeometry {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  solidStop: number;
  transparentStop: number;
}

export interface HanziPulseState {
  durationMs: number;
  index: number;
  startTime: number;
}

export interface HanziMatrixConvergeTarget {
  ch: number;
  cw: number;
  cx: number;
  cy: number;
  startTime?: number;
}

export interface HanziMatrixConvergeItem {
  cell: HanziMatrixCellSnapshot;
  delayMs: number;
  dist: number;
  durationMs: number;
  rotationDeg: number;
  scaleEnd: number;
  tx: number;
  ty: number;
}

export interface HanziMatrixHandle {
  converge: (target: HanziMatrixConvergeTarget) => void;
  getCells: () => readonly HanziMatrixCellSnapshot[];
}

interface Rgba {
  a: number;
  b: number;
  g: number;
  r: number;
}

interface DrawTheme {
  base: Rgba;
  baseGlow: Rgba;
  flyGlow: Rgba;
  hi1: Rgba;
  hi2: Rgba;
  peak: Rgba;
}

interface DrawOptions {
  baseCacheKey: string;
  cell: number;
  dpr: number;
  fontFamily: string;
  fontSize: number;
  height: number;
  maskBlur: number;
  maskHeight: number;
  maskStrength: number;
  maskWidth: number;
  poolChars: string;
  spriteCacheKey: string;
  theme: DrawTheme;
  width: number;
}

interface CanvasCache {
  canvas: HTMLCanvasElement;
  centerBlurBaked: boolean;
  key: string;
  pendingCenterBlurBake?: PendingIdleTask;
  pendingGlyphSpritePreheat?: PendingIdleTask;
}

interface PendingIdleTask {
  cancel: () => void;
}

interface ConvergeState {
  itemsByIndex: Map<number, HanziMatrixConvergeItem>;
  maxEndTime: number;
  startTime: number;
}

export interface HanziPulseAdaptiveThrottleState {
  cheapFrameCount: number;
  slowFrameCount: number;
  throttled: boolean;
}

interface HanziCanvasDrawResult {
  painted: boolean;
  pulseFrame: boolean;
}

const hanziMatrixHandles = new WeakMap<Element, HanziMatrixHandle>();
const glyphSpriteCache = new Map<string, GlyphSprite>();
const flyFillSpriteCache = new Map<string, GlyphSprite>();

interface GlyphSprite {
  canvas: HTMLCanvasElement;
  cssSize: number;
}

interface PulseFrame {
  fill: Rgba;
  shadows: { blur: number; color: Rgba }[];
  t: number;
}

export function getHanziMatrixHandle(element: Element | null): HanziMatrixHandle | null {
  return element ? hanziMatrixHandles.get(element) ?? null : null;
}

export function resolveHanziMatrixRuntimeConfig(
  config: HanziMatrixConfig,
  perfTier: PerfTier,
  reducedMotion: boolean,
): HanziMatrixConfig {
  if (perfTier !== "low" && !reducedMotion) {
    return config;
  }

  return {
    ...config,
    hiRatio: Math.min(config.hiRatio, LOW_TIER_HANZI_HI_RATIO),
    cell: Math.max(config.cell, LOW_TIER_HANZI_CELL),
    maskBlur: 0,
  };
}

export function buildHanziMatrixLayout(
  viewport: { h: number; w: number },
  cell: number,
  poolChars: string,
): HanziMatrixLayout {
  if (viewport.w <= 0 || viewport.h <= 0 || cell <= 0 || poolChars.length === 0) {
    return {
      cells: [],
      colWidth: 0,
      cols: 0,
      fontSize: Math.round(Math.max(0, cell) * 0.68),
      height: viewport.h,
      rowOffsetY: 0,
      rows: 0,
      width: viewport.w,
    };
  }

  // CSS grid 旧实现:列数 floor(viewport/cell),auto-fill 的 1fr 把列宽摊满视口;
  // 行数 ceil(h/cell)+1,再由 align-content:center 在纵向居中,首尾各溢出半行。
  const cols = Math.max(1, Math.floor(viewport.w / cell));
  const rows = Math.ceil(viewport.h / cell) + 1;
  const colWidth = viewport.w / cols;
  const rowOffsetY = (viewport.h - rows * cell) / 2;
  const fontSize = Math.round(cell * 0.68);
  const cells: HanziMatrixCellSnapshot[] = new Array(cols * rows);

  for (let i = 0; i < cells.length; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cells[i] = {
      ch: poolChars.charAt(i % poolChars.length),
      col,
      height: cell,
      index: i,
      row,
      width: colWidth,
      x: col * colWidth + colWidth / 2,
      y: rowOffsetY + row * cell + cell / 2,
    };
  }

  return {
    cells,
    colWidth,
    cols,
    fontSize,
    height: viewport.h,
    rowOffsetY,
    rows,
    width: viewport.w,
  };
}

export function createHanziMatrixRandom(seed?: HanziMatrixSeed): () => number {
  if (seed === undefined || seed === null) {
    return () => Math.random();
  }

  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createHanziPulseAdaptiveThrottleState(): HanziPulseAdaptiveThrottleState {
  return {
    cheapFrameCount: 0,
    slowFrameCount: 0,
    throttled: false,
  };
}

export function resetHanziPulseAdaptiveThrottle(state: HanziPulseAdaptiveThrottleState): void {
  state.cheapFrameCount = 0;
  state.slowFrameCount = 0;
  state.throttled = false;
}

export function updateHanziPulseAdaptiveThrottle(
  state: HanziPulseAdaptiveThrottleState,
  frameCostMs: number,
): void {
  if (state.throttled) {
    state.slowFrameCount = 0;
    state.cheapFrameCount = frameCostMs <= PULSE_ADAPTIVE_RECOVER_FRAME_MS ? state.cheapFrameCount + 1 : 0;
    if (state.cheapFrameCount >= PULSE_ADAPTIVE_RECOVER_FRAME_LIMIT) {
      resetHanziPulseAdaptiveThrottle(state);
    }
    return;
  }

  state.cheapFrameCount = 0;
  state.slowFrameCount = frameCostMs > PULSE_ADAPTIVE_FRAME_BUDGET_MS ? state.slowFrameCount + 1 : 0;
  if (state.slowFrameCount >= PULSE_ADAPTIVE_SLOW_FRAME_LIMIT) {
    state.throttled = true;
    state.slowFrameCount = 0;
    state.cheapFrameCount = 0;
  }
}

export function resolveHanziPulseDrawIntervalMs(input: {
  adaptiveThrottleActive: boolean;
  highMotion: boolean;
}): number {
  return input.highMotion && !input.adaptiveThrottleActive
    ? HIGH_PULSE_DRAW_INTERVAL_MS
    : PULSE_DRAW_INTERVAL_MS;
}

export function createHanziPulseBatch(input: {
  activeIndexes: ReadonlySet<number>;
  hiRatio: number;
  now: number;
  random: () => number;
  speed: number;
  total: number;
}): HanziPulseState[] {
  const { activeIndexes, hiRatio, now, random, speed, total } = input;
  if (total <= 0 || hiRatio <= 0) {
    return [];
  }

  const target = Math.round(total * hiRatio);
  let deficit = Math.min(target - activeIndexes.size, Math.max(1, Math.ceil(target / 10)));
  if (deficit <= 0) {
    return [];
  }

  const nextActive = new Set(activeIndexes);
  const pulses: HanziPulseState[] = [];
  let guard = 0;

  while (deficit > 0 && guard < total * 2) {
    guard += 1;
    const index = Math.floor(random() * total);
    if (nextActive.has(index)) {
      continue;
    }
    const durationS =
      (HANZI_PULSE_DURATION_MIN_S +
        random() * (HANZI_PULSE_DURATION_MAX_S - HANZI_PULSE_DURATION_MIN_S)) *
      speed;
    pulses.push({ durationMs: durationS * 1000, index, startTime: now - random() * TICK_MS });
    nextActive.add(index);
    deficit -= 1;
  }

  return pulses;
}

export function createHanziCenterBlurMaskGeometry(input: {
  height: number;
  maskHeight: number;
  maskWidth: number;
  width: number;
}): HanziCenterBlurMaskGeometry {
  return {
    centerX: input.width * CENTER_BLUR_MASK_CENTER_X,
    centerY: input.height * CENTER_BLUR_MASK_CENTER_Y,
    radiusX: Math.max(1, input.width * (input.maskWidth / 100)),
    radiusY: Math.max(1, input.height * (input.maskHeight / 100)),
    solidStop: CENTER_BLUR_MASK_SOLID_STOP,
    transparentStop: CENTER_BLUR_MASK_TRANSPARENT_STOP,
  };
}

export function createHanziConvergeItems(
  cells: readonly HanziMatrixCellSnapshot[],
  target: Omit<HanziMatrixConvergeTarget, "startTime">,
): HanziMatrixConvergeItem[] {
  if (cells.length === 0) {
    return [];
  }

  let maxDist = 1;
  const measured = cells.map((cell) => {
    const dist = Math.hypot(cell.x - target.cx, cell.y - target.cy);
    if (dist > maxDist) {
      maxDist = dist;
    }
    return { cell, dist };
  });

  return measured.map(({ cell, dist }, i) => {
    const r1 = flyRnd(i, 1.7);
    const r2 = flyRnd(i, 3.1);
    const r3 = flyRnd(i, 5.3);
    const r4 = flyRnd(i, 7.9);
    return {
      cell,
      delayMs: (dist / maxDist) * 110 + r4 * 260,
      dist,
      durationMs: (0.58 + r3 * 0.62) * 1000,
      rotationDeg: (r2 - 0.5) * 46,
      scaleEnd: 0.12 + r1 * 0.16,
      tx: target.cx + (r1 - 0.5) * target.cw * FLY_SPREAD,
      ty: target.cy + (r2 - 0.5) * target.ch * FLY_SPREAD,
    };
  });
}

export function flyRnd(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function clearExpiredHanziConvergeForFrame<T extends { maxEndTime: number }>(
  convergeRef: { current: T | null },
  timestamp: number,
): T | null {
  const converge = convergeRef.current;
  if (converge && timestamp > converge.maxEndTime) {
    convergeRef.current = null;
    return null;
  }
  return converge;
}

// 30fps pulse 节流判定:返回 true 表示本帧可跳过重绘。converge 收尾帧(wasFlyFrame)不许跳过,
// 必须强制重绘把飞入残影 reset 干净(ccreview C)。converge 进行中(hasConverge)也不节流。
export function shouldSkipThrottledPulseFrame(input: {
  hasConverge: boolean;
  wasFlyFrame: boolean;
  pulseSize: number;
  sinceLastPaintMs: number;
  intervalMs: number;
}): boolean {
  const { hasConverge, wasFlyFrame, pulseSize, sinceLastPaintMs, intervalMs } = input;
  if (intervalMs <= 0) {
    return false;
  }
  return !hasConverge && !wasFlyFrame && pulseSize > 0 && sinceLastPaintMs < intervalMs;
}

export function HanziMatrix({ seed }: HanziMatrixProps = {}) {
  const perfTier = usePerfTier();
  const [config, setConfig] = useState<HanziMatrixConfig>(() => getHanziMatrixConfig());
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === "undefined" ? 0 : window.innerWidth,
    h: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [fontsReady, setFontsReady] = useState(
    () => typeof document === "undefined" || !("fonts" in document),
  );
  const [fontFamily, setFontFamily] = useState("serif");
  // 进场淡入自己管(is-on 延后一帧挂上):不跟 .ccx-space 的 is-ink-wipe 瞬时就位走,
  // 否则从首页切过来矩阵会无过渡地砰一下出现(首页最后一帧没有矩阵,瞬时就位反而跳)。
  const [on, setOn] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseCacheRef = useRef<CanvasCache | null>(null);
  const convergeRef = useRef<ConvergeState | null>(null);
  const lastPaintTimeRef = useRef(0);
  const layoutRef = useRef<HanziMatrixLayout | null>(null);
  const pulseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pulseThrottleRef = useRef<HanziPulseAdaptiveThrottleState>(createHanziPulseAdaptiveThrottleState());
  const pulseRef = useRef<Map<number, HanziPulseState>>(new Map());
  const randomRef = useRef<() => number>(createHanziMatrixRandom(seed));
  const staticFrameKeyRef = useRef("");
  const themeRef = useRef<DrawTheme | null>(null);
  const baseFrameKeyRef = useRef("");
  const wakeCanvasRafRef = useRef<() => void>(() => undefined);
  const wakeCanvas = useCallback(() => {
    wakeCanvasRafRef.current();
  }, []);

  useEffect(() => subscribeHanziMatrixConfig(setConfig), []);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;

    const onChange = () => setReducedMotion(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fonts = typeof document === "undefined" ? null : document.fonts;
    if (!fonts?.ready) {
      setFontsReady(true);
      return;
    }
    fonts.ready
      .then(() => {
        if (!cancelled) {
          setFontsReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFontsReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setOn(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    let rafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const updateViewport = () => {
      rafId = null;
      const next = { w: window.innerWidth, h: window.innerHeight };
      setViewport((current) => (current.w === next.w && current.h === next.h ? current : next));
    };

    const scheduleViewportUpdate = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(updateViewport);
    };

    if (typeof ResizeObserver !== "undefined" && hostRef.current) {
      resizeObserver = new ResizeObserver(scheduleViewportUpdate);
      resizeObserver.observe(hostRef.current);
    }
    window.addEventListener("resize", scheduleViewportUpdate);
    scheduleViewportUpdate();

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleViewportUpdate);
    };
  }, []);

  useEffect(() => {
    randomRef.current = createHanziMatrixRandom(seed);
  }, [seed]);

  useEffect(() => () => {
    cancelCanvasCacheTasks(baseCacheRef.current);
  }, []);

  const {
    preset,
    hiRatio,
    speed,
    baseAlpha,
    hiAlpha,
    cell,
    pool,
    enabled,
    maskStrength,
    maskWidth,
    maskHeight,
    maskBlur,
  } = useMemo(
    () => resolveHanziMatrixRuntimeConfig(config, perfTier, reducedMotion),
    [config, perfTier, reducedMotion],
  );
  const colors = HANZI_MATRIX_PRESETS[preset];
  const poolChars = HANZI_MATRIX_POOLS[pool].chars;
  const highMotion = perfTier !== "low" && !reducedMotion;

  const layout = useMemo(
    () =>
      enabled
        ? buildHanziMatrixLayout(viewport, cell, poolChars)
        : buildHanziMatrixLayout({ w: 0, h: 0 }, cell, ""),
    [cell, enabled, poolChars, viewport],
  );
  layoutRef.current = layout;

  const theme = useMemo<DrawTheme>(
    () => ({
      base: parseRgb(colors.baseRgb, baseAlpha),
      baseGlow: parseRgb(colors.baseRgb, Math.min(1, baseAlpha * 1.3)),
      flyGlow: parseRgb(FLY_GLOW_RGB, 1),
      hi1: parseRgb(colors.hi1Rgb, hiAlpha),
      hi2: parseRgb(colors.hi2Rgb, hiAlpha),
      peak: parseRgb(colors.peakRgb, hiAlpha),
    }),
    [baseAlpha, colors.baseRgb, colors.hi1Rgb, colors.hi2Rgb, colors.peakRgb, hiAlpha],
  );
  themeRef.current = theme;

  const layoutKey = `${layout.width}x${layout.height}|${layout.cols}x${layout.rows}|${cell}|${pool}`;
  const themeKey = `${preset}|${baseAlpha}|${hiAlpha}|${maskStrength}|${maskWidth}|${maskHeight}|${maskBlur}`;

  useEffect(() => {
    if (!fontsReady || !baseCanvasRef.current) {
      return;
    }
    setFontFamily(readCanvasFontFamily(baseCanvasRef.current));
  }, [fontsReady, layoutKey]);

  useEffect(() => {
    pulseRef.current.clear();
    convergeRef.current = null;
    staticFrameKeyRef.current = "";
    resetHanziPulseAdaptiveThrottle(pulseThrottleRef.current);
  }, [highMotion, layoutKey, speed, hiRatio, themeKey]);

  const startConverge = useCallback((target: HanziMatrixConvergeTarget) => {
    const layoutNow = layoutRef.current;
    if (!layoutNow || layoutNow.cells.length === 0) {
      return;
    }

    const items = createHanziConvergeItems(layoutNow.cells, target);
    const startTime = target.startTime ?? performance.now();
    const itemsByIndex = new Map<number, HanziMatrixConvergeItem>();
    let maxEndTime = startTime;
    for (const item of items) {
      itemsByIndex.set(item.cell.index, item);
      maxEndTime = Math.max(maxEndTime, startTime + item.delayMs + item.durationMs);
    }
    convergeRef.current = { itemsByIndex, maxEndTime, startTime };
    staticFrameKeyRef.current = "";
    wakeCanvas();
  }, [wakeCanvas]);

  const getCells = useCallback(() => layoutRef.current?.cells ?? [], []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const handle: HanziMatrixHandle = {
      converge: startConverge,
      getCells,
    };
    hanziMatrixHandles.set(host, handle);
    return () => {
      hanziMatrixHandles.delete(host);
    };
  }, [getCells, startConverge]);

  useEffect(() => {
    const host = hostRef.current;
    const total = layout.cells.length;
    if (!enabled || !fontsReady || reducedMotion || total === 0) {
      return;
    }

    const tick = () => {
      const now = performance.now();
      pruneExpiredPulses(pulseRef.current, now);
      const activeIndexes = new Set(pulseRef.current.keys());
      const batch = createHanziPulseBatch({
        activeIndexes,
        hiRatio,
        now,
        random: randomRef.current,
        speed,
        total,
      });
      for (const pulse of batch) {
        pulseRef.current.set(pulse.index, pulse);
      }
      if (batch.length > 0) {
        staticFrameKeyRef.current = "";
        wakeCanvas();
      }
    };

    const pulseTimer = createVisibilityPausedInterval(tick, TICK_MS, { element: host });
    return () => {
      pulseTimer.stop();
      pulseRef.current.clear();
    };
  }, [enabled, fontsReady, hiRatio, layout.cells.length, reducedMotion, speed, wakeCanvas]);

  const draw = useCallback((timestamp: number) => {
    const baseCanvas = baseCanvasRef.current;
    const pulseCanvas = pulseCanvasRef.current;
    const layoutNow = layoutRef.current;
    const themeNow = themeRef.current;
    if (!baseCanvas || !pulseCanvas || !layoutNow || !themeNow || layoutNow.cells.length === 0 || !fontsReady) {
      return false;
    }

    const dpr = readDevicePixelRatio();
    const options: DrawOptions = {
      baseCacheKey: `${layoutKey}|${themeKey}|${fontFamily}|${dpr}`,
      cell,
      dpr,
      fontFamily,
      fontSize: layoutNow.fontSize,
      height: layoutNow.height,
      maskBlur,
      maskHeight,
      maskStrength,
      maskWidth,
      poolChars,
      spriteCacheKey: `${layoutKey}|${preset}|${baseAlpha}|${hiAlpha}|${fontFamily}|${dpr}`,
      theme: themeNow,
      width: layoutNow.width,
    };
    const pulseDrawIntervalMs = resolveHanziPulseDrawIntervalMs({
      adaptiveThrottleActive: pulseThrottleRef.current.throttled,
      highMotion,
    });
    const shouldMeasurePulseFrame = highMotion && pulseRef.current.size > 0;
    const frameStart = shouldMeasurePulseFrame ? performance.now() : 0;
    const result = drawHanziCanvas({
      baseCanvas,
      baseCacheRef,
      baseFrameKeyRef,
      convergeRef,
      lastPaintTimeRef,
      layout: layoutNow,
      options,
      pulseDrawIntervalMs,
      pulseCanvas,
      pulseRef,
      staticFrameKeyRef,
      timestamp,
      onBaseCacheBaked: () => {
        baseFrameKeyRef.current = "";
        staticFrameKeyRef.current = "";
        wakeCanvas();
      },
    });
    if (shouldMeasurePulseFrame && result.painted && result.pulseFrame) {
      updateHanziPulseAdaptiveThrottle(pulseThrottleRef.current, performance.now() - frameStart);
    }
    return convergeRef.current !== null || pulseRef.current.size > 0;
  }, [
    baseAlpha,
    cell,
    fontFamily,
    fontsReady,
    highMotion,
    hiAlpha,
    layoutKey,
    maskBlur,
    maskHeight,
    maskStrength,
    maskWidth,
    poolChars,
    preset,
    themeKey,
    wakeCanvas,
  ]);

  const wakeCanvasRaf = useVisibilityPausedRaf(draw, enabled && fontsReady && layout.cells.length > 0, {
    element: hostRef.current,
  });
  wakeCanvasRafRef.current = wakeCanvasRaf;

  useEffect(() => {
    wakeCanvas();
  }, [fontFamily, fontsReady, layoutKey, maskBlur, themeKey, wakeCanvas]);

  if (!enabled) return null;

  const vars = {
    "--hz-base-color": `rgba(${colors.baseRgb}, ${baseAlpha})`,
    "--hz-base-glow": `rgba(${colors.baseRgb}, ${Math.min(1, baseAlpha * 1.3)})`,
    // 高亮三色由 hiAlpha 统一缩放(发光 text-shadow 引用同一变量,跟着一起淡)
    "--hz-hi-1": `rgba(${colors.hi1Rgb}, ${hiAlpha})`,
    "--hz-hi-2": `rgba(${colors.hi2Rgb}, ${hiAlpha})`,
    "--hz-hi-peak": `rgba(${colors.peakRgb}, ${hiAlpha})`,
    "--hz-cell": `${cell}px`,
    "--hz-font-size": `${Math.round(cell * 0.68)}px`,
    // 中央椭圆蒙版:核心区不透明度 = 1 - 强度(0 强度 → 核心 1 → 蒙版无效果)
    "--hz-mask-core": `${(1 - maskStrength).toFixed(2)}`,
    "--hz-mask-w": `${maskWidth}%`,
    "--hz-mask-h": `${maskHeight}%`,
  } as CSSProperties;

  return (
    <div
      className={`ccx-hanzi${on ? " is-on" : ""}`}
      style={vars}
      aria-hidden="true"
      data-wf="HanziMatrix"
      ref={hostRef}
    >
      <canvas className="ccx-hanzi-canvas ccx-hanzi-canvas--base" ref={baseCanvasRef} />
      <canvas className="ccx-hanzi-canvas ccx-hanzi-canvas--pulse" ref={pulseCanvasRef} />
    </div>
  );
}

function drawHanziCanvas(input: {
  baseCanvas: HTMLCanvasElement;
  baseCacheRef: MutableRefObject<CanvasCache | null>;
  baseFrameKeyRef: MutableRefObject<string>;
  convergeRef: MutableRefObject<ConvergeState | null>;
  lastPaintTimeRef: MutableRefObject<number>;
  layout: HanziMatrixLayout;
  options: DrawOptions;
  pulseDrawIntervalMs: number;
  pulseCanvas: HTMLCanvasElement;
  pulseRef: MutableRefObject<Map<number, HanziPulseState>>;
  staticFrameKeyRef: MutableRefObject<string>;
  timestamp: number;
  onBaseCacheBaked: () => void;
}): HanziCanvasDrawResult {
  const {
    baseCanvas,
    baseCacheRef,
    baseFrameKeyRef,
    convergeRef,
    lastPaintTimeRef,
    layout,
    options,
    pulseDrawIntervalMs,
    pulseCanvas,
    pulseRef,
    staticFrameKeyRef,
    timestamp,
    onBaseCacheBaked,
  } = input;
  pruneExpiredPulses(pulseRef.current, timestamp);
  const pulseFrame = pulseRef.current.size > 0;
  const converge = clearExpiredHanziConvergeForFrame(convergeRef, timestamp);
  const hasConverge = converge !== null;
  // 刚结束 converge(本帧被清空)时 base 仍停在 "fly":必须强制重绘把飞入层 reset 干净 + 恢复底图,
  // 不能被 30fps pulse 节流拦截,否则飞入残影会滞留 1-2 帧(ccreview C 修复)。
  if (
    shouldSkipThrottledPulseFrame({
      hasConverge,
      wasFlyFrame: baseFrameKeyRef.current === "fly",
      pulseSize: pulseRef.current.size,
      sinceLastPaintMs: timestamp - lastPaintTimeRef.current,
      intervalMs: pulseDrawIntervalMs,
    })
  ) {
    return { painted: false, pulseFrame: false };
  }
  const staticKey = `${options.baseCacheKey}|${pulseRef.current.size}|${hasConverge ? "fly" : "base"}`;
  if (!hasConverge && pulseRef.current.size === 0 && staticFrameKeyRef.current === staticKey) {
    return { painted: false, pulseFrame: false };
  }

  const pulseCtx = ensureCanvasContext(pulseCanvas, options);
  const baseCtx = ensureCanvasContext(baseCanvas, options);
  if (!pulseCtx || !baseCtx) {
    return { painted: false, pulseFrame: false };
  }
  staticFrameKeyRef.current = staticKey;
  lastPaintTimeRef.current = timestamp;

  resetPhysicalCanvas(pulseCtx, options);

  if (converge) {
    if (baseFrameKeyRef.current !== "fly") {
      resetPhysicalCanvas(baseCtx, options);
      baseFrameKeyRef.current = "fly";
    }
    drawConvergeScene(pulseCtx, layout, options, pulseRef.current, converge, timestamp);
  } else {
    if (baseFrameKeyRef.current !== options.baseCacheKey) {
      resetPhysicalCanvas(baseCtx, options);
      const baseCache = ensureBaseCache(baseCacheRef, layout, options, onBaseCacheBaked);
      baseCtx.drawImage(baseCache.canvas, 0, 0);
      baseFrameKeyRef.current = options.baseCacheKey;
    }
    pulseCtx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
    drawActivePulses(pulseCtx, layout, options, pulseRef.current, timestamp);
  }
  return { painted: true, pulseFrame };
}

function drawConvergeScene(
  ctx: CanvasRenderingContext2D,
  layout: HanziMatrixLayout,
  options: DrawOptions,
  pulses: Map<number, HanziPulseState>,
  converge: ConvergeState,
  timestamp: number,
): void {
  ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
  if (timestamp > converge.maxEndTime) {
    return;
  }

  for (const cell of layout.cells) {
    const item = converge.itemsByIndex.get(cell.index);
    if (!item) {
      drawNormalCell(ctx, cell, options, pulses.get(cell.index), timestamp);
      continue;
    }

    const elapsed = timestamp - converge.startTime - item.delayMs;
    if (elapsed < 0) {
      drawNormalCell(ctx, cell, options, pulses.get(cell.index), timestamp);
      continue;
    }
    if (elapsed > item.durationMs) {
      continue;
    }
    drawFlyingCell(ctx, item, options, elapsed);
  }
}

function ensureBaseCache(
  cacheRef: MutableRefObject<CanvasCache | null>,
  layout: HanziMatrixLayout,
  options: DrawOptions,
  onBaseCacheBaked: () => void,
): CanvasCache {
  const existing = cacheRef.current;
  if (existing?.key === options.baseCacheKey) {
    return existing;
  }

  cancelCanvasCacheTasks(existing);
  const canvas = existing?.canvas ?? document.createElement("canvas");
  resizeCanvas(canvas, options);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    resetPhysicalCanvas(ctx, options);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
    const baseFrame = pulseFrames(options.theme)[0]!;
    for (const cell of layout.cells) {
      const sprite = getGlyphSprite(cell.ch, 0, baseFrame, options);
      drawSprite(ctx, sprite, cell.x, cell.y, 1);
    }
  }

  const cache: CanvasCache = {
    canvas,
    centerBlurBaked: options.maskBlur <= 0,
    key: options.baseCacheKey,
  };
  cacheRef.current = cache;
  if (ctx && options.maskBlur > 0) {
    scheduleCenterBlurBake(cacheRef, cache, ctx, options, onBaseCacheBaked);
  }
  if (ctx) {
    scheduleGlyphSpritePreheat(cacheRef, cache, options);
  }
  return cache;
}

function scheduleCenterBlurBake(
  cacheRef: MutableRefObject<CanvasCache | null>,
  cache: CanvasCache,
  ctx: CanvasRenderingContext2D,
  options: DrawOptions,
  onBaseCacheBaked: () => void,
): void {
  const bakeOptions = { ...options };
  const pending = scheduleIdleTask(() => {
    cache.pendingCenterBlurBake = undefined;
    if (cacheRef.current !== cache || cache.centerBlurBaked) {
      return;
    }
    bakeCenterBlurIntoBaseCache(cache.canvas, ctx, bakeOptions);
    if (cacheRef.current !== cache) {
      return;
    }
    cache.centerBlurBaked = true;
    onBaseCacheBaked();
  });
  cache.pendingCenterBlurBake = pending;
}

function cancelPendingCenterBlurBake(cache: CanvasCache | null | undefined): void {
  cache?.pendingCenterBlurBake?.cancel();
  if (cache) {
    cache.pendingCenterBlurBake = undefined;
  }
}

function cancelPendingGlyphSpritePreheat(cache: CanvasCache | null | undefined): void {
  cache?.pendingGlyphSpritePreheat?.cancel();
  if (cache) {
    cache.pendingGlyphSpritePreheat = undefined;
  }
}

function cancelCanvasCacheTasks(cache: CanvasCache | null | undefined): void {
  cancelPendingCenterBlurBake(cache);
  cancelPendingGlyphSpritePreheat(cache);
}

function scheduleGlyphSpritePreheat(
  cacheRef: MutableRefObject<CanvasCache | null>,
  cache: CanvasCache,
  options: DrawOptions,
): void {
  cancelPendingGlyphSpritePreheat(cache);
  const chars = uniqueChars(options.poolChars);
  if (chars.length === 0) {
    return;
  }

  const frames = pulseFrames(options.theme);
  const preheatOptions = { ...options };
  const frameCount = frames.length + 1;
  let cancelled = false;
  let charIndex = 0;
  let frameIndex = 0;
  let scheduled: PendingIdleTask | null = null;

  const task: PendingIdleTask = {
    cancel: () => {
      cancelled = true;
      scheduled?.cancel();
      scheduled = null;
      if (cache.pendingGlyphSpritePreheat === task) {
        cache.pendingGlyphSpritePreheat = undefined;
      }
    },
  };

  function finish() {
    scheduled = null;
    if (cache.pendingGlyphSpritePreheat === task) {
      cache.pendingGlyphSpritePreheat = undefined;
    }
  }

  function preheatOne(ch: string, index: number) {
    if (index < frames.length) {
      getGlyphSprite(ch, index, frames[index]!, preheatOptions);
      return;
    }
    getFlyingGlowSprite(ch, preheatOptions);
  }

  function runChunk() {
    scheduled = null;
    if (cancelled || cacheRef.current !== cache) {
      finish();
      return;
    }

    let count = 0;
    while (charIndex < chars.length && count < GLYPH_PREHEAT_CHUNK_SIZE) {
      preheatOne(chars[charIndex]!, frameIndex);
      count += 1;
      frameIndex += 1;
      if (frameIndex >= frameCount) {
        frameIndex = 0;
        charIndex += 1;
      }
    }

    if (charIndex >= chars.length) {
      finish();
      return;
    }
    scheduled = scheduleIdleTask(runChunk);
  }

  cache.pendingGlyphSpritePreheat = task;
  scheduled = scheduleIdleTask(runChunk);
}

function scheduleIdleTask(callback: () => void): PendingIdleTask {
  if (typeof window === "undefined") {
    return { cancel: () => undefined };
  }
  const win = window as typeof window & {
    cancelIdleCallback?: (handle: number) => void;
    requestIdleCallback?: (cb: () => void) => number;
  };
  if (win.requestIdleCallback) {
    const handle = win.requestIdleCallback(callback);
    return {
      cancel: () => win.cancelIdleCallback?.(handle),
    };
  }
  const handle = window.setTimeout(callback, CENTER_BLUR_BAKE_FALLBACK_MS);
  return {
    cancel: () => window.clearTimeout(handle),
  };
}

function bakeCenterBlurIntoBaseCache(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  options: DrawOptions,
): void {
  if (options.maskBlur <= 0) {
    return;
  }

  const maskCanvas = createCenterBlurMaskCanvas(canvas.width, canvas.height, options);
  const blurredCanvas = createBlurredBaseCanvas(canvas, options);
  if (!maskCanvas || !blurredCanvas) {
    return;
  }

  const blurredCtx = blurredCanvas.getContext("2d");
  if (!blurredCtx) {
    return;
  }
  blurredCtx.save();
  blurredCtx.setTransform(1, 0, 0, 1, 0, 0);
  blurredCtx.globalCompositeOperation = "destination-in";
  blurredCtx.drawImage(maskCanvas, 0, 0);
  blurredCtx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(blurredCanvas, 0, 0);
  ctx.restore();
}

function createBlurredBaseCanvas(
  source: HTMLCanvasElement,
  options: DrawOptions,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.filter = `blur(${options.maskBlur * options.dpr}px)`;
  ctx.drawImage(source, 0, 0);
  ctx.filter = "none";
  ctx.restore();
  return canvas;
}

function createCenterBlurMaskCanvas(
  width: number,
  height: number,
  options: DrawOptions,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const geometry = createHanziCenterBlurMaskGeometry({
    height,
    maskHeight: options.maskHeight,
    maskWidth: options.maskWidth,
    width,
  });

  ctx.save();
  ctx.translate(geometry.centerX, geometry.centerY);
  ctx.scale(geometry.radiusX, geometry.radiusY);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(geometry.solidStop, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(geometry.transparentStop, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
  return canvas;
}

function drawActivePulses(
  ctx: CanvasRenderingContext2D,
  layout: HanziMatrixLayout,
  options: DrawOptions,
  pulses: Map<number, HanziPulseState>,
  timestamp: number,
): void {
  for (const pulse of pulses.values()) {
    const cell = layout.cells[pulse.index];
    if (!cell) {
      continue;
    }
    drawPulseCell(ctx, cell, options, pulse, timestamp);
  }
}

function drawNormalCell(
  ctx: CanvasRenderingContext2D,
  cell: HanziMatrixCellSnapshot,
  options: DrawOptions,
  pulse: HanziPulseState | undefined,
  timestamp: number,
): void {
  if (pulse) {
    drawPulseCell(ctx, cell, options, pulse, timestamp);
    return;
  }

  const baseFrame = pulseFrames(options.theme)[0]!;
  drawSprite(ctx, getGlyphSprite(cell.ch, 0, baseFrame, options), cell.x, cell.y, 1);
}

function drawPulseCell(
  ctx: CanvasRenderingContext2D,
  cell: HanziMatrixCellSnapshot,
  options: DrawOptions,
  pulse: HanziPulseState,
  timestamp: number,
): void {
  const progress = clamp01((timestamp - pulse.startTime) / pulse.durationMs);
  const frames = pulseFrames(options.theme);
  let leftIndex = 0;
  let rightIndex = frames.length - 1;
  for (let i = 1; i < frames.length; i += 1) {
    if (progress <= frames[i]!.t) {
      leftIndex = i - 1;
      rightIndex = i;
      break;
    }
  }

  const left = frames[leftIndex]!;
  const right = frames[rightIndex]!;
  const span = Math.max(0.0001, right.t - left.t);
  const localT = cubicBezierValue(...PULSE_EASE, clamp01((progress - left.t) / span));
  const leftSprite = getGlyphSprite(cell.ch, leftIndex, left, options);
  const rightSprite = getGlyphSprite(cell.ch, rightIndex, right, options);

  drawSprite(ctx, leftSprite, cell.x, cell.y, 1 - localT);
  if (rightIndex !== leftIndex && localT > 0) {
    drawSprite(ctx, rightSprite, cell.x, cell.y, localT);
  }
}

function drawFlyingCell(
  ctx: CanvasRenderingContext2D,
  item: HanziMatrixConvergeItem,
  options: DrawOptions,
  elapsed: number,
): void {
  const transformT = cubicBezierValue(...FLY_TRANSFORM_EASE, clamp01(elapsed / item.durationMs));
  const opacityT = cubicBezierValue(...FLY_OPACITY_EASE, clamp01(elapsed / item.durationMs));
  const colorT = cubicBezierValue(...FLY_COLOR_EASE, clamp01(elapsed / 300));
  const x = item.cell.x + (item.tx - item.cell.x) * transformT;
  const y = item.cell.y + (item.ty - item.cell.y) * transformT;
  const fill = mixColor(options.theme.base, options.theme.peak, colorT);
  const alpha = Math.max(0, 1 - opacityT);
  const rotationDeg = item.rotationDeg * transformT;
  const scale = 1 + (item.scaleEnd - 1) * transformT;

  drawTransformedSprite(ctx, getFlyingGlowSprite(item.cell.ch, options), x, y, alpha * clamp01(fill.a), rotationDeg, scale);
  drawTransformedSprite(ctx, getFlyingFillSprite(item.cell.ch, fill, options), x, y, alpha, rotationDeg, scale);
}

function pulseFrames(theme: DrawTheme): PulseFrame[] {
  return [
    { fill: theme.base, shadows: [{ blur: BASE_SHADOW_BLUR, color: theme.baseGlow }], t: 0 },
    { fill: theme.hi1, shadows: [{ blur: 10, color: theme.hi1 }, { blur: 15, color: theme.hi1 }], t: 0.3 },
    { fill: theme.hi2, shadows: [{ blur: 10, color: theme.hi2 }, { blur: 15, color: theme.hi2 }], t: 0.5 },
    {
      fill: theme.peak,
      shadows: [
        { blur: 10, color: theme.peak },
        { blur: 15, color: theme.peak },
        { blur: 20, color: theme.peak },
      ],
      t: 0.7,
    },
    { fill: theme.base, shadows: [{ blur: BASE_SHADOW_BLUR, color: theme.baseGlow }], t: 1 },
  ];
}

function getGlyphSprite(
  ch: string,
  frameIndex: number,
  frame: PulseFrame,
  options: DrawOptions,
): GlyphSprite {
  const key = `${options.spriteCacheKey}|${frameIndex}|${ch}`;
  const cached = glyphSpriteCache.get(key);
  if (cached) {
    return cached;
  }

  if (glyphSpriteCache.size > MAX_GLYPH_SPRITES) {
    glyphSpriteCache.clear();
  }

  const maxBlur = frame.shadows.reduce((currentMax, shadow) => Math.max(currentMax, shadow.blur), 0);
  const cssSize = Math.ceil(options.fontSize + maxBlur * 2 + 28);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(cssSize * options.dpr));
  canvas.height = Math.max(1, Math.ceil(cssSize * options.dpr));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
    drawGlyph(ctx, {
      alpha: 1,
      ch,
      fill: frame.fill,
      font: fontString(options),
      rotationDeg: 0,
      scale: 1,
      shadows: frame.shadows,
      x: cssSize / 2,
      y: cssSize / 2,
    });
  }

  const sprite = { canvas, cssSize };
  glyphSpriteCache.set(key, sprite);
  return sprite;
}

function getFlyingGlowSprite(
  ch: string,
  options: DrawOptions,
): GlyphSprite {
  const key = `${options.spriteCacheKey}|fly-glow|${ch}`;
  const cached = glyphSpriteCache.get(key);
  if (cached) {
    return cached;
  }

  if (glyphSpriteCache.size > MAX_GLYPH_SPRITES) {
    glyphSpriteCache.clear();
  }

  const maxBlur = 16;
  const cssSize = Math.ceil(options.fontSize + maxBlur * 2 + 28);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(cssSize * options.dpr));
  canvas.height = Math.max(1, Math.ceil(cssSize * options.dpr));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
    drawGlyphGlowOnly(ctx, {
      ch,
      font: fontString(options),
      shadowOffset: cssSize,
      shadows: [
        { blur: 8, color: options.theme.flyGlow },
        { blur: 16, color: options.theme.flyGlow },
      ],
      x: cssSize / 2,
      y: cssSize / 2,
    });
  }

  const sprite = { canvas, cssSize };
  glyphSpriteCache.set(key, sprite);
  return sprite;
}

function getFlyingFillSprite(
  ch: string,
  fill: Rgba,
  options: DrawOptions,
): GlyphSprite {
  const fillCss = rgbaToCss(fill);
  const key = `${options.spriteCacheKey}|fly-fill|${fillCss}|${ch}`;
  const cached = flyFillSpriteCache.get(key);
  if (cached) {
    return cached;
  }

  if (flyFillSpriteCache.size > MAX_FLY_FILL_SPRITES) {
    flyFillSpriteCache.clear();
  }

  const cssSize = Math.ceil(options.fontSize + 28);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(cssSize * options.dpr));
  canvas.height = Math.max(1, Math.ceil(cssSize * options.dpr));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
    drawGlyph(ctx, {
      alpha: 1,
      ch,
      fill,
      font: fontString(options),
      rotationDeg: 0,
      scale: 1,
      shadows: [],
      x: cssSize / 2,
      y: cssSize / 2,
    });
  }

  const sprite = { canvas, cssSize };
  flyFillSpriteCache.set(key, sprite);
  return sprite;
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: GlyphSprite,
  x: number,
  y: number,
  alpha: number,
): void {
  if (alpha <= 0) {
    return;
  }

  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * alpha;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.drawImage(
    sprite.canvas,
    x - sprite.cssSize / 2,
    y - sprite.cssSize / 2,
    sprite.cssSize,
    sprite.cssSize,
  );
  ctx.globalAlpha = previousAlpha;
}

function drawTransformedSprite(
  ctx: CanvasRenderingContext2D,
  sprite: GlyphSprite,
  x: number,
  y: number,
  alpha: number,
  rotationDeg: number,
  scale: number,
): void {
  if (alpha <= 0) {
    return;
  }

  ctx.save();
  ctx.translate(x, y);
  if (rotationDeg !== 0) {
    ctx.rotate((rotationDeg * Math.PI) / 180);
  }
  if (scale !== 1) {
    ctx.scale(scale, scale);
  }
  drawSprite(ctx, sprite, 0, 0, alpha);
  ctx.restore();
}

function drawGlyphGlowOnly(
  ctx: CanvasRenderingContext2D,
  input: {
    ch: string;
    font: string;
    shadowOffset: number;
    shadows: { blur: number; color: Rgba }[];
    x: number;
    y: number;
  },
): void {
  ctx.save();
  ctx.translate(input.x, input.y);
  ctx.font = input.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255, 255, 255, 1)";
  for (const shadow of input.shadows) {
    ctx.shadowBlur = shadow.blur;
    ctx.shadowColor = rgbaToCss(shadow.color);
    ctx.shadowOffsetX = input.shadowOffset;
    ctx.shadowOffsetY = 0;
    ctx.fillText(input.ch, -input.shadowOffset, 0);
  }
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.restore();
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  input: {
    alpha: number;
    ch: string;
    fill: Rgba;
    font: string;
    rotationDeg: number;
    scale: number;
    shadows: { blur: number; color: Rgba }[];
    x: number;
    y: number;
  },
): void {
  if (input.alpha <= 0) {
    return;
  }

  ctx.save();
  ctx.translate(input.x, input.y);
  if (input.rotationDeg !== 0) {
    ctx.rotate((input.rotationDeg * Math.PI) / 180);
  }
  if (input.scale !== 1) {
    ctx.scale(input.scale, input.scale);
  }
  ctx.globalAlpha *= input.alpha;
  ctx.font = input.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const fill = rgbaToCss(input.fill);
  if (input.shadows.length === 1) {
    const shadow = input.shadows[0]!;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowColor = rgbaToCss(shadow.color);
    ctx.fillStyle = fill;
    ctx.fillText(input.ch, 0, 0);
    ctx.restore();
    return;
  }

  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = fill;
  ctx.fillText(input.ch, 0, 0);

  ctx.globalCompositeOperation = "destination-over";
  for (const shadow of input.shadows) {
    ctx.shadowBlur = shadow.blur;
    ctx.shadowColor = rgbaToCss(shadow.color);
    ctx.fillStyle = fill;
    ctx.fillText(input.ch, 0, 0);
  }
  ctx.globalCompositeOperation = "source-over";

  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.filter = "none";
  ctx.restore();
}

function ensureCanvasContext(
  canvas: HTMLCanvasElement,
  options: DrawOptions,
): CanvasRenderingContext2D | null {
  resizeCanvas(canvas, options);
  return canvas.getContext("2d");
}

function resizeCanvas(canvas: HTMLCanvasElement, options: DrawOptions): void {
  const physicalWidth = Math.max(1, Math.ceil(options.width * options.dpr));
  const physicalHeight = Math.max(1, Math.ceil(options.height * options.dpr));
  if (canvas.width !== physicalWidth) {
    canvas.width = physicalWidth;
  }
  if (canvas.height !== physicalHeight) {
    canvas.height = physicalHeight;
  }
  const cssWidth = `${options.width}px`;
  const cssHeight = `${options.height}px`;
  if (canvas.style.width !== cssWidth) {
    canvas.style.width = cssWidth;
  }
  if (canvas.style.height !== cssHeight) {
    canvas.style.height = cssHeight;
  }
}

function resetPhysicalCanvas(ctx: CanvasRenderingContext2D, options: DrawOptions): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowBlur = 0;
  ctx.clearRect(0, 0, Math.ceil(options.width * options.dpr), Math.ceil(options.height * options.dpr));
}

function pruneExpiredPulses(pulses: Map<number, HanziPulseState>, now: number): void {
  for (const [index, pulse] of pulses) {
    if (now - pulse.startTime >= pulse.durationMs) {
      pulses.delete(index);
    }
  }
}

function readCanvasFontFamily(canvas: HTMLCanvasElement): string {
  const computed = window.getComputedStyle(canvas);
  return computed.fontFamily || "serif";
}

function readDevicePixelRatio(): number {
  return Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
}

function uniqueChars(chars: string): string[] {
  return Array.from(new Set(Array.from(chars)));
}

function fontString(options: DrawOptions): string {
  return `${options.fontSize}px ${options.fontFamily}`;
}

function parseRgb(rgb: string, alpha: number): Rgba {
  const [r = 0, g = 0, b = 0] = rgb.split(",").map((part) => Number(part.trim()));
  return { a: alpha, b, g, r };
}

function rgbaToCss(color: Rgba): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${clamp01(color.a)})`;
}

function mix(left: number, right: number, t: number): number {
  return left + (right - left) * t;
}

function mixColor(left: Rgba, right: Rgba, t: number): Rgba {
  return {
    a: mix(left.a, right.a, t),
    b: mix(left.b, right.b, t),
    g: mix(left.g, right.g, t),
    r: mix(left.r, right.r, t),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cubicBezierValue(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const target = clamp01(x);
  let t = target;
  for (let i = 0; i < 5; i += 1) {
    const currentX = sampleBezier(t, x1, x2);
    const slope = sampleBezierDerivative(t, x1, x2);
    if (Math.abs(currentX - target) < 0.0001 || slope === 0) {
      break;
    }
    t -= (currentX - target) / slope;
    t = clamp01(t);
  }
  return sampleBezier(t, y1, y2);
}

function sampleBezier(t: number, p1: number, p2: number): number {
  const invT = 1 - t;
  return 3 * invT * invT * t * p1 + 3 * invT * t * t * p2 + t * t * t;
}

function sampleBezierDerivative(t: number, p1: number, p2: number): number {
  const invT = 1 - t;
  return 3 * invT * invT * p1 + 6 * invT * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

function hashSeed(seed: HanziMatrixSeed): number {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash || 1;
}
