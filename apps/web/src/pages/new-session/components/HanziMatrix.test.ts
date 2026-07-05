// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HANZI_MATRIX_CONFIG } from "../data/hanziMatrixConfig";
import {
  HanziMatrix,
  buildHanziMatrixLayout,
  clearExpiredHanziConvergeForFrame,
  createHanziCenterBlurMaskGeometry,
  createHanziConvergeItems,
  createHanziMatrixRandom,
  createHanziPulseAdaptiveThrottleState,
  createHanziPulseBatch,
  resolveHanziMatrixRuntimeConfig,
  resolveHanziPulseDrawIntervalMs,
  shouldSkipThrottledPulseFrame,
  updateHanziPulseAdaptiveThrottle,
} from "./HanziMatrix";
import { resetPerfTierForTest } from "../../../system/perf/motionTier";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// perfTier 显式注入:HanziMatrix 用 usePerfTier()→getPerfTier() 读 navigator.hardwareConcurrency,
// 不注入就吃 ambient——CI 2-4 vCPU 会被判 low 档(maskBlur=0,跳过柔焦烘焙 idle 任务),本地多核判 high,
// 同一断言成败被宿主硬件决定。每个 perf 相关用例显式钉死档位 + 测后重置单例,杜绝 ambient 依赖与跨测试泄漏。
function installPerfTier(cores: number, deviceMemory = 8): void {
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: cores,
  });
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: deviceMemory,
  });
  resetPerfTierForTest(); // 清单例,使下次 getPerfTier() 按新注入值重新探测
}

interface RafHarness {
  pendingFrames: Map<number, FrameRequestCallback>;
  runPendingFrames: () => void;
}

interface IdleHarness {
  pendingCallbacks: Map<number, () => void>;
  runPendingCallbacks: () => void;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "cancelIdleCallback");
  Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(navigator, "hardwareConcurrency");
  Reflect.deleteProperty(navigator, "deviceMemory");
  resetPerfTierForTest();
  document.body.innerHTML = "";
});

function installReducedMotionMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(prefers-reduced-motion: reduce)" ? matches : false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

function installCanvasContextMock(): { context: CanvasRenderingContext2D; filterAssignments: string[] } {
  const filterAssignments: string[] = [];
  let filterValue = "none";
  const context = {
    canvas: document.createElement("canvas"),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    fillText: vi.fn(),
    font: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    shadowBlur: 0,
    shadowColor: "transparent",
    textAlign: "center",
    textBaseline: "middle",
    translate: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(context, "filter", {
    configurable: true,
    get: () => filterValue,
    set: (value: string) => {
      filterValue = value;
      filterAssignments.push(value);
    },
  });

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return { context, filterAssignments };
}

function createRafHarness(): RafHarness {
  let nextId = 1;
  let timestamp = 0;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    pendingFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    pendingFrames.delete(id);
  });

  return {
    pendingFrames,
    runPendingFrames: () => {
      const frames = [...pendingFrames.entries()];
      for (const [id, callback] of frames) {
        if (!pendingFrames.delete(id)) {
          continue;
        }
        timestamp += 16;
        callback(timestamp);
      }
    },
  };
}

function installIdleCallbackMock(): IdleHarness {
  let nextId = 1;
  const pendingCallbacks = new Map<number, () => void>();
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: vi.fn((callback: () => void) => {
      const id = nextId;
      nextId += 1;
      pendingCallbacks.set(id, callback);
      return id;
    }),
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: vi.fn((id: number) => {
      pendingCallbacks.delete(id);
    }),
  });

  return {
    pendingCallbacks,
    runPendingCallbacks: () => {
      const callbacks = [...pendingCallbacks.entries()];
      for (const [id, callback] of callbacks) {
        if (!pendingCallbacks.delete(id)) {
          continue;
        }
        callback();
      }
    },
  };
}

async function flushRafUntilIdle(harness: RafHarness, maxPasses = 12): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await act(async () => {
      harness.runPendingFrames();
    });
    if (harness.pendingFrames.size === 0) {
      await act(async () => undefined);
      if (harness.pendingFrames.size === 0) {
        return;
      }
    }
  }
}

describe("HanziMatrix 运行时性能覆盖层", () => {
  it("high 档返回原始运行时配置", () => {
    const config = { ...DEFAULT_HANZI_MATRIX_CONFIG };

    expect(resolveHanziMatrixRuntimeConfig(config, "high", false)).toBe(config);
  });

  it("low 档覆盖 hiRatio 和 cell,且不改写持久化配置对象", () => {
    const config = { ...DEFAULT_HANZI_MATRIX_CONFIG };
    const runtimeConfig = resolveHanziMatrixRuntimeConfig(config, "low", false);

    expect(runtimeConfig).not.toBe(config);
    expect(runtimeConfig.hiRatio).toBe(0.15);
    expect(runtimeConfig.cell).toBe(52);
    expect(runtimeConfig.maskBlur).toBe(0);
    expect(config.hiRatio).toBe(0.3);
    expect(config.cell).toBe(42);
    expect(config.maskBlur).toBe(2.5);
  });

  it("reduced-motion 按 low 档密度处理", () => {
    const config = { ...DEFAULT_HANZI_MATRIX_CONFIG };

    expect(resolveHanziMatrixRuntimeConfig(config, "high", true)).toMatchObject({
      hiRatio: 0.15,
      cell: 52,
      maskBlur: 0,
    });
  });

  it("用户配置已经更省时不反向增加运行时负载", () => {
    const config = { ...DEFAULT_HANZI_MATRIX_CONFIG, hiRatio: 0.08, cell: 60 };

    expect(resolveHanziMatrixRuntimeConfig(config, "low", false)).toMatchObject({
      hiRatio: 0.08,
      cell: 60,
      maskBlur: 0,
    });
  });

  it("reduced-motion 静止态绘完首帧后不保留持续 RAF", async () => {
    installReducedMotionMatchMedia(true);
    installCanvasContextMock();
    const raf = createRafHarness();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(HanziMatrix));
    });
    expect(raf.pendingFrames.size).toBeGreaterThan(0);

    await flushRafUntilIdle(raf);
    expect(raf.pendingFrames.size).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("不再渲染独立 backdrop-filter 虚化层", async () => {
    installReducedMotionMatchMedia(false);
    installCanvasContextMock();
    createRafHarness();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(HanziMatrix));
    });

    expect(container.querySelector(".ccx-hanzi-blur")).toBeNull();
    expect(container.querySelectorAll(".ccx-hanzi-canvas")).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("首帧先绘制清晰 base,空闲后再烘焙中心柔焦并分片预热 glyph sprite", async () => {
    installPerfTier(16); // 显式 high 档:不吃 ambient hardwareConcurrency,CI 低核也确定性 high
    installReducedMotionMatchMedia(false);
    const canvas = installCanvasContextMock();
    const idle = installIdleCallbackMock();
    const raf = createRafHarness();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(HanziMatrix));
    });
    await flushRafUntilIdle(raf);

    expect(idle.pendingCallbacks.size).toBe(2);
    expect(canvas.filterAssignments.some((value) => value.startsWith("blur("))).toBe(false);

    await act(async () => {
      idle.runPendingCallbacks();
    });

    expect(canvas.filterAssignments).toContain("blur(2.5px)");
    expect(raf.pendingFrames.size).toBeGreaterThan(0);

    await flushRafUntilIdle(raf);
    await act(async () => {
      root.unmount();
    });
  });

  it("low 档(低核)跳过中心柔焦烘焙:只调度 glyph 预热 idle、永不 blur(回归 CI 低核确定性红)", async () => {
    installPerfTier(4); // 显式 low 档:hardwareConcurrency<=4 → low → maskBlur=0,柔焦烘焙分支被跳过
    installReducedMotionMatchMedia(false);
    const canvas = installCanvasContextMock();
    const idle = installIdleCallbackMock();
    const raf = createRafHarness();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(HanziMatrix));
    });
    await flushRafUntilIdle(raf);

    // low 档下 maskBlur=0,中心柔焦烘焙 idle 任务不调度——只剩 glyph 预热一个 idle。
    expect(idle.pendingCallbacks.size).toBe(1);
    await act(async () => {
      idle.runPendingCallbacks();
    });
    // 永远不应出现柔焦 blur(这正是 low 档跳过的分支;CI 低核此前误判 high 致 expected 2 got 1)。
    expect(canvas.filterAssignments.some((value) => value.startsWith("blur("))).toBe(false);

    await flushRafUntilIdle(raf);
    await act(async () => {
      root.unmount();
    });
  });
});

describe("HanziMatrix canvas 数据模型", () => {
  it("中心烘焙虚化蒙版沿用 CSS 椭圆几何", () => {
    const geometry = createHanziCenterBlurMaskGeometry({
      height: 1000,
      maskHeight: 54,
      maskWidth: 62,
      width: 2000,
    });

    expect(geometry).toEqual({
      centerX: 1000,
      centerY: 470,
      radiusX: 1240,
      radiusY: 540,
      solidStop: 0.26,
      transparentStop: 0.82,
    });
  });

  it("按旧 CSS grid 规则生成字符格子位置和字符序", () => {
    const layout = buildHanziMatrixLayout({ w: 126, h: 90 }, 42, "天地玄黄");

    expect(layout).toMatchObject({
      cols: 3,
      rows: 4,
      colWidth: 42,
      fontSize: 29,
      rowOffsetY: -39,
    });
    expect(layout.cells).toHaveLength(12);
    expect(layout.cells.slice(0, 6)).toEqual([
      { ch: "天", col: 0, height: 42, index: 0, row: 0, width: 42, x: 21, y: -18 },
      { ch: "地", col: 1, height: 42, index: 1, row: 0, width: 42, x: 63, y: -18 },
      { ch: "玄", col: 2, height: 42, index: 2, row: 0, width: 42, x: 105, y: -18 },
      { ch: "黄", col: 0, height: 42, index: 3, row: 1, width: 42, x: 21, y: 24 },
      { ch: "天", col: 1, height: 42, index: 4, row: 1, width: 42, x: 63, y: 24 },
      { ch: "地", col: 2, height: 42, index: 5, row: 1, width: 42, x: 105, y: 24 },
    ]);
  });

  it("固定 seed 下随机点亮批次可复现", () => {
    const input = {
      activeIndexes: new Set<number>(),
      hiRatio: 0.3,
      now: 1000,
      speed: 3,
      total: 12,
    };

    const first = createHanziPulseBatch({
      ...input,
      random: createHanziMatrixRandom("matrix-audit"),
    });
    const second = createHanziPulseBatch({
      ...input,
      random: createHanziMatrixRandom("matrix-audit"),
    });
    const otherSeed = createHanziPulseBatch({
      ...input,
      random: createHanziMatrixRandom("matrix-audit-other"),
    });

    expect(first).toEqual(second);
    expect(first).not.toEqual(otherSeed);
    expect(first).toHaveLength(1);
    const pulse = first[0]!;
    expect(pulse.index).toBe(0);
    expect(pulse.startTime).toBeLessThanOrEqual(1000);
    expect(pulse.startTime).toBeGreaterThanOrEqual(1000 - 260);
    expect(pulse.durationMs).toBeCloseTo(15416.209, 3);
  });

  it("生成与旧 span converge 一致的逐字飞入数据", () => {
    const layout = buildHanziMatrixLayout({ w: 126, h: 90 }, 42, "天地玄黄");
    const items = createHanziConvergeItems(layout.cells, {
      ch: 120,
      cw: 100,
      cx: 63,
      cy: 45,
    });

    expect(items).toHaveLength(12);
    const firstItem = items[0]!;
    expect(firstItem.cell.index).toBe(0);
    expect(firstItem.delayMs).toBeCloseTo(356.388, 3);
    expect(firstItem.durationMs).toBeCloseTo(618.995, 3);
    expect(firstItem.rotationDeg).toBeCloseTo(7.12, 3);
    expect(firstItem.scaleEnd).toBeCloseTo(0.2695, 4);
    expect(firstItem.tx).toBeCloseTo(89.932, 3);
    expect(firstItem.ty).toBeCloseTo(56.515, 3);

    const thirdItem = items[2]!;
    expect(thirdItem.delayMs).toBeCloseTo(119.901, 3);
    expect(thirdItem.tx).toBeCloseTo(33.814, 3);
    expect(thirdItem.ty).toBeCloseTo(17.054, 3);
  });

  it("converge 超过 maxEndTime 后清空收尾状态", () => {
    const convergeRef: { current: { marker: string; maxEndTime: number } | null } = {
      current: {
        maxEndTime: 200,
        marker: "active",
      },
    };

    expect(clearExpiredHanziConvergeForFrame(convergeRef, 200)).toEqual({
      maxEndTime: 200,
      marker: "active",
    });
    expect(clearExpiredHanziConvergeForFrame(convergeRef, 201)).toBeNull();
    expect(convergeRef.current).toBeNull();
  });

  it("high 档 pulse interval 为 0,RAF 内不再跳帧", () => {
    const intervalMs = resolveHanziPulseDrawIntervalMs({
      adaptiveThrottleActive: false,
      highMotion: true,
    });

    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: false,
        pulseSize: 5,
        sinceLastPaintMs: 1,
        intervalMs,
      }),
    ).toBe(false);
  });

  it("low/reduced 档保留 30fps pulse 节流,但 converge 收尾仍不跳帧", () => {
    const intervalMs = resolveHanziPulseDrawIntervalMs({
      adaptiveThrottleActive: false,
      highMotion: false,
    });

    // converge 刚结束(base 仍停在 "fly")且距上帧不足 interval、仍有 pulse:不许跳过,必须重绘 reset。
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: true,
        pulseSize: 5,
        sinceLastPaintMs: 1,
        intervalMs,
      }),
    ).toBe(false);

    // low/reduced 普通脉冲态(非收尾帧)在节流窗口内仍正常跳帧,保持 30fps 节流收益。
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: false,
        pulseSize: 5,
        sinceLastPaintMs: 1,
        intervalMs,
      }),
    ).toBe(true);

    // converge 进行中不节流;超过 interval 不跳帧;无 pulse 不跳帧。
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: true,
        wasFlyFrame: false,
        pulseSize: 5,
        sinceLastPaintMs: 1,
        intervalMs,
      }),
    ).toBe(false);
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: false,
        pulseSize: 5,
        sinceLastPaintMs: 40,
        intervalMs,
      }),
    ).toBe(false);
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: false,
        pulseSize: 0,
        sinceLastPaintMs: 1,
        intervalMs,
      }),
    ).toBe(false);
  });

  it("high 档连续慢帧会自适应回退到 30fps,便宜帧后恢复", () => {
    const state = createHanziPulseAdaptiveThrottleState();

    for (let i = 0; i < 7; i += 1) {
      updateHanziPulseAdaptiveThrottle(state, 15);
    }
    expect(state.throttled).toBe(false);
    expect(resolveHanziPulseDrawIntervalMs({ adaptiveThrottleActive: state.throttled, highMotion: true })).toBe(0);

    updateHanziPulseAdaptiveThrottle(state, 15);
    expect(state.throttled).toBe(true);
    const fallbackIntervalMs = resolveHanziPulseDrawIntervalMs({
      adaptiveThrottleActive: state.throttled,
      highMotion: true,
    });
    expect(
      shouldSkipThrottledPulseFrame({
        hasConverge: false,
        wasFlyFrame: false,
        pulseSize: 5,
        sinceLastPaintMs: 1,
        intervalMs: fallbackIntervalMs,
      }),
    ).toBe(true);

    for (let i = 0; i < 12; i += 1) {
      updateHanziPulseAdaptiveThrottle(state, 8);
    }
    expect(state.throttled).toBe(false);
    expect(resolveHanziPulseDrawIntervalMs({ adaptiveThrottleActive: state.throttled, highMotion: true })).toBe(0);
  });
});
