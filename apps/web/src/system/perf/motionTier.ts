import { useEffect, useState } from "react";

export type PerfTier = "high" | "low";

export interface PerfTierProbeInput {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  search?: string;
}

type PerfTierListener = (tier: PerfTier) => void;

const LOW_TIER_DEVICE_MEMORY_GB = 4;
const LOW_TIER_HARDWARE_CONCURRENCY = 4;

let initialized = false;
let currentTier: PerfTier = "high";
const listeners = new Set<PerfTierListener>();

export function detectPerfTier(input: PerfTierProbeInput): PerfTier {
  const forcedTier = readForcedMotionTier(input.search ?? "");
  if (forcedTier) {
    return forcedTier;
  }

  if (
    typeof input.deviceMemory === "number" &&
    Number.isFinite(input.deviceMemory) &&
    input.deviceMemory <= LOW_TIER_DEVICE_MEMORY_GB
  ) {
    return "low";
  }

  if (
    typeof input.hardwareConcurrency === "number" &&
    Number.isFinite(input.hardwareConcurrency) &&
    input.hardwareConcurrency <= LOW_TIER_HARDWARE_CONCURRENCY
  ) {
    return "low";
  }

  return "high";
}

export function initPerfTier(): PerfTier {
  currentTier = detectPerfTier(readRuntimeProbeInput());
  initialized = true;
  applyPerfTierDataset(currentTier);
  notifyPerfTierListeners(currentTier);
  return currentTier;
}

export function getPerfTier(): PerfTier {
  if (!initialized && typeof window !== "undefined") {
    return initPerfTier();
  }
  return currentTier;
}

/**
 * 仅供测试:重置本模块的模块级单例状态(initialized/currentTier/listeners)。
 * 模块级单例在 vitest 共享 worker 内会跨文件/跨测试存活——前序测试把档位锁成 low、
 * listener 残留,会让后续测试拿到泄漏值(HanziMatrix 即因此 CI 满载并行确定性红)。
 * 在 setupFiles 的全局 afterEach 统一调用,保证每个测试从干净状态开始。
 */
export function resetPerfTierForTest(): void {
  initialized = false;
  currentTier = "high";
  listeners.clear();
}

export function usePerfTier(): PerfTier {
  const [tier, setTier] = useState<PerfTier>(() => getPerfTier());

  useEffect(() => {
    setTier(getPerfTier());
    listeners.add(setTier);
    return () => {
      listeners.delete(setTier);
    };
  }, []);

  return tier;
}

function readForcedMotionTier(search: string): PerfTier | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get("motionTier");
  if (value === "low" || value === "high") {
    return value;
  }
  return null;
}

function readRuntimeProbeInput(): PerfTierProbeInput {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {};
  }

  const nav = navigator as Navigator & {
    deviceMemory?: unknown;
    hardwareConcurrency?: unknown;
  };

  return {
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === "number"
        ? nav.hardwareConcurrency
        : undefined,
    search: window.location.search,
  };
}

function applyPerfTierDataset(tier: PerfTier): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.perf = tier;
}

function notifyPerfTierListeners(tier: PerfTier): void {
  listeners.forEach((listener) => listener(tier));
}
