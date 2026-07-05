import { describe, expect, it } from "vitest";
import {
  aggregateLongTasks,
  calculateFrameIntervalStats,
  calculatePercentile,
} from "./perfMetrics";

describe("perfMetrics pure stats", () => {
  it("calculates nearest-rank percentiles from finite values", () => {
    expect(calculatePercentile([], 95)).toBe(0);
    expect(calculatePercentile([Number.NaN, 16, 50, 17, 100], 50)).toBe(17);
    expect(calculatePercentile([Number.NaN, 16, 50, 17, 100], 95)).toBe(100);
    expect(calculatePercentile([10, 20, 30], -10)).toBe(10);
    expect(calculatePercentile([10, 20, 30], 120)).toBe(30);
  });

  it("summarizes frame intervals and counts frames over 50ms", () => {
    const stats = calculateFrameIntervalStats([
      16,
      17,
      51,
      100,
      0,
      -1,
      Number.POSITIVE_INFINITY,
    ]);

    expect(stats).toEqual({
      sampleCount: 4,
      fps: 21.74,
      p50: 17,
      p95: 100,
      max: 100,
      droppedFrameCount: 2,
    });
  });

  it("aggregates longtask durations defensively", () => {
    expect(aggregateLongTasks([])).toEqual({
      count: 0,
      total: 0,
      max: 0,
    });

    expect(aggregateLongTasks([52.24, 75.5, 100, Number.NaN, -1])).toEqual({
      count: 3,
      total: 227.74,
      max: 100,
    });
  });
});
