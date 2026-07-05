export interface NativePresentationRuntimeConfig {
  agentCount: number;
  stepDelayMs: number;
  chunkSize: number;
  maxDurationMs: number;
  speedScale: number;
}

export interface NativePresentationConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const NATIVE_PRESENTATION_CONFIG_STORAGE_KEY =
  // v2: 默认改为 maxDurationMs 9500 / speedScale 1.4。换 key 让旧版手动调参留下的
  // 慢配置(如 30000/2.65)失效，返回用户直接吃新默认，无需手动清 localStorage。
  "qingagent:native-presentation-config-v2";

export const MIN_STEP_DELAY_MS = 18;
export const DEFAULT_STEP_DELAY_MS = 34;
export const MAX_STEP_DELAY_MS = 240;
export const MIN_NATIVE_AGENT_COUNT = 3;
export const DEFAULT_NATIVE_AGENT_COUNT = 5;
export const MAX_NATIVE_AGENT_COUNT = 6;
export const DEFAULT_NATIVE_CHUNK_SIZE = 1;
export const MIN_NATIVE_CHUNK_SIZE = 1;
export const MAX_NATIVE_CHUNK_SIZE = 512;
export const DEFAULT_NATIVE_MAX_DURATION_MS = 9500;
export const MIN_NATIVE_MAX_DURATION_MS = 1000;
export const MAX_NATIVE_MAX_DURATION_MS = 60000;
export const DEFAULT_NATIVE_SPEED_SCALE = 1.4;
export const MIN_NATIVE_SPEED_SCALE = 0.25;
export const MAX_NATIVE_SPEED_SCALE = 4;

export const DEFAULT_NATIVE_PRESENTATION_CONFIG: NativePresentationRuntimeConfig = {
  agentCount: DEFAULT_NATIVE_AGENT_COUNT,
  stepDelayMs: DEFAULT_STEP_DELAY_MS,
  chunkSize: DEFAULT_NATIVE_CHUNK_SIZE,
  maxDurationMs: DEFAULT_NATIVE_MAX_DURATION_MS,
  speedScale: DEFAULT_NATIVE_SPEED_SCALE,
};

type NativePresentationConfigListener = (
  config: NativePresentationRuntimeConfig,
) => void;

declare global {
  interface Window {
    __qingagentPresentationConfig?: NativePresentationRuntimeConfig;
    __qingagentSetPresentationConfig?: (
      patch: Partial<NativePresentationRuntimeConfig>,
    ) => NativePresentationRuntimeConfig;
  }
}

let hydrated = false;
let currentConfig = DEFAULT_NATIVE_PRESENTATION_CONFIG;
const listeners = new Set<NativePresentationConfigListener>();

export function getNativePresentationConfig(): NativePresentationRuntimeConfig {
  hydrateNativePresentationConfig();
  publishNativePresentationConfig(currentConfig);
  return currentConfig;
}

export function setNativePresentationConfig(
  patch: Partial<NativePresentationRuntimeConfig>,
  storage: NativePresentationConfigStorage | null = getNativePresentationStorage(),
): NativePresentationRuntimeConfig {
  hydrateNativePresentationConfig();
  currentConfig = sanitizeNativePresentationConfig({
    ...currentConfig,
    ...patch,
  });
  writeNativePresentationConfig(currentConfig, storage);
  publishNativePresentationConfig(currentConfig);
  for (const listener of listeners) listener(currentConfig);
  return currentConfig;
}

export function subscribeNativePresentationConfig(
  listener: NativePresentationConfigListener,
): () => void {
  hydrateNativePresentationConfig();
  listeners.add(listener);
  listener(currentConfig);
  return () => listeners.delete(listener);
}

export function readNativePresentationConfig(
  storage: NativePresentationConfigStorage | null = getNativePresentationStorage(),
): NativePresentationRuntimeConfig {
  if (!storage) return DEFAULT_NATIVE_PRESENTATION_CONFIG;
  const raw = storage.getItem(NATIVE_PRESENTATION_CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_NATIVE_PRESENTATION_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<NativePresentationRuntimeConfig>;
    return sanitizeNativePresentationConfig({
      ...DEFAULT_NATIVE_PRESENTATION_CONFIG,
      ...parsed,
    });
  } catch {
    return DEFAULT_NATIVE_PRESENTATION_CONFIG;
  }
}

export function writeNativePresentationConfig(
  config: NativePresentationRuntimeConfig,
  storage: NativePresentationConfigStorage | null = getNativePresentationStorage(),
): void {
  if (!storage) return;
  storage.setItem(
    NATIVE_PRESENTATION_CONFIG_STORAGE_KEY,
    JSON.stringify(sanitizeNativePresentationConfig(config)),
  );
}

export function sanitizeNativePresentationConfig(
  config: Partial<NativePresentationRuntimeConfig>,
): NativePresentationRuntimeConfig {
  return {
    agentCount: clampInt(
      numberOrDefault(config.agentCount, DEFAULT_NATIVE_AGENT_COUNT),
      MIN_NATIVE_AGENT_COUNT,
      MAX_NATIVE_AGENT_COUNT,
    ),
    stepDelayMs: clampInt(
      numberOrDefault(config.stepDelayMs, DEFAULT_STEP_DELAY_MS),
      MIN_STEP_DELAY_MS,
      MAX_STEP_DELAY_MS,
    ),
    chunkSize: clampInt(
      numberOrDefault(config.chunkSize, DEFAULT_NATIVE_CHUNK_SIZE),
      MIN_NATIVE_CHUNK_SIZE,
      MAX_NATIVE_CHUNK_SIZE,
    ),
    maxDurationMs: clampInt(
      numberOrDefault(config.maxDurationMs, DEFAULT_NATIVE_MAX_DURATION_MS),
      MIN_NATIVE_MAX_DURATION_MS,
      MAX_NATIVE_MAX_DURATION_MS,
    ),
    speedScale: clampNumber(
      numberOrDefault(config.speedScale, DEFAULT_NATIVE_SPEED_SCALE),
      MIN_NATIVE_SPEED_SCALE,
      MAX_NATIVE_SPEED_SCALE,
    ),
  };
}

export function resolveNativeStepDelayMs(
  config: NativePresentationRuntimeConfig = getNativePresentationConfig(),
): number {
  return Math.max(
    MIN_STEP_DELAY_MS,
    Math.round(config.stepDelayMs * config.speedScale),
  );
}

export function resetNativePresentationConfigForTest(
  next: Partial<NativePresentationRuntimeConfig> = {},
  storage: NativePresentationConfigStorage | null = getNativePresentationStorage(),
): NativePresentationRuntimeConfig {
  hydrated = true;
  currentConfig = sanitizeNativePresentationConfig({
    ...DEFAULT_NATIVE_PRESENTATION_CONFIG,
    ...next,
  });
  if (storage) {
    storage.removeItem(NATIVE_PRESENTATION_CONFIG_STORAGE_KEY);
    writeNativePresentationConfig(currentConfig, storage);
  }
  publishNativePresentationConfig(currentConfig);
  for (const listener of listeners) listener(currentConfig);
  return currentConfig;
}

function hydrateNativePresentationConfig(): void {
  if (hydrated) return;
  hydrated = true;
  currentConfig = readNativePresentationConfig();
}

function publishNativePresentationConfig(
  config: NativePresentationRuntimeConfig,
): void {
  if (typeof window === "undefined") return;
  window.__qingagentPresentationConfig = config;
  window.__qingagentSetPresentationConfig = setNativePresentationConfig;
}

function getNativePresentationStorage(): NativePresentationConfigStorage | null {
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
