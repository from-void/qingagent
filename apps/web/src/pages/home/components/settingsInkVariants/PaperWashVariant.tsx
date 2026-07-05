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

type WashState = {
  width: number;
  height: number;
  seed: number;
  edge: number[];
};

const DURATION_MS = 880;
const EDGE_POINTS = 176;

export function PaperWashVariant(props: SettingsInkVariantProps): JSX.Element {
  const { active, onRevealDone } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<WashState | null>(null);
  const onRevealDoneRef = useRef(onRevealDone);
  const perfTier = useSettingsInkPerfTier();

  useEffect(() => {
    onRevealDoneRef.current = onRevealDone;
  }, [onRevealDone]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    let loop: ReturnType<typeof createSettingsInkRaf> | null = null;
    let isDone = false;
    let progress = 0;

    const finish = () => {
      if (isDone) {
        return;
      }

      isDone = true;
      onRevealDoneRef.current();
    };

    const render = (nextProgress: number) => {
      progress = nextProgress;
      const prepared = prepareCanvas(canvas);

      if (!prepared) {
        return;
      }

      const { context, width, height } = prepared;
      const state = getWashState(stateRef.current, width, height);
      stateRef.current = state;
      drawPaperWash(context, state, progress);
    };

    const cleanupResize = watchCanvasSize(canvas, () => {
      render(active ? progress : 0);
    });

    if (!active) {
      clearCanvas(canvas);

      return () => {
        cleanupResize();
      };
    }

    if (shouldReduceSettingsInkMotion(perfTier)) {
      render(1);
      finish();

      return () => {
        cleanupResize();
      };
    }

    let startedAt = 0;

    const animate = (time: number) => {
      if (!startedAt) {
        startedAt = time;
      }

      const elapsed = time - startedAt;
      const nextProgress = clamp(elapsed / DURATION_MS, 0, 1);

      render(nextProgress);

      if (nextProgress >= 1) {
        finish();
        return false;
      }

      return true;
    };

    render(0);
    loop = createSettingsInkRaf(animate, canvas);

    return () => {
      loop?.stop();
      cleanupResize();
    };
  }, [active, perfTier]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}

function prepareCanvas(canvas: HTMLCanvasElement):
  | {
      context: CanvasRenderingContext2D;
      width: number;
      height: number;
    }
  | null {
  const rect = canvas.getBoundingClientRect();
  const parentRect = canvas.parentElement?.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || parentRect?.width || canvas.clientWidth || 1));
  const height = Math.max(1, Math.round(rect.height || parentRect?.height || canvas.clientHeight || 1));
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  return { context, width, height };
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function watchCanvasSize(canvas: HTMLCanvasElement, onResize: () => void): () => void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas.parentElement ?? canvas);

    return () => {
      observer.disconnect();
    };
  }

  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
  };
}

function getWashState(current: WashState | null, width: number, height: number): WashState {
  if (current && current.width === width && current.height === height) {
    return current;
  }

  const seed = Math.floor(width * 37 + height * 101 + 1327);
  const random = mulberry32(seed);
  const edge = Array.from({ length: EDGE_POINTS }, () => random() * 2 - 1);

  return {
    width,
    height,
    seed,
    edge,
  };
}

function drawPaperWash(context: CanvasRenderingContext2D, state: WashState, progress: number): void {
  const { width, height } = state;
  const eased = easeOutQuart(progress);
  const centerX = width * 0.5;
  const centerY = height * 0.505;
  const maxRadiusX = width * 0.392;
  const maxRadiusY = height * 0.348;
  const radiusX = maxRadiusX * (0.08 + eased * 0.92);
  const radiusY = maxRadiusY * (0.08 + eased * 0.92);
  const inkPath = createInkPath(state, centerX, centerY, maxRadiusX, maxRadiusY, progress);

  drawInkBody(context, inkPath, centerX, centerY, Math.max(radiusX, radiusY), eased);
}

function drawInkBody(
  context: CanvasRenderingContext2D,
  path: Path2D,
  centerX: number,
  centerY: number,
  radius: number,
  progress: number,
): void {
  const gradient = context.createRadialGradient(centerX, centerY, radius * 0.02, centerX, centerY, radius);
  gradient.addColorStop(0, `rgba(5, 5, 4, ${progress})`);
  gradient.addColorStop(0.42, `rgba(8, 8, 7, ${progress})`);
  gradient.addColorStop(0.76, `rgba(12, 11, 10, ${0.99 * progress})`);
  gradient.addColorStop(1, `rgba(17, 15, 13, ${0.97 * progress})`);

  context.save();
  context.fillStyle = gradient;
  context.fill(path);
  context.restore();
}

function createInkPath(
  state: WashState,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  progress: number,
): Path2D {
  const path = new Path2D();
  const points: Array<{ x: number; y: number }> = [];

  for (let index = 0; index < EDGE_POINTS; index += 1) {
    const edgeIndex = index % EDGE_POINTS;
    const angle = (edgeIndex / EDGE_POINTS) * Math.PI * 2;
    const edgeNoise = state.edge[edgeIndex] ?? 0;
    const delay =
      0.18 *
      (0.5 +
        Math.sin(angle * 1.3 + state.seed * 0.01) * 0.32 +
        Math.sin(angle * 2.9 + state.seed * 0.02) * 0.18);
    const local = easeOutQuart(clamp((progress - delay) / Math.max(0.18, 1 - delay), 0, 1));
    const rightTop = Math.pow(Math.max(0, Math.cos(angle + 0.55)), 10) * 0.1;
    const rightPush = Math.pow(Math.max(0, Math.cos(angle)), 12) * 0.035;
    const longWave = Math.sin(angle * 2.0 + state.seed * 0.01 + local * 1.4) * 0.096;
    const midWave = Math.sin(angle * 4.2 + state.seed * 0.018 - local * 1.1) * 0.06;
    const shortWave = Math.sin(angle * 7.0 + state.seed * 0.03 + local * 0.7) * 0.026;
    const fray =
      Math.sin(angle * 16.0 + state.seed * 0.021 + local * 2.0) * 0.013 +
      Math.sin(angle * 23.0 - state.seed * 0.017 + local * 1.2) * 0.006;
    const feather = 0.02 * edgeNoise + longWave + midWave + shortWave + fray + rightTop + rightPush;
    const reach = (0.06 + local * 0.94) * (1 + feather);
    const x = centerX + Math.cos(angle) * radiusX * reach;
    const y = centerY + Math.sin(angle) * radiusY * reach;

    points.push({ x, y });
  }

  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const midX = (point.x + next.x) * 0.5;
    const midY = (point.y + next.y) * 0.5;

    if (index === 0) path.moveTo(midX, midY);
    else path.quadraticCurveTo(point.x, point.y, midX, midY);
  });
  path.closePath();

  return path;
}

function easeOutQuart(value: number): number {
  return 1 - (1 - value) ** 4;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mulberry32(seed: number): () => number {
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
