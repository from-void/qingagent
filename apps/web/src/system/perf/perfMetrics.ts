const FRAME_DROP_THRESHOLD_MS = 50;
const RECENT_FRAME_WINDOW_SIZE = 180;
const OVERLAY_ID = "qingagent-perf-overlay";

export const PERF_LOCAL_STORAGE_KEY = "qingagent:perf";

export interface FrameIntervalStats {
  sampleCount: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
  droppedFrameCount: number;
}

export interface LongTaskStats {
  count: number;
  total: number;
  max: number;
}

export interface SchedulerCounterSnapshot {
  rafScheduledTotal: number;
  intervalScheduledTotal: number;
}

export interface SchedulerStats {
  raf: {
    active: number;
    scheduledTotal: number;
  };
  interval: {
    active: number;
    scheduledTotal: number;
  };
}

export interface HeapSnapshot {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface WebglSnapshot {
  canvasCount: number;
  trackedContextCount: number;
  approximateCount: number;
}

export interface PerfSnapshot {
  enabled: boolean;
  scene: string | null;
  timestamp: number;
  durationMs: number;
  sampleCount: number;
  fps: number;
  p50FrameIntervalMs: number;
  p95FrameIntervalMs: number;
  maxFrameIntervalMs: number;
  droppedFrameCount: number;
  longtask: LongTaskStats;
  scheduler: SchedulerStats;
  domNodes: number;
  webgl: WebglSnapshot;
  heap: HeapSnapshot | null;
}

export interface PerfController {
  reset: () => void;
  startScene: (name: string) => void;
  endScene: () => PerfSnapshot;
  snapshot: () => PerfSnapshot;
}

interface SchedulerOriginals {
  requestAnimationFrame: typeof window.requestAnimationFrame;
  cancelAnimationFrame: typeof window.cancelAnimationFrame;
  setInterval: typeof window.setInterval;
  clearInterval: typeof window.clearInterval;
}

interface PerfInternalWindowState {
  activeRafIds: Set<number>;
  activeIntervalIds: Set<number>;
  intervalScheduledTotal: number;
  originalCanvasGetContext: HTMLCanvasElement["getContext"] | null;
  originals: SchedulerOriginals | null;
  patchedCanvasGetContext: boolean;
  patchedScheduler: boolean;
  rafScheduledTotal: number;
  webglCanvases: Set<HTMLCanvasElement>;
}

interface SceneScope {
  frameStartIndex: number;
  longTaskStartIndex: number;
  name: string;
  schedulerStart: SchedulerCounterSnapshot;
  startTime: number;
}

interface PerformanceMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

type PerformanceWithMemory = Performance & {
  memory?: Partial<PerformanceMemory>;
};

type CanvasContextResult =
  | CanvasRenderingContext2D
  | ImageBitmapRenderingContext
  | WebGLRenderingContext
  | WebGL2RenderingContext
  | null;

declare global {
  interface Window {
    __PERF__?: PerfController;
    __QINGAGENT_PERF_INTERNAL__?: PerfInternalWindowState;
  }
}

let enabled = false;
let frameIntervals: number[] = [];
let lastFrameTime: number | null = null;
let longTaskDurations: number[] = [];
let longTaskObserver: PerformanceObserver | null = null;
let overlayElement: HTMLDivElement | null = null;
let recentFrameIntervals: number[] = [];
let resetTime = 0;
let samplerRafId: number | null = null;
let sceneScope: SceneScope | null = null;

export function calculatePercentile(
  values: readonly number[],
  percentile: number,
): number {
  const cleanValues = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (cleanValues.length === 0) {
    return 0;
  }

  const boundedPercentile = Math.min(Math.max(percentile, 0), 100);
  const rawIndex = Math.ceil((boundedPercentile / 100) * cleanValues.length) - 1;
  const index = Math.min(Math.max(rawIndex, 0), cleanValues.length - 1);
  return roundMetric(cleanValues[index] ?? 0);
}

export function calculateFrameIntervalStats(
  intervals: readonly number[],
): FrameIntervalStats {
  const cleanIntervals = intervals.filter(
    (interval) => Number.isFinite(interval) && interval > 0,
  );
  const totalDuration = cleanIntervals.reduce(
    (total, interval) => total + interval,
    0,
  );
  const max = cleanIntervals.reduce(
    (currentMax, interval) => Math.max(currentMax, interval),
    0,
  );

  return {
    sampleCount: cleanIntervals.length,
    fps:
      totalDuration > 0
        ? roundMetric((cleanIntervals.length * 1000) / totalDuration)
        : 0,
    p50: calculatePercentile(cleanIntervals, 50),
    p95: calculatePercentile(cleanIntervals, 95),
    max: roundMetric(max),
    droppedFrameCount: cleanIntervals.filter(
      (interval) => interval > FRAME_DROP_THRESHOLD_MS,
    ).length,
  };
}

export function aggregateLongTasks(
  durations: readonly number[],
): LongTaskStats {
  const cleanDurations = durations.filter(
    (duration) => Number.isFinite(duration) && duration >= 0,
  );
  const total = cleanDurations.reduce(
    (sum, duration) => sum + duration,
    0,
  );
  const max = cleanDurations.reduce(
    (currentMax, duration) => Math.max(currentMax, duration),
    0,
  );

  return {
    count: cleanDurations.length,
    total: roundMetric(total),
    max: roundMetric(max),
  };
}

export function perfMark(name: string): void {
  if (!enabled || typeof performance === "undefined") {
    return;
  }

  try {
    performance.mark(name);
  } catch {
    // mark 名称异常不应影响真实交互链路。
  }
}

export function initPerfMetrics(): void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !isPerfMetricsEnabled()
  ) {
    return;
  }

  enabled = true;
  resetTime = getNow();

  patchScheduler();
  patchCanvasGetContext();
  startLongTaskObserver();
  startSampler();
  ensureOverlay();

  window.__PERF__ = {
    reset,
    startScene,
    endScene,
    snapshot,
  };
}

function isPerfMetricsEnabled(): boolean {
  const queryEnabled = new URLSearchParams(window.location.search).get("perf") === "1";
  if (queryEnabled) {
    return true;
  }

  try {
    return (
      window.localStorage.getItem(PERF_LOCAL_STORAGE_KEY) === "1" ||
      window.localStorage.getItem("perf") === "1"
    );
  } catch {
    return false;
  }
}

function reset(): void {
  frameIntervals = [];
  lastFrameTime = null;
  longTaskDurations = [];
  recentFrameIntervals = [];
  resetTime = getNow();
  sceneScope = null;

  const internalState = getInternalState();
  internalState.intervalScheduledTotal = 0;
  internalState.rafScheduledTotal = 0;

  updateOverlay();
}

function startScene(name: string): void {
  sceneScope = {
    frameStartIndex: frameIntervals.length,
    longTaskStartIndex: longTaskDurations.length,
    name,
    schedulerStart: getSchedulerCounterSnapshot(),
    startTime: getNow(),
  };
}

function endScene(): PerfSnapshot {
  const scope = sceneScope;
  const result = scope ? buildSnapshot(scope) : snapshot();
  if (scope) {
    console.info(`[perf] ${scope.name}`, result);
  }
  sceneScope = null;
  return result;
}

function snapshot(): PerfSnapshot {
  return buildSnapshot(null);
}

function buildSnapshot(scope: SceneScope | null): PerfSnapshot {
  const now = getNow();
  const frameStartIndex = scope?.frameStartIndex ?? 0;
  const longTaskStartIndex = scope?.longTaskStartIndex ?? 0;
  const frameStats = calculateFrameIntervalStats(
    frameIntervals.slice(frameStartIndex),
  );

  return {
    enabled,
    scene: scope?.name ?? sceneScope?.name ?? null,
    timestamp: roundMetric(now),
    durationMs: roundMetric(now - (scope?.startTime ?? resetTime)),
    sampleCount: frameStats.sampleCount,
    fps: frameStats.fps,
    p50FrameIntervalMs: frameStats.p50,
    p95FrameIntervalMs: frameStats.p95,
    maxFrameIntervalMs: frameStats.max,
    droppedFrameCount: frameStats.droppedFrameCount,
    longtask: aggregateLongTasks(longTaskDurations.slice(longTaskStartIndex)),
    scheduler: getSchedulerStats(scope?.schedulerStart ?? null),
    domNodes: countDomNodes(),
    webgl: getWebglSnapshot(),
    heap: readHeapSnapshot(),
  };
}

function patchScheduler(): void {
  const internalState = getInternalState();
  if (internalState.patchedScheduler) {
    return;
  }

  const originals: SchedulerOriginals = {
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  internalState.originals = originals;

  window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    let requestId = 0;
    requestId = originals.requestAnimationFrame((timestamp) => {
      internalState.activeRafIds.delete(requestId);
      callback(timestamp);
    });
    internalState.activeRafIds.add(requestId);
    internalState.rafScheduledTotal += 1;
    return requestId;
  }) as typeof window.requestAnimationFrame;

  window.cancelAnimationFrame = ((handle: number): void => {
    internalState.activeRafIds.delete(handle);
    originals.cancelAnimationFrame(handle);
  }) as typeof window.cancelAnimationFrame;

  window.setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): number => {
    const intervalId = originals.setInterval(handler, timeout, ...args);
    internalState.activeIntervalIds.add(intervalId);
    internalState.intervalScheduledTotal += 1;
    return intervalId;
  }) as typeof window.setInterval;

  window.clearInterval = ((handle?: number): void => {
    if (typeof handle === "number") {
      internalState.activeIntervalIds.delete(handle);
    }
    originals.clearInterval(handle);
  }) as typeof window.clearInterval;

  internalState.patchedScheduler = true;
}

function patchCanvasGetContext(): void {
  if (typeof HTMLCanvasElement === "undefined") {
    return;
  }

  const internalState = getInternalState();
  if (internalState.patchedCanvasGetContext) {
    return;
  }

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  internalState.originalCanvasGetContext = originalGetContext;

  HTMLCanvasElement.prototype.getContext = function patchedGetContext(
    this: HTMLCanvasElement,
    contextId: string,
    options?: CanvasRenderingContext2DSettings
      | ImageBitmapRenderingContextSettings
      | WebGLContextAttributes,
  ): CanvasContextResult {
    const result = Reflect.apply(
      originalGetContext,
      this,
      options === undefined ? [contextId] : [contextId, options],
    ) as CanvasContextResult;

    if (result && isWebglContextId(contextId)) {
      internalState.webglCanvases.add(this);
    }

    return result;
  } as HTMLCanvasElement["getContext"];

  internalState.patchedCanvasGetContext = true;
}

function startLongTaskObserver(): void {
  if (longTaskObserver || typeof window.PerformanceObserver === "undefined") {
    return;
  }

  const Observer = window.PerformanceObserver;
  const supportedEntryTypes = Observer.supportedEntryTypes;
  if (
    Array.isArray(supportedEntryTypes) &&
    !supportedEntryTypes.includes("longtask")
  ) {
    return;
  }

  try {
    longTaskObserver = new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (Number.isFinite(entry.duration)) {
          longTaskDurations.push(entry.duration);
        }
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    longTaskObserver = null;
  }
}

function startSampler(): void {
  if (samplerRafId !== null) {
    return;
  }

  const originalRequestAnimationFrame = getOriginals().requestAnimationFrame;
  samplerRafId = originalRequestAnimationFrame(sampleFrame);
}

function sampleFrame(timestamp: number): void {
  if (lastFrameTime !== null) {
    const interval = timestamp - lastFrameTime;
    if (Number.isFinite(interval) && interval > 0) {
      frameIntervals.push(interval);
      recentFrameIntervals.push(interval);
      if (recentFrameIntervals.length > RECENT_FRAME_WINDOW_SIZE) {
        recentFrameIntervals.shift();
      }
    }
  }

  lastFrameTime = timestamp;
  updateOverlay();
  samplerRafId = getOriginals().requestAnimationFrame(sampleFrame);
}

function ensureOverlay(): void {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLDivElement) {
    overlayElement = existing;
    updateOverlay();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.right = "8px";
  overlay.style.bottom = "8px";
  overlay.style.zIndex = "2147483647";
  overlay.style.pointerEvents = "none";
  overlay.style.padding = "4px 6px";
  overlay.style.borderRadius = "4px";
  overlay.style.background = "rgba(15, 23, 42, 0.82)";
  overlay.style.color = "#f8fafc";
  overlay.style.font = "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace";
  overlay.style.boxShadow = "0 2px 10px rgba(15, 23, 42, 0.22)";
  overlay.style.whiteSpace = "nowrap";
  overlay.textContent = "fps -- | lt 0 | raf 0";

  document.body.appendChild(overlay);
  overlayElement = overlay;
}

function updateOverlay(): void {
  if (!overlayElement) {
    return;
  }

  const frameStats = calculateFrameIntervalStats(recentFrameIntervals);
  const longTaskStats = aggregateLongTasks(longTaskDurations);
  const schedulerStats = getSchedulerStats(null);
  overlayElement.textContent = `fps ${Math.round(frameStats.fps)} | lt ${longTaskStats.count} | raf ${schedulerStats.raf.active}`;
}

function getInternalState(): PerfInternalWindowState {
  const existingState = window.__QINGAGENT_PERF_INTERNAL__;
  if (existingState) {
    return existingState;
  }

  const newState: PerfInternalWindowState = {
    activeRafIds: new Set<number>(),
    activeIntervalIds: new Set<number>(),
    intervalScheduledTotal: 0,
    originalCanvasGetContext: null,
    originals: null,
    patchedCanvasGetContext: false,
    patchedScheduler: false,
    rafScheduledTotal: 0,
    webglCanvases: new Set<HTMLCanvasElement>(),
  };
  window.__QINGAGENT_PERF_INTERNAL__ = newState;
  return newState;
}

function getOriginals(): SchedulerOriginals {
  const internalState = getInternalState();
  if (internalState.originals) {
    return internalState.originals;
  }

  const originals: SchedulerOriginals = {
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  internalState.originals = originals;
  return originals;
}

function getSchedulerCounterSnapshot(): SchedulerCounterSnapshot {
  const internalState = getInternalState();
  return {
    rafScheduledTotal: internalState.rafScheduledTotal,
    intervalScheduledTotal: internalState.intervalScheduledTotal,
  };
}

function getSchedulerStats(
  baseline: SchedulerCounterSnapshot | null,
): SchedulerStats {
  const internalState = getInternalState();
  const rafScheduledTotal = baseline
    ? internalState.rafScheduledTotal - baseline.rafScheduledTotal
    : internalState.rafScheduledTotal;
  const intervalScheduledTotal = baseline
    ? internalState.intervalScheduledTotal - baseline.intervalScheduledTotal
    : internalState.intervalScheduledTotal;

  return {
    raf: {
      active: internalState.activeRafIds.size,
      scheduledTotal: Math.max(0, rafScheduledTotal),
    },
    interval: {
      active: internalState.activeIntervalIds.size,
      scheduledTotal: Math.max(0, intervalScheduledTotal),
    },
  };
}

function countDomNodes(): number {
  if (typeof document === "undefined") {
    return 0;
  }

  return document.getElementsByTagName("*").length;
}

function getWebglSnapshot(): WebglSnapshot {
  if (typeof document === "undefined") {
    return {
      canvasCount: 0,
      trackedContextCount: 0,
      approximateCount: 0,
    };
  }

  const canvasCount = document.querySelectorAll("canvas").length;
  const trackedContextCount = getInternalState().webglCanvases.size;
  return {
    canvasCount,
    trackedContextCount,
    approximateCount: canvasCount + trackedContextCount,
  };
}

function readHeapSnapshot(): HeapSnapshot | null {
  if (typeof performance === "undefined") {
    return null;
  }

  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) {
    return null;
  }

  const { jsHeapSizeLimit, totalJSHeapSize, usedJSHeapSize } = memory;
  if (
    typeof jsHeapSizeLimit !== "number" ||
    typeof totalJSHeapSize !== "number" ||
    typeof usedJSHeapSize !== "number"
  ) {
    return null;
  }

  return {
    usedJSHeapSize,
    totalJSHeapSize,
    jsHeapSizeLimit,
  };
}

function getNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function isWebglContextId(contextId: string): boolean {
  const normalizedContextId = contextId.toLowerCase();
  return (
    normalizedContextId === "webgl" ||
    normalizedContextId === "webgl2" ||
    normalizedContextId === "experimental-webgl"
  );
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}
