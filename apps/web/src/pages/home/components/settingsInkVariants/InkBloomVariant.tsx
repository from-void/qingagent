import { useEffect, useRef } from "react";
import type { JSX } from "react";
import {
  createSettingsInkRaf,
  shouldReduceSettingsInkMotion,
  useSettingsInkPerfTier,
} from "./runtimeGuards";

export interface SettingsInkVariantProps {
  active: boolean;
  onRevealDone: () => void;
}

const REVEAL_MS = 820;
const POINT_COUNT = 160;

interface EdgePoint {
  angle: number;
  wobble: number;
  secondary: number;
}

interface AttachedSplash {
  angle: number;
  reach: number;
  radius: number;
  stretch: number;
  delay: number;
  seed: number;
}

interface WashLayer {
  scaleX: number;
  scaleY: number;
  driftX: number;
  driftY: number;
  alpha: number;
  tint: "cold" | "warm" | "deep";
  seed: number;
}

function random(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453123;
  return value - Math.floor(value);
}

const EDGE_POINTS: EdgePoint[] = Array.from({ length: POINT_COUNT }, (_, index) => ({
  angle: (index / POINT_COUNT) * Math.PI * 2,
  wobble: random(index + 4) - 0.5,
  secondary: random(index * 3 + 17) - 0.5,
}));

const ATTACHED_SPLASHES: AttachedSplash[] = [
  { angle: -0.52, reach: 0.965, radius: 0.021, stretch: 1.75, delay: 0.46, seed: 13 },
  { angle: 0.12, reach: 0.958, radius: 0.017, stretch: 1.9, delay: 0.52, seed: 34 },
  { angle: 1.42, reach: 0.96, radius: 0.015, stretch: 1.8, delay: 0.62, seed: 89 },
  { angle: 2.56, reach: 0.955, radius: 0.017, stretch: 1.7, delay: 0.56, seed: 233 },
  { angle: -2.42, reach: 0.958, radius: 0.014, stretch: 1.65, delay: 0.6, seed: 377 },
];

const WASH_TINTS: Array<WashLayer["tint"]> = ["cold", "warm", "deep"];

const WASH_LAYERS: WashLayer[] = Array.from({ length: 22 }, (_, index) => ({
  scaleX: 0.72 + random(index * 13 + 3) * 0.38,
  scaleY: 0.68 + random(index * 17 + 5) * 0.34,
  driftX: (random(index * 19 + 7) - 0.5) * 0.09,
  driftY: (random(index * 23 + 11) - 0.5) * 0.08,
  alpha: 0.018 + random(index * 29 + 13) * 0.034,
  tint: WASH_TINTS[index % WASH_TINTS.length] ?? "deep",
  seed: index * 37 + 101,
}));

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function directionalBump(angle: number, target: number, power: number, amount: number): number {
  return Math.pow(Math.max(0, Math.cos(angle - target)), power) * amount;
}

function inkTone(tint: WashLayer["tint"], alpha: number): string {
  if (tint === "cold") return `rgba(24, 39, 36, ${alpha})`;
  if (tint === "warm") return `rgba(53, 43, 29, ${alpha})`;
  return `rgba(0, 0, 0, ${alpha * 1.28})`;
}

function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const displayWidth = Math.max(1, Math.round(rect.width * dpr));
  const displayHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  return {
    width: displayWidth / dpr,
    height: displayHeight / dpr,
    dpr,
  };
}

function addInkPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  progress: number,
  scale = 1,
): void {
  const points = EDGE_POINTS.map((point) => {
    const delay =
      0.16 *
      (0.5 +
        Math.sin(point.angle * 1.7 + point.secondary * 3.2) * 0.32 +
        Math.sin(point.angle * 3.1 + point.wobble * 2.4) * 0.18);
    const local = easeOutCubic(clamp01((progress - delay) / Math.max(0.18, 1 - delay)));
    const wave =
      Math.sin(point.angle * 1.6 + local * 2.4) * 0.12 +
      Math.sin(point.angle * 3.2 - local * 1.35) * 0.078 +
      Math.sin(point.angle * 6.0 + local * 0.72) * 0.034 +
      Math.sin(point.angle * 13.0 + local * 2.1 + point.wobble * 5.8) * 0.014 +
      Math.sin(point.angle * 21.0 - local * 1.7 + point.secondary * 3.5) * 0.007 +
      directionalBump(point.angle, -0.55, 10, 0.2) +
      directionalBump(point.angle, -2.55, 11, 0.12) +
      directionalBump(point.angle, 0.02, 12, 0.045) +
      point.wobble * 0.035 +
      point.secondary * 0.025 * Math.sin(local * Math.PI);
    const reach = scale * (0.055 + local * 0.945) * (0.95 + wave);
    return {
      x: cx + Math.cos(point.angle) * radiusX * reach,
      y: cy + Math.sin(point.angle) * radiusY * reach,
    };
  });

  ctx.beginPath();
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const midX = (point.x + next.x) * 0.5;
    const midY = (point.y + next.y) * 0.5;
    if (index === 0) {
      ctx.moveTo(midX, midY);
    } else {
      ctx.quadraticCurveTo(point.x, point.y, midX, midY);
    }
  });
  ctx.closePath();
}

function addRoughEllipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  angle: number,
  seed: number,
): void {
  const count = 24;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  ctx.beginPath();
  for (let index = 0; index < count; index += 1) {
    const theta = (index / count) * Math.PI * 2;
    const jitter =
      1 +
      Math.sin(theta * 3 + seed) * 0.13 +
      Math.sin(theta * 7 - seed * 0.7) * 0.065 +
      (random(seed + index * 9) - 0.5) * 0.13;
    const localX = Math.cos(theta) * radiusX * jitter;
    const localY = Math.sin(theta) * radiusY * jitter;
    const x = cx + localX * cos - localY * sin;
    const y = cy + localX * sin + localY * cos;

    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function addWashLayerPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  progress: number,
  layer: WashLayer,
): void {
  const count = 96;
  const eased = easeOutCubic(progress);
  const points: Array<{ x: number; y: number }> = [];
  const layerCx = cx + radiusX * layer.driftX * eased;
  const layerCy = cy + radiusY * layer.driftY * eased;

  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const localSeed = layer.seed + index * 0.71;
    const liquid =
      Math.sin(angle * 1.7 + layer.seed * 0.13 + progress * 2.2) * 0.09 +
      Math.sin(angle * 3.9 - layer.seed * 0.08 - progress * 1.4) * 0.052 +
      Math.sin(angle * 8.6 + localSeed) * 0.018 +
      (random(localSeed * 9.1) - 0.5) * 0.04;
    const x = layerCx + Math.cos(angle) * radiusX * layer.scaleX * eased * (1 + liquid);
    const y = layerCy + Math.sin(angle) * radiusY * layer.scaleY * eased * (1 + liquid * 0.8);
    points.push({ x, y });
  }

  ctx.beginPath();
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const midX = (point.x + next.x) * 0.5;
    const midY = (point.y + next.y) * 0.5;
    if (index === 0) ctx.moveTo(midX, midY);
    else ctx.quadraticCurveTo(point.x, point.y, midX, midY);
  });
  ctx.closePath();
}

function drawLayeredWash(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  progress: number,
): void {
  ctx.save();
  WASH_LAYERS.forEach((layer, index) => {
    const layerProgress = easeOutCubic(clamp01((progress - index * 0.006) / 0.92));
    if (layerProgress <= 0) return;

    addWashLayerPath(ctx, cx, cy, radiusX, radiusY, layerProgress, layer);
    ctx.fillStyle = inkTone(layer.tint, layer.alpha * (0.35 + layerProgress * 0.65));
    ctx.fill();
  });
  ctx.restore();
}

function drawPaperGrain(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
): void {
  const alpha = easeOutCubic(progress);
  const diagonalCount = 30;

  ctx.save();
  ctx.lineCap = "butt";
  ctx.globalAlpha = 0.18 * alpha;

  for (let index = 0; index < diagonalCount; index += 1) {
    const t = index / diagonalCount;
    const y = height * (0.16 + t * 0.72) + Math.sin(index * 1.9) * 10;
    const x1 = width * (0.18 + random(index + 33) * 0.12);
    const x2 = width * (0.82 - random(index + 66) * 0.12);
    const bend = (random(index + 99) - 0.5) * height * 0.07;

    ctx.strokeStyle =
      index % 3 === 0
        ? "rgba(62, 74, 64, 0.18)"
        : index % 3 === 1
          ? "rgba(36, 44, 40, 0.16)"
          : "rgba(91, 70, 43, 0.1)";
    ctx.lineWidth = 0.45 + random(index + 112) * 0.85;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.bezierCurveTo(
      width * 0.36,
      y + bend,
      width * 0.62,
      y - bend * 0.7,
      x2,
      y + Math.sin(index * 2.7) * 6,
    );
    ctx.stroke();
  }

  ctx.globalAlpha = 0.09 * alpha;
  ctx.fillStyle = "rgba(230, 222, 198, 0.5)";
  for (let index = 0; index < 110; index += 1) {
    const x = width * (0.15 + random(index * 5 + 7) * 0.7);
    const y = height * (0.12 + random(index * 7 + 9) * 0.76);
    const w = 0.5 + random(index * 11 + 3) * 1.4;
    const h = 0.35 + random(index * 13 + 5) * 1.1;
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();
}

function drawEdgeFray(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  progress: number,
): void {
  const visible = easeOutCubic(clamp01((progress - 0.38) / 0.62));
  if (visible <= 0) return;

  ctx.save();
  ctx.strokeStyle = `rgba(2, 3, 3, ${0.32 * visible})`;
  ctx.lineCap = "round";

  for (let index = 0; index < 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2 + (random(index + 701) - 0.5) * 0.1;
    const normalX = Math.cos(angle);
    const normalY = Math.sin(angle);
    const tangentX = -normalY;
    const tangentY = normalX;
    const baseReach = 0.982 + random(index + 715) * 0.042;
    const startX = cx + normalX * radiusX * baseReach;
    const startY = cy + normalY * radiusY * baseReach;
    const length = Math.min(radiusX, radiusY) * (0.005 + random(index + 733) * 0.016);
    const lean = (random(index + 751) - 0.5) * length * 0.9;

    ctx.lineWidth = 0.45 + random(index + 769) * 0.85;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX + normalX * length + tangentX * lean, startY + normalY * length + tangentY * lean);
    ctx.stroke();
  }

  ctx.restore();
}

function drawAttachedSplashes(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  progress: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(1, 2, 3, 0.98)";

  ATTACHED_SPLASHES.forEach((splash) => {
    const local = easeOutCubic(clamp01((progress - splash.delay) / Math.max(0.16, 1 - splash.delay)));
    if (local <= 0) return;

    const flow = 0.92 + local * 0.12;
    const x = cx + Math.cos(splash.angle) * radiusX * splash.reach * flow;
    const y = cy + Math.sin(splash.angle) * radiusY * splash.reach * flow;
    const size = Math.min(radiusX, radiusY) * splash.radius * (0.26 + local * 0.74);
    const tangent = splash.angle + Math.PI * 0.5 + Math.sin(splash.seed) * 0.22;

    addRoughEllipse(ctx, x, y, size * splash.stretch, size, tangent, splash.seed);
    ctx.fill();
  });

  ctx.restore();
}

function drawBloom(canvas: HTMLCanvasElement, progress: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height, dpr } = resizeCanvas(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width * 0.5;
  const cy = height * 0.5;
  const radiusX = width * 0.398;
  const radiusY = height * 0.375;
  const wet = Math.sin(Math.min(1, progress) * Math.PI);

  ctx.save();
  addInkPath(ctx, cx, cy, radiusX, radiusY, progress);
  const body = ctx.createRadialGradient(cx, cy, Math.min(radiusX, radiusY) * 0.02, cx, cy, Math.max(radiusX, radiusY));
  body.addColorStop(0, "rgba(13, 19, 18, 1)");
  body.addColorStop(0.34, "rgba(5, 9, 9, 1)");
  body.addColorStop(0.72, "rgba(2, 5, 5, 1)");
  body.addColorStop(1, "rgba(0, 1, 1, 1)");
  ctx.fillStyle = body;
  ctx.fill();
  addInkPath(ctx, cx, cy, radiusX, radiusY, progress);
  ctx.clip();

  drawLayeredWash(ctx, cx, cy, radiusX, radiusY, progress);

  const wash = ctx.createRadialGradient(cx, cy, Math.min(radiusX, radiusY) * 0.18, cx, cy, Math.max(radiusX, radiusY));
  wash.addColorStop(0, `rgba(42, 55, 48, ${0.075 + wet * 0.025})`);
  wash.addColorStop(0.46, "rgba(11, 18, 16, 0.07)");
  wash.addColorStop(0.72, "rgba(56, 42, 24, 0.035)");
  wash.addColorStop(1, "rgba(0, 0, 0, 0.18)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  ctx.restore();
  drawEdgeFray(ctx, cx, cy, radiusX, radiusY, progress);
  drawAttachedSplashes(ctx, cx, cy, radiusX, radiusY, progress);
}

export function InkBloomVariant(props: SettingsInkVariantProps): JSX.Element {
  const { active, onRevealDone } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRevealDoneRef = useRef(onRevealDone);
  const perfTier = useSettingsInkPerfTier();

  useEffect(() => {
    onRevealDoneRef.current = onRevealDone;
  }, [onRevealDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let loop: ReturnType<typeof createSettingsInkRaf> | null = null;
    let disposed = false;
    let done = false;

    const finish = () => {
      if (done || disposed) return;
      done = true;
      onRevealDoneRef.current();
    };

    if (!active) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    if (shouldReduceSettingsInkMotion(perfTier)) {
      drawBloom(canvas, 1);
      queueMicrotask(finish);
      return () => {
        disposed = true;
      };
    }

    const startedAt = performance.now();
    const frame = (now: number) => {
      if (disposed) return false;

      const progress = Math.min(1, (now - startedAt) / REVEAL_MS);
      drawBloom(canvas, progress);

      if (progress >= 1) {
        finish();
        return false;
      }

      return true;
    };

    loop = createSettingsInkRaf(frame, canvas);

    return () => {
      disposed = true;
      loop?.stop();
    };
  }, [active, perfTier]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        display: "block",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: active ? 1 : 0,
      }}
    />
  );
}
