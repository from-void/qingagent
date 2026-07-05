// 0603 — 拟人鼠标 overlay 运行时可调参数(仿 revealPresentationConfig:模块级 store +
// localStorage 持久化 + subscribe)。数量不调(= 并发光标数,与入场面板联动)。
export interface HumanCursorRuntimeConfig {
  /** 总开关 */
  enabled: boolean;
  /** 飘移速度强度(0=不动) */
  driftSpeed: number;
  /** 手抖幅度强度 */
  jitter: number;
  /** 光标消失后鼠标淡出的延迟(ms) */
  fadeDelayMs: number;
  /** 越界边缘气泡开关 */
  edgeBubble: boolean;
}

export interface HumanCursorConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HUMAN_CURSOR_CONFIG_STORAGE_KEY = "qingagent:human-cursor-config";

export const MIN_DRIFT_SPEED = 0;
export const DEFAULT_DRIFT_SPEED = 1;
export const MAX_DRIFT_SPEED = 3;
export const MIN_JITTER = 0;
export const DEFAULT_JITTER = 1;
export const MAX_JITTER = 3;
export const MIN_FADE_DELAY_MS = 0;
export const DEFAULT_FADE_DELAY_MS = 600;
export const MAX_FADE_DELAY_MS = 3000;

export const DEFAULT_HUMAN_CURSOR_CONFIG: HumanCursorRuntimeConfig = {
  enabled: true,
  driftSpeed: DEFAULT_DRIFT_SPEED,
  jitter: DEFAULT_JITTER,
  fadeDelayMs: DEFAULT_FADE_DELAY_MS,
  edgeBubble: true,
};

type Listener = (config: HumanCursorRuntimeConfig) => void;

let hydrated = false;
let currentConfig = DEFAULT_HUMAN_CURSOR_CONFIG;
const listeners = new Set<Listener>();

export function getHumanCursorConfig(): HumanCursorRuntimeConfig {
  hydrate();
  return currentConfig;
}

export function setHumanCursorConfig(
  patch: Partial<HumanCursorRuntimeConfig>,
  storage: HumanCursorConfigStorage | null = getStorage(),
): HumanCursorRuntimeConfig {
  hydrate();
  currentConfig = sanitizeHumanCursorConfig({ ...currentConfig, ...patch });
  writeHumanCursorConfig(currentConfig, storage);
  for (const l of listeners) l(currentConfig);
  return currentConfig;
}

export function subscribeHumanCursorConfig(listener: Listener): () => void {
  hydrate();
  listeners.add(listener);
  listener(currentConfig);
  return () => listeners.delete(listener);
}

export function readHumanCursorConfig(
  storage: HumanCursorConfigStorage | null = getStorage(),
): HumanCursorRuntimeConfig {
  if (!storage) return DEFAULT_HUMAN_CURSOR_CONFIG;
  const raw = storage.getItem(HUMAN_CURSOR_CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_HUMAN_CURSOR_CONFIG;
  try {
    return sanitizeHumanCursorConfig({
      ...DEFAULT_HUMAN_CURSOR_CONFIG,
      ...(JSON.parse(raw) as Partial<HumanCursorRuntimeConfig>),
    });
  } catch {
    return DEFAULT_HUMAN_CURSOR_CONFIG;
  }
}

export function writeHumanCursorConfig(
  config: HumanCursorRuntimeConfig,
  storage: HumanCursorConfigStorage | null = getStorage(),
): void {
  if (!storage) return;
  storage.setItem(HUMAN_CURSOR_CONFIG_STORAGE_KEY, JSON.stringify(sanitizeHumanCursorConfig(config)));
}

export function sanitizeHumanCursorConfig(
  config: Partial<HumanCursorRuntimeConfig>,
): HumanCursorRuntimeConfig {
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    driftSpeed: clamp(numOr(config.driftSpeed, DEFAULT_DRIFT_SPEED), MIN_DRIFT_SPEED, MAX_DRIFT_SPEED),
    jitter: clamp(numOr(config.jitter, DEFAULT_JITTER), MIN_JITTER, MAX_JITTER),
    fadeDelayMs: clampInt(numOr(config.fadeDelayMs, DEFAULT_FADE_DELAY_MS), MIN_FADE_DELAY_MS, MAX_FADE_DELAY_MS),
    edgeBubble: typeof config.edgeBubble === "boolean" ? config.edgeBubble : true,
  };
}

export function resetHumanCursorConfigForTest(
  next: Partial<HumanCursorRuntimeConfig> = {},
  storage: HumanCursorConfigStorage | null = getStorage(),
): HumanCursorRuntimeConfig {
  hydrated = true;
  currentConfig = sanitizeHumanCursorConfig({ ...DEFAULT_HUMAN_CURSOR_CONFIG, ...next });
  if (storage) {
    storage.removeItem(HUMAN_CURSOR_CONFIG_STORAGE_KEY);
    writeHumanCursorConfig(currentConfig, storage);
  }
  for (const l of listeners) l(currentConfig);
  return currentConfig;
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  currentConfig = readHumanCursorConfig();
}

function getStorage(): HumanCursorConfigStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}
