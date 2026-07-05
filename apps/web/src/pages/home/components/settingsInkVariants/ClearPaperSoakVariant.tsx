import { useEffect, useRef } from "react";
import type { CSSProperties, JSX } from "react";
import {
  createSettingsInkRaf,
  shouldReduceSettingsInkMotion,
  useSettingsInkPerfTier,
} from "./runtimeGuards";

export interface SettingsInkVariantProps {
  active: boolean;
  onRevealDone: () => void;
}

interface CanvasState {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

interface FiberPoint {
  angle: number;
  rough: number;
  tooth: number;
  delay: number;
}

interface AttachedMark {
  angle: number;
  distance: number;
  radiusX: number;
  radiusY: number;
  rotate: number;
  delay: number;
  seed: number;
}

const REVEAL_MS = 900;
const EDGE_COUNT = 184;

const canvasStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  pointerEvents: "none",
};

const EDGE_POINTS: FiberPoint[] = Array.from({ length: EDGE_COUNT }, (_, index) => {
  const angle = (index / EDGE_COUNT) * Math.PI * 2;
  return {
    angle,
    rough: seeded(index * 13 + 3) - 0.5,
    tooth: seeded(index * 29 + 11) - 0.5,
    delay:
      0.08 +
      Math.max(0, Math.sin(angle * 2.1 + 0.4)) * 0.07 +
      Math.max(0, Math.cos(angle * 3.2 - 0.6)) * 0.05,
  };
});

const ATTACHED_MARKS: AttachedMark[] = [
  { angle: -2.64, distance: 1.015, radiusX: 0.026, radiusY: 0.01, rotate: -0.18, delay: 0.58, seed: 5 },
  { angle: -1.18, distance: 1.018, radiusX: 0.02, radiusY: 0.009, rotate: 0.32, delay: 0.66, seed: 8 },
  { angle: -0.32, distance: 1.02, radiusX: 0.028, radiusY: 0.012, rotate: -0.06, delay: 0.52, seed: 13 },
  { angle: 0.22, distance: 1.018, radiusX: 0.024, radiusY: 0.011, rotate: 0.08, delay: 0.56, seed: 21 },
  { angle: 1.36, distance: 1.012, radiusX: 0.019, radiusY: 0.008, rotate: -0.24, delay: 0.62, seed: 34 },
  { angle: 2.58, distance: 1.016, radiusX: 0.022, radiusY: 0.009, rotate: 0.18, delay: 0.64, seed: 55 },
];

function seeded(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 4.1414) * 43758.5453123;
  return value - Math.floor(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOutQuart(value: number): number {
  const p = clamp01(value);
  return 1 - (1 - p) ** 4;
}

function smoothStep(value: number): number {
  const p = clamp01(value);
  return p * p * (3 - 2 * p);
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

function traceSoakedPaper(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
  scale = 1,
): void {
  const cx = width * 0.5;
  const cy = height * 0.515;
  const radiusX = width * 0.392 * scale;
  const radiusY = height * 0.345 * scale;
  const points: Array<{ x: number; y: number }> = [];

  for (const point of EDGE_POINTS) {
    const local = easeOutQuart((progress - point.delay) / Math.max(0.18, 1 - point.delay));
    const paperTooth =
      Math.sin(point.angle * 3.2 + point.tooth * 2.8) * 0.036 +
      Math.sin(point.angle * 6.8 - point.rough * 4.2) * 0.02 +
      Math.sin(point.angle * 15.0 + point.tooth * 5.4) * 0.007 +
      point.rough * 0.018;
    const capillary =
      Math.max(0, Math.sin(point.angle * 5.0 + point.tooth * 4.6)) * 0.025 * Math.sin(local * Math.PI);
    const reach = (0.055 + local * 0.945) * (1 + paperTooth + capillary);
    const x = cx + Math.cos(point.angle) * radiusX * reach;
    const y = cy + Math.sin(point.angle) * radiusY * reach;

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

function addUnevenMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotate: number,
  seed: number,
): void {
  const count = 16;
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);

  ctx.beginPath();
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const wobble =
      1 +
      Math.sin(angle * 4 + seed) * 0.09 +
      Math.sin(angle * 9 - seed * 0.4) * 0.045 +
      (seeded(seed + index * 17) - 0.5) * 0.08;
    const localX = Math.cos(angle) * rx * wobble;
    const localY = Math.sin(angle) * ry * wobble;
    const x = cx + localX * cos - localY * sin;
    const y = cy + localX * sin + localY * cos;

    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawFiberRim(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
): void {
  const cx = width * 0.5;
  const cy = height * 0.515;
  const rx = width * 0.392;
  const ry = height * 0.345;
  const base = Math.min(width, height);
  const show = smoothStep((progress - 0.5) / 0.34);
  if (show <= 0) return;

  ctx.save();
  ctx.strokeStyle = "rgba(5, 6, 5, 0.9)";
  ctx.lineWidth = Math.max(1, base * 0.001);
  ctx.lineCap = "round";

  for (let index = 0; index < 30; index += 1) {
    const t = index / 29;
    const angle = -Math.PI + t * Math.PI * 2 + (seeded(index + 91) - 0.5) * 0.025;
    const length = base * (0.007 + seeded(index * 7 + 12) * 0.014) * show;
    const rootX = cx + Math.cos(angle) * rx * (0.982 + seeded(index + 2) * 0.02);
    const rootY = cy + Math.sin(angle) * ry * (0.982 + seeded(index + 3) * 0.02);
    const direction = angle + (seeded(index * 3 + 7) - 0.5) * 0.44;

    ctx.beginPath();
    ctx.moveTo(rootX, rootY);
    ctx.lineTo(rootX + Math.cos(direction) * length, rootY + Math.sin(direction) * length * 0.7);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(2, 3, 2, 0.97)";
  for (const mark of ATTACHED_MARKS) {
    const local = smoothStep((progress - mark.delay) / Math.max(0.18, 1 - mark.delay));
    if (local <= 0) continue;

    const x = cx + Math.cos(mark.angle) * rx * mark.distance;
    const y = cy + Math.sin(mark.angle) * ry * mark.distance;
    const markRx = base * mark.radiusX * (0.5 + local * 0.5);
    const markRy = base * mark.radiusY * (0.5 + local * 0.5);

    addUnevenMark(ctx, x, y, markRx, markRy, mark.angle + mark.rotate, mark.seed);
    ctx.fill();
  }

  ctx.restore();
}

function drawFrame(canvas: HTMLCanvasElement, progress: number): void {
  const state = prepareCanvas(canvas);
  if (!state) return;

  const { ctx, width, height } = state;
  const eased = easeOutQuart(progress);

  ctx.save();
  traceSoakedPaper(ctx, width, height, eased);
  const body = ctx.createLinearGradient(width * 0.2, height * 0.22, width * 0.82, height * 0.76);
  body.addColorStop(0, "rgba(12, 13, 11, 0.99)");
  body.addColorStop(0.44, "rgba(7, 8, 7, 1)");
  body.addColorStop(0.76, "rgba(4, 5, 4, 1)");
  body.addColorStop(1, "rgba(2, 3, 2, 1)");
  ctx.fillStyle = body;
  ctx.fill();

  traceSoakedPaper(ctx, width, height, eased, 0.975);
  ctx.clip();

  const absorbed = ctx.createLinearGradient(width * 0.25, height * 0.25, width * 0.75, height * 0.72);
  absorbed.addColorStop(0, "rgba(30, 31, 25, 0.1)");
  absorbed.addColorStop(0.38, "rgba(1, 2, 2, 0.18)");
  absorbed.addColorStop(0.7, "rgba(17, 18, 15, 0.08)");
  absorbed.addColorStop(1, "rgba(0, 0, 0, 0.2)");
  ctx.fillStyle = absorbed;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  ctx.save();
  traceSoakedPaper(ctx, width, height, eased, 1.004);
  ctx.strokeStyle = "rgba(1, 2, 2, 0.92)";
  ctx.lineWidth = Math.max(1, Math.min(width, height) * 0.003);
  ctx.stroke();
  ctx.restore();

  drawFiberRim(ctx, width, height, eased);
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function ClearPaperSoakVariant({ active, onRevealDone }: SettingsInkVariantProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRevealDoneRef = useRef(onRevealDone);
  const perfTier = useSettingsInkPerfTier();

  useEffect(() => {
    onRevealDoneRef.current = onRevealDone;
  }, [onRevealDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let loop: ReturnType<typeof createSettingsInkRaf> | null = null;
    let stopped = false;
    let done = false;

    const finish = () => {
      if (done || stopped) return;
      done = true;
      onRevealDoneRef.current();
    };

    if (!active) {
      clearCanvas(canvas);
      return undefined;
    }

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

    return () => {
      stopped = true;
      loop?.stop();
    };
  }, [active, perfTier]);

  return <canvas ref={canvasRef} aria-hidden="true" style={canvasStyle} />;
}
