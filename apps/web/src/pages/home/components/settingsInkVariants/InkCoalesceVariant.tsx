import { useEffect, useRef } from "react";
import type { CSSProperties, JSX } from "react";
import {
  createSettingsInkRaf,
  shouldReduceSettingsInkMotion,
  useSettingsInkPerfTier,
} from "./runtimeGuards";
import type { SettingsInkVariantProps } from "./types";

// 墨球聚合：数枚同色墨球自外向心聚拢、彼此重叠，末了一个中心主团把它们融成一坨带浓淡的墨。
// 形态参数由调参器(ink-tuner.html)调出，半径基准换算到 .qj-sheet-ink-stage 的画布尺寸。

const REVEAL_MS = 820;
const EXIT_MS = 520; // 关闭退场时长
const EXIT_FADE_FROM = 0.5; // 墨缩散到此进度后整坨淡出
const TAU = Math.PI * 2;

// 形态参数（rX 在此换算为 width*RX_OF_WIDTH，以适配扩展画布并让有机边缘留在可见区内）
const RX_OF_WIDTH = 0.47; // 墨团横向半径 / 画布宽
const CY_RATIO = 0.488; // 墨团中心 y / 画布高（对准被扩展画布包住的 sheet 内容中心）
const P = {
  sy: 0.84,
  count: 7,
  ballRough: 1.15,
  rrBase: 0.42,
  rrSpan: 0,
  spreadK: 0.7,
  sizeBase: 0.4,
  sizeGain: 0.62,
  mainRough: 1.0,
  mainK: 0.85,
  blur: 24,
  seed: 85,
};
const TINT = ["#332b25", "#14110f", "#080706"] as const;

const canvasStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  pointerEvents: "none",
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOutCubic(value: number): number {
  return 1 - (1 - clamp01(value)) ** 3;
}

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 一圈有机半径乘子（稳定、可复现）
function makeBlob(n: number, rough: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const h1 = rnd() * TAU;
  const h2 = rnd() * TAU;
  const h3 = rnd() * TAU;
  const h4 = rnd() * TAU;
  const arr: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    arr.push(
      1 +
        Math.sin(a * 2 + h1) * 0.12 * rough +
        Math.sin(a * 3 + h2) * 0.08 * rough +
        Math.sin(a * 5 + h3) * 0.05 * rough +
        Math.sin(a * 8 + h4) * 0.03 * rough,
    );
  }
  return arr;
}

// 平滑闭合曲线描出墨形路径（squashY 压扁成横向墨团）
function pathBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  blob: number[],
  squashY: number,
): void {
  const n = blob.length;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    const rr = r * blob[i]!;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * squashY]);
  }
  const mid = (j: number): [number, number] => {
    const p0 = pts[j]!;
    const p1 = pts[(j + 1) % n]!;
    return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  };
  ctx.beginPath();
  const m0 = mid(n - 1);
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i += 1) {
    const mm = mid(i);
    ctx.quadraticCurveTo(pts[i]![0], pts[i]![1], mm[0], mm[1]);
  }
  ctx.closePath();
}

function inkFill(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const g = ctx.createRadialGradient(cx - r * 0.18, cy - r * 0.22, r * 0.08, cx, cy, r * 1.04);
  g.addColorStop(0, TINT[0]);
  g.addColorStop(0.55, TINT[1]);
  g.addColorStop(1, TINT[2]);
  ctx.fillStyle = g;
  ctx.fill();
}

// 预生成墨球与主团（seed 固定 → 形态稳定）
const rnd = mulberry32(P.seed);
const BALLS = Array.from({ length: P.count }, (_, i) => ({
  a: (i / P.count) * TAU + rnd() * 0.5,
  blob: makeBlob(40, P.ballRough, i * 13 + 3 + P.seed),
  rr: P.rrBase + rnd() * P.rrSpan,
}));
const MAIN_BLOB = makeBlob(56, P.mainRough, 99 + P.seed);

interface CanvasState {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

function prepareCanvas(canvas: HTMLCanvasElement): CanvasState | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawFrame(canvas: HTMLCanvasElement, progress: number): void {
  const state = prepareCanvas(canvas);
  if (!state) return;
  const { ctx, width, height } = state;
  const ec = easeOutCubic(progress);
  const cx = width / 2;
  const cy = height * CY_RATIO;
  const R = width * RX_OF_WIDTH;
  const sy = P.sy;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.4)";
  ctx.shadowBlur = P.blur;

  // 墨球向心聚拢（同色实心，重叠无缝）
  const spread = (1 - ec) * R * P.spreadK;
  const size = R * (P.sizeBase + ec * P.sizeGain);
  ctx.fillStyle = TINT[1];
  for (const b of BALLS) {
    const bx = cx + Math.cos(b.a) * spread;
    const by = cy + Math.sin(b.a) * spread * sy;
    pathBlob(ctx, bx, by, size * b.rr, b.blob, sy);
    ctx.fill();
  }

  // 中心主团补满 → 融为一坨带浓淡的墨
  const mr = R * ec * P.mainK;
  if (mr > 1) {
    pathBlob(ctx, cx, cy, mr, MAIN_BLOB, sy);
    inkFill(ctx, cx, cy, R * ec);
  }
  ctx.restore();
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function InkCoalesceVariant({ active, onRevealDone }: SettingsInkVariantProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRevealDoneRef = useRef(onRevealDone);
  const enteredRef = useRef(false);
  const perfTier = useSettingsInkPerfTier();

  useEffect(() => {
    onRevealDoneRef.current = onRevealDone;
  }, [onRevealDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let stopped = false;
    let loop: ReturnType<typeof createSettingsInkRaf> | null = null;
    const cancel = () => {
      stopped = true;
      loop?.stop();
    };

    if (active) {
      // 进场：墨球向心聚拢
      let done = false;
      const finish = () => {
        if (done || stopped) return;
        done = true;
        enteredRef.current = true;
        onRevealDoneRef.current();
      };
      canvas.style.opacity = "1";
      if (shouldReduceSettingsInkMotion(perfTier)) {
        drawFrame(canvas, 1);
        queueMicrotask(finish);
        return () => {
          stopped = true;
        };
      }
      const startedAt = performance.now();
      const frame = (now: number) => {
        if (stopped) return false;
        const progress = clamp01((now - startedAt) / REVEAL_MS);
        drawFrame(canvas, progress);
        if (progress >= 1) {
          finish();
          return false;
        }
        return true;
      };
      loop = createSettingsInkRaf(frame, canvas);
      return cancel;
    }

    // 关闭退场：墨球四散 + 整坨淡出（仅当此前已进场，否则直接清空）
    if (!enteredRef.current || shouldReduceSettingsInkMotion(perfTier)) {
      clearCanvas(canvas);
      return undefined;
    }
    const startedAt = performance.now();
    const frame = (now: number) => {
      if (stopped) return false;
      const e = clamp01((now - startedAt) / EXIT_MS);
      const p = 1 - e;
      drawFrame(canvas, p);
      canvas.style.opacity = String(Math.min(1, p / EXIT_FADE_FROM));
      if (e >= 1) {
        clearCanvas(canvas);
        return false;
      }
      return true;
    };
    loop = createSettingsInkRaf(frame, canvas);
    return cancel;
  }, [active, perfTier]);

  return <canvas ref={canvasRef} aria-hidden="true" style={canvasStyle} />;
}
