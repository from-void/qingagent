// 改动B 审批入场("逐处打字"标记入场 + 全文光标特效)运行时可调参数。
// 与 presentationRuntimeConfig(全文/diff 原生应用动效)同构:模块级 store + localStorage
// 持久化 + 订阅,但作用于只读审批态的 reveal 调度,互不干扰。
export interface RevealPresentationRuntimeConfig {
  /** 同时"打字"的改动处数 = 并发光标数(打字头数)。 */
  concurrency: number;
  /** 相邻两拍之间的间隔(ms),越小越快(逐字打字节拍)。 */
  stepDelayMs: number;
  /** 每一拍每个打字头吐出的字符数,越大越快。 */
  charsPerTick: number;
  /** 全部打完后,末批光标停留多久再熄灭并升起审批条(ms)。 */
  tailHoldMs: number;
  /** 是否开启发光特效(右栏环境辉光 + 入场柔化)。 */
  glow: boolean;
}

export interface RevealPresentationConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const REVEAL_PRESENTATION_CONFIG_STORAGE_KEY =
  "qingagent:reveal-presentation-config";

export const MIN_REVEAL_CONCURRENCY = 1;
export const DEFAULT_REVEAL_CONCURRENCY = 5;
export const MAX_REVEAL_CONCURRENCY = 6;
export const MIN_REVEAL_STEP_DELAY_MS = 20;
export const DEFAULT_REVEAL_STEP_DELAY_MS = 20;
export const MAX_REVEAL_STEP_DELAY_MS = 200;
export const MIN_REVEAL_CHARS_PER_TICK = 1;
export const DEFAULT_REVEAL_CHARS_PER_TICK = 1;
export const MAX_REVEAL_CHARS_PER_TICK = 8;
export const MIN_REVEAL_TAIL_HOLD_MS = 0;
export const DEFAULT_REVEAL_TAIL_HOLD_MS = 390;
export const MAX_REVEAL_TAIL_HOLD_MS = 1500;

export const DEFAULT_REVEAL_PRESENTATION_CONFIG: RevealPresentationRuntimeConfig = {
  concurrency: DEFAULT_REVEAL_CONCURRENCY,
  stepDelayMs: DEFAULT_REVEAL_STEP_DELAY_MS,
  charsPerTick: DEFAULT_REVEAL_CHARS_PER_TICK,
  tailHoldMs: DEFAULT_REVEAL_TAIL_HOLD_MS,
  glow: true,
};

type RevealPresentationConfigListener = (
  config: RevealPresentationRuntimeConfig,
) => void;

declare global {
  interface Window {
    __qingagentRevealConfig?: RevealPresentationRuntimeConfig;
    __qingagentSetRevealConfig?: (
      patch: Partial<RevealPresentationRuntimeConfig>,
    ) => RevealPresentationRuntimeConfig;
  }
}

let hydrated = false;
let currentConfig = DEFAULT_REVEAL_PRESENTATION_CONFIG;
const listeners = new Set<RevealPresentationConfigListener>();

export function getRevealPresentationConfig(): RevealPresentationRuntimeConfig {
  hydrateRevealPresentationConfig();
  publishRevealPresentationConfig(currentConfig);
  return currentConfig;
}

export function setRevealPresentationConfig(
  patch: Partial<RevealPresentationRuntimeConfig>,
  storage: RevealPresentationConfigStorage | null = getRevealPresentationStorage(),
): RevealPresentationRuntimeConfig {
  hydrateRevealPresentationConfig();
  currentConfig = sanitizeRevealPresentationConfig({
    ...currentConfig,
    ...patch,
  });
  writeRevealPresentationConfig(currentConfig, storage);
  publishRevealPresentationConfig(currentConfig);
  for (const listener of listeners) listener(currentConfig);
  return currentConfig;
}

export function subscribeRevealPresentationConfig(
  listener: RevealPresentationConfigListener,
): () => void {
  hydrateRevealPresentationConfig();
  listeners.add(listener);
  listener(currentConfig);
  return () => listeners.delete(listener);
}

export function readRevealPresentationConfig(
  storage: RevealPresentationConfigStorage | null = getRevealPresentationStorage(),
): RevealPresentationRuntimeConfig {
  if (!storage) return DEFAULT_REVEAL_PRESENTATION_CONFIG;
  const raw = storage.getItem(REVEAL_PRESENTATION_CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_REVEAL_PRESENTATION_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<RevealPresentationRuntimeConfig>;
    return sanitizeRevealPresentationConfig({
      ...DEFAULT_REVEAL_PRESENTATION_CONFIG,
      ...parsed,
    });
  } catch {
    return DEFAULT_REVEAL_PRESENTATION_CONFIG;
  }
}

export function writeRevealPresentationConfig(
  config: RevealPresentationRuntimeConfig,
  storage: RevealPresentationConfigStorage | null = getRevealPresentationStorage(),
): void {
  if (!storage) return;
  storage.setItem(
    REVEAL_PRESENTATION_CONFIG_STORAGE_KEY,
    JSON.stringify(sanitizeRevealPresentationConfig(config)),
  );
}

export function sanitizeRevealPresentationConfig(
  config: Partial<RevealPresentationRuntimeConfig>,
): RevealPresentationRuntimeConfig {
  return {
    concurrency: clampInt(
      numberOrDefault(config.concurrency, DEFAULT_REVEAL_CONCURRENCY),
      MIN_REVEAL_CONCURRENCY,
      MAX_REVEAL_CONCURRENCY,
    ),
    stepDelayMs: clampInt(
      numberOrDefault(config.stepDelayMs, DEFAULT_REVEAL_STEP_DELAY_MS),
      MIN_REVEAL_STEP_DELAY_MS,
      MAX_REVEAL_STEP_DELAY_MS,
    ),
    charsPerTick: clampInt(
      numberOrDefault(config.charsPerTick, DEFAULT_REVEAL_CHARS_PER_TICK),
      MIN_REVEAL_CHARS_PER_TICK,
      MAX_REVEAL_CHARS_PER_TICK,
    ),
    tailHoldMs: clampInt(
      numberOrDefault(config.tailHoldMs, DEFAULT_REVEAL_TAIL_HOLD_MS),
      MIN_REVEAL_TAIL_HOLD_MS,
      MAX_REVEAL_TAIL_HOLD_MS,
    ),
    glow: typeof config.glow === "boolean" ? config.glow : true,
  };
}

export function resetRevealPresentationConfigForTest(
  next: Partial<RevealPresentationRuntimeConfig> = {},
  storage: RevealPresentationConfigStorage | null = getRevealPresentationStorage(),
): RevealPresentationRuntimeConfig {
  hydrated = true;
  currentConfig = sanitizeRevealPresentationConfig({
    ...DEFAULT_REVEAL_PRESENTATION_CONFIG,
    ...next,
  });
  if (storage) {
    storage.removeItem(REVEAL_PRESENTATION_CONFIG_STORAGE_KEY);
    writeRevealPresentationConfig(currentConfig, storage);
  }
  publishRevealPresentationConfig(currentConfig);
  for (const listener of listeners) listener(currentConfig);
  return currentConfig;
}

function hydrateRevealPresentationConfig(): void {
  if (hydrated) return;
  hydrated = true;
  currentConfig = readRevealPresentationConfig();
}

function publishRevealPresentationConfig(
  config: RevealPresentationRuntimeConfig,
): void {
  if (typeof window === "undefined") return;
  window.__qingagentRevealConfig = config;
  window.__qingagentSetRevealConfig = setRevealPresentationConfig;
}

function getRevealPresentationStorage(): RevealPresentationConfigStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
