import { useEffect, useRef, type CSSProperties, type JSX } from "react";
import {
  createSettingsInkRaf,
  shouldReduceSettingsInkMotion,
  useSettingsInkPerfTier,
} from "./runtimeGuards";
import type { SettingsInkVariantProps } from "./types";

type ExtraBump = {
  angle: number;
  amount: number;
  power: number;
};

type SplashSpec = {
  angle: number;
  reach: number;
  size: number;
  stretch: number;
  delay: number;
};

type OrganicInkConfig = {
  duration: number;
  seed: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  pointCount: number;
  longWave: number;
  midWave: number;
  shortWave: number;
  hair: number;
  angularSpeed: number;
  delayStrength: number;
  rightTopLift: number;
  edgeAlpha: number;
  smooth: boolean;
  inkStops: [string, string, string];
  bumps: ExtraBump[];
  splashes: SplashSpec[];
  streaks: number;
};

const CANVAS_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  pointerEvents: "none",
};

const SAFE_INK_SCALE = 0.86;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOutCubic(value: number): number {
  const p = clamp01(value);
  return 1 - (1 - p) ** 3;
}

function easeOutQuart(value: number): number {
  const p = clamp01(value);
  return 1 - (1 - p) ** 4;
}

function seeded(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453123;
  return value - Math.floor(value);
}

function bump(angle: number, target: number, power: number, amount: number): number {
  return Math.pow(Math.max(0, Math.cos(angle - target)), power) * amount;
}

function prepareCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
} | null {
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
  return { ctx, width, height, dpr };
}

function createInkPoints(
  config: OrganicInkConfig,
  width: number,
  height: number,
  progress: number,
): Array<{ x: number; y: number; angle: number; reach: number }> {
  const points: Array<{ x: number; y: number; angle: number; reach: number }> = [];
  const cx = width * 0.5;
  const cy = height * config.centerY;
  const radiusX = width * config.radiusX * SAFE_INK_SCALE;
  const radiusY = height * config.radiusY * SAFE_INK_SCALE;
  const settled = easeOutQuart(progress);

  for (let index = 0; index < config.pointCount; index += 1) {
    const angle = (index / config.pointCount) * Math.PI * 2;
    const noiseSeed = config.seed + index * 0.73;
    const delay =
      config.delayStrength *
      (0.48 +
        Math.sin(angle * 1.35 + config.seed) * 0.3 +
        Math.sin(angle * 3.05 - config.seed * 0.4) * 0.17);
    const local = easeOutQuart((progress - delay) / Math.max(0.14, 1 - delay));
    const liquid =
      Math.sin(angle * 1.8 + local * config.angularSpeed + config.seed) * config.longWave +
      Math.sin(angle * 3.9 - local * (config.angularSpeed * 0.58) + config.seed * 0.37) * config.midWave +
      Math.sin(angle * 7.8 + local * 1.2 + noiseSeed) * config.shortWave;
    const hair =
      Math.sin(angle * 15.5 + local * 2.6 + noiseSeed * 2.4) * config.hair +
      Math.sin(angle * 27.0 - local * 1.9 + noiseSeed) * config.hair * 0.48;
    const lifts = config.bumps.reduce(
      (sum, item) => sum + bump(angle, item.angle, item.power, item.amount),
      bump(angle, -0.55, 10, config.rightTopLift),
    );
    const randomEdge = (seeded(noiseSeed * 10.1) - 0.5) * config.hair * 1.15 * settled;
    const reach = (0.035 + local * 0.965) * (0.96 + liquid + hair + lifts + randomEdge);

    points.push({
      x: cx + Math.cos(angle) * radiusX * reach,
      y: cy + Math.sin(angle) * radiusY * reach,
      angle,
      reach,
    });
  }

  return points;
}

function drawPointPath(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, smooth: boolean): void {
  ctx.beginPath();

  if (!smooth) {
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    return;
  }

  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const midX = (point.x + next.x) * 0.5;
    const midY = (point.y + next.y) * 0.5;
    if (index === 0) ctx.moveTo(midX, midY);
    else ctx.quadraticCurveTo(point.x, point.y, midX, midY);
  });
  ctx.closePath();
}

function addRoughBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  angle: number,
  seed: number,
): void {
  const count = 20;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  ctx.beginPath();
  for (let index = 0; index < count; index += 1) {
    const theta = (index / count) * Math.PI * 2;
    const jitter =
      1 +
      Math.sin(theta * 3 + seed) * 0.16 +
      Math.sin(theta * 8 - seed * 0.6) * 0.08 +
      (seeded(seed + index * 4.7) - 0.5) * 0.14;
    const localX = Math.cos(theta) * radiusX * jitter;
    const localY = Math.sin(theta) * radiusY * jitter;
    const x = cx + localX * cos - localY * sin;
    const y = cy + localX * sin + localY * cos;

    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawSplashes(
  ctx: CanvasRenderingContext2D,
  config: OrganicInkConfig,
  width: number,
  height: number,
  progress: number,
): void {
  const cx = width * 0.5;
  const cy = height * config.centerY;
  const radiusX = width * config.radiusX * SAFE_INK_SCALE;
  const radiusY = height * config.radiusY * SAFE_INK_SCALE;
  const baseSize = Math.min(radiusX, radiusY);

  ctx.save();
  ctx.fillStyle = `rgba(1, 2, 3, ${0.94 * easeOutCubic(progress)})`;

  config.splashes.forEach((splash, index) => {
    const local = easeOutCubic((progress - splash.delay) / Math.max(0.14, 1 - splash.delay));
    if (local <= 0) return;

    const drift = 0.92 + local * 0.12;
    const x = cx + Math.cos(splash.angle) * radiusX * splash.reach * drift;
    const y = cy + Math.sin(splash.angle) * radiusY * splash.reach * drift;
    const radius = baseSize * splash.size * (0.2 + local * 0.8);
    const tangent = splash.angle + Math.PI * 0.5 + (seeded(config.seed + index) - 0.5) * 0.5;

    addRoughBlob(ctx, x, y, radius * splash.stretch, radius, tangent, config.seed + index * 11);
    ctx.fill();
  });

  ctx.restore();
}

function drawStreaks(
  ctx: CanvasRenderingContext2D,
  config: OrganicInkConfig,
  width: number,
  height: number,
  progress: number,
): void {
  if (config.streaks <= 0 || progress < 0.55) return;

  const cx = width * 0.5;
  const cy = height * config.centerY;
  const radiusX = width * config.radiusX * SAFE_INK_SCALE;
  const radiusY = height * config.radiusY * SAFE_INK_SCALE;
  const alpha = (progress - 0.55) / 0.45;

  ctx.save();
  ctx.globalAlpha = 0.1 * alpha;
  ctx.strokeStyle = "rgba(36, 42, 39, 0.72)";
  ctx.lineWidth = Math.max(1, Math.min(width, height) * 0.0028);

  for (let index = 0; index < config.streaks; index += 1) {
    const t = index / Math.max(1, config.streaks - 1);
    const angle = -2.45 + t * 4.9 + Math.sin(config.seed + index) * 0.12;
    const start = 0.16 + seeded(config.seed + index * 3) * 0.12;
    const end = 0.68 + seeded(config.seed + index * 9) * 0.2;

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radiusX * start, cy + Math.sin(angle) * radiusY * start);
    ctx.bezierCurveTo(
      cx + Math.cos(angle + 0.22) * radiusX * 0.38,
      cy + Math.sin(angle + 0.22) * radiusY * 0.34,
      cx + Math.cos(angle - 0.18) * radiusX * 0.54,
      cy + Math.sin(angle - 0.18) * radiusY * 0.52,
      cx + Math.cos(angle) * radiusX * end,
      cy + Math.sin(angle) * radiusY * end,
    );
    ctx.stroke();
  }

  ctx.restore();
}

function drawOrganicInk(canvas: HTMLCanvasElement, config: OrganicInkConfig, progress: number): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;

  const { ctx, width, height } = prepared;
  const cx = width * 0.5;
  const cy = height * config.centerY;
  const radius = Math.max(width * config.radiusX, height * config.radiusY) * SAFE_INK_SCALE * 1.18;
  const eased = easeOutCubic(progress);
  const points = createInkPoints(config, width, height, progress);
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.02, cx, cy, radius);

  gradient.addColorStop(0, config.inkStops[0].replace("<a>", String(0.98 * eased)));
  gradient.addColorStop(0.58, config.inkStops[1].replace("<a>", String(0.995 * eased)));
  gradient.addColorStop(1, config.inkStops[2].replace("<a>", String(eased)));

  ctx.save();
  drawPointPath(ctx, points, config.smooth);
  ctx.fillStyle = gradient;
  ctx.fill();
  drawPointPath(ctx, points, config.smooth);
  ctx.clip();

  const tone = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  tone.addColorStop(0, `rgba(28, 34, 31, ${0.07 * eased})`);
  tone.addColorStop(0.62, `rgba(2, 4, 4, ${0.06 * eased})`);
  tone.addColorStop(1, `rgba(0, 0, 0, ${config.edgeAlpha * eased})`);
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, width, height);
  drawStreaks(ctx, config, width, height, progress);
  ctx.restore();

  drawSplashes(ctx, config, width, height, progress);
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function createOrganicInkVariant(config: OrganicInkConfig): (props: SettingsInkVariantProps) => JSX.Element {
  return function OrganicInkVariant({ active, onRevealDone }: SettingsInkVariantProps): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const onRevealDoneRef = useRef(onRevealDone);
    const perfTier = useSettingsInkPerfTier();

    useEffect(() => {
      onRevealDoneRef.current = onRevealDone;
    }, [onRevealDone]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;

      if (!active) {
        clearCanvas(canvas);
        return undefined;
      }

      let loop: ReturnType<typeof createSettingsInkRaf> | null = null;
      let done = false;
      let latestProgress = 0;
      const start = performance.now();

      const finish = () => {
        if (done) return;
        done = true;
        drawOrganicInk(canvas, config, 1);
        onRevealDoneRef.current();
      };

      const onResize = () => drawOrganicInk(canvas, config, done ? 1 : latestProgress);
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
      observer?.observe(canvas.parentElement ?? canvas);

      if (shouldReduceSettingsInkMotion(perfTier)) {
        finish();
        return () => observer?.disconnect();
      }

      const frame = (now: number) => {
        latestProgress = clamp01((now - start) / config.duration);
        drawOrganicInk(canvas, config, latestProgress);

        if (latestProgress >= 1) {
          finish();
          return false;
        }

        return true;
      };

      loop = createSettingsInkRaf(frame, canvas);
      window.addEventListener("resize", onResize);

      return () => {
        loop?.stop();
        window.removeEventListener("resize", onResize);
        observer?.disconnect();
      };
    }, [active, perfTier]);

    return <canvas ref={canvasRef} aria-hidden="true" style={CANVAS_STYLE} />;
  };
}

const INK = {
  cold: ["rgba(7, 12, 12, <a>)", "rgba(3, 6, 7, <a>)", "rgba(0, 1, 2, <a>)"] as [
    string,
    string,
    string,
  ],
  warm: ["rgba(13, 12, 9, <a>)", "rgba(5, 5, 4, <a>)", "rgba(0, 0, 0, <a>)"] as [
    string,
    string,
    string,
  ],
  dense: ["rgba(3, 5, 5, <a>)", "rgba(1, 2, 2, <a>)", "rgba(0, 0, 0, <a>)"] as [
    string,
    string,
    string,
  ],
};

const tideSplashes: SplashSpec[] = [
  { angle: -0.6, reach: 1.03, size: 0.048, stretch: 2.2, delay: 0.42 },
  { angle: -0.18, reach: 1.04, size: 0.034, stretch: 2.5, delay: 0.5 },
  { angle: 0.35, reach: 1.04, size: 0.03, stretch: 2.1, delay: 0.56 },
  { angle: 1.58, reach: 1.02, size: 0.028, stretch: 1.9, delay: 0.62 },
  { angle: 2.72, reach: 1.04, size: 0.034, stretch: 2.4, delay: 0.52 },
  { angle: -2.18, reach: 1.02, size: 0.03, stretch: 1.8, delay: 0.58 },
];

export const TideInkVariant = createOrganicInkVariant({
  duration: 900,
  seed: 2.17,
  centerY: 0.51,
  radiusX: 0.49,
  radiusY: 0.4,
  pointCount: 150,
  longWave: 0.14,
  midWave: 0.072,
  shortWave: 0.03,
  hair: 0.014,
  angularSpeed: 2.9,
  delayStrength: 0.18,
  rightTopLift: 0.18,
  edgeAlpha: 0.26,
  smooth: true,
  inkStops: INK.cold,
  bumps: [
    { angle: 2.72, amount: 0.12, power: 8 },
    { angle: 1.18, amount: 0.07, power: 10 },
  ],
  splashes: tideSplashes,
  streaks: 5,
});

export const DryFrayInkVariant = createOrganicInkVariant({
  duration: 820,
  seed: 4.91,
  centerY: 0.5,
  radiusX: 0.475,
  radiusY: 0.395,
  pointCount: 190,
  longWave: 0.09,
  midWave: 0.065,
  shortWave: 0.036,
  hair: 0.018,
  angularSpeed: 2.15,
  delayStrength: 0.14,
  rightTopLift: 0.16,
  edgeAlpha: 0.2,
  smooth: true,
  inkStops: INK.warm,
  bumps: [
    { angle: -2.75, amount: 0.1, power: 9 },
    { angle: 0.1, amount: 0.08, power: 11 },
  ],
  splashes: [
    { angle: -0.66, reach: 1.02, size: 0.034, stretch: 2.9, delay: 0.44 },
    { angle: -0.42, reach: 1.03, size: 0.022, stretch: 3.3, delay: 0.56 },
    { angle: 0.18, reach: 1.03, size: 0.024, stretch: 2.7, delay: 0.52 },
    { angle: 2.52, reach: 1.04, size: 0.026, stretch: 3.0, delay: 0.5 },
    { angle: -2.96, reach: 1.03, size: 0.024, stretch: 2.8, delay: 0.58 },
  ],
  streaks: 2,
});

export const TornEdgeInkVariant = createOrganicInkVariant({
  duration: 860,
  seed: 10.28,
  centerY: 0.505,
  radiusX: 0.485,
  radiusY: 0.402,
  pointCount: 118,
  longWave: 0.13,
  midWave: 0.088,
  shortWave: 0.032,
  hair: 0.017,
  angularSpeed: 2.35,
  delayStrength: 0.17,
  rightTopLift: 0.17,
  edgeAlpha: 0.24,
  smooth: true,
  inkStops: INK.cold,
  bumps: [
    { angle: -2.48, amount: 0.13, power: 7 },
    { angle: 1.05, amount: 0.1, power: 8 },
  ],
  splashes: [
    { angle: -0.62, reach: 1.03, size: 0.04, stretch: 2.5, delay: 0.43 },
    { angle: -0.08, reach: 1.04, size: 0.024, stretch: 2.6, delay: 0.55 },
    { angle: 0.86, reach: 1.02, size: 0.026, stretch: 2.1, delay: 0.6 },
    { angle: 2.28, reach: 1.04, size: 0.032, stretch: 2.6, delay: 0.52 },
    { angle: -2.58, reach: 1.03, size: 0.03, stretch: 2.4, delay: 0.48 },
  ],
  streaks: 1,
});

export const VeinFlowInkVariant = createOrganicInkVariant({
  duration: 980,
  seed: 12.64,
  centerY: 0.515,
  radiusX: 0.49,
  radiusY: 0.392,
  pointCount: 158,
  longWave: 0.12,
  midWave: 0.068,
  shortWave: 0.025,
  hair: 0.012,
  angularSpeed: 3.45,
  delayStrength: 0.23,
  rightTopLift: 0.18,
  edgeAlpha: 0.22,
  smooth: true,
  inkStops: INK.cold,
  bumps: [
    { angle: -2.88, amount: 0.11, power: 9 },
    { angle: 0.92, amount: 0.08, power: 10 },
  ],
  splashes: [
    { angle: -0.52, reach: 1.03, size: 0.04, stretch: 2.6, delay: 0.46 },
    { angle: 0.26, reach: 1.04, size: 0.028, stretch: 2.8, delay: 0.58 },
    { angle: 2.82, reach: 1.04, size: 0.03, stretch: 2.7, delay: 0.55 },
    { angle: -2.28, reach: 1.02, size: 0.026, stretch: 2.2, delay: 0.62 },
  ],
  streaks: 8,
});
