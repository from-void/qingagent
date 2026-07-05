import { usePerfTier, type PerfTier } from "../../../../system/perf/motionTier";
import {
  createVisibilityPausedRaf,
  type VisibilitySchedulerHandle,
} from "../../../../system/perf/visibilityScheduler";

type InkRafCallback = (timestamp: DOMHighResTimeStamp) => boolean | void;

export function useSettingsInkPerfTier(): PerfTier {
  return usePerfTier();
}

export function shouldReduceSettingsInkMotion(perfTier: PerfTier): boolean {
  if (typeof window === "undefined") {
    return perfTier === "low";
  }
  return (
    perfTier === "low" ||
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

export function createSettingsInkRaf(
  callback: InkRafCallback,
  element?: Element | null,
): VisibilitySchedulerHandle {
  return createVisibilityPausedRaf(callback, { element });
}
