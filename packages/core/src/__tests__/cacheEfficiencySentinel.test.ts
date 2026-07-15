import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeCacheOutcome,
  resetCacheEfficiencySentinelForTests,
} from "../llm/cacheEfficiencySentinel.js";

const originalEnabled = process.env.QINGAGENT_CACHE_SENTINEL;
const originalMinHitRate = process.env.QINGAGENT_CACHE_SENTINEL_MIN_HIT_RATE;
const originalMinMiss = process.env.QINGAGENT_CACHE_SENTINEL_MIN_MISS;

function observe(hitTokens: number, missTokens: number, sessionId = "sentinel-session"): void {
  observeCacheOutcome({
    sessionId,
    callSite: "omObserve",
    hitTokens,
    missTokens,
  });
}

describe("缓存效率哨兵", () => {
  beforeEach(() => {
    delete process.env.QINGAGENT_CACHE_SENTINEL;
    delete process.env.QINGAGENT_CACHE_SENTINEL_MIN_HIT_RATE;
    delete process.env.QINGAGENT_CACHE_SENTINEL_MIN_MISS;
    resetCacheEfficiencySentinelForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCacheEfficiencySentinelForTests();
    if (originalEnabled === undefined) delete process.env.QINGAGENT_CACHE_SENTINEL;
    else process.env.QINGAGENT_CACHE_SENTINEL = originalEnabled;
    if (originalMinHitRate === undefined) delete process.env.QINGAGENT_CACHE_SENTINEL_MIN_HIT_RATE;
    else process.env.QINGAGENT_CACHE_SENTINEL_MIN_HIT_RATE = originalMinHitRate;
    if (originalMinMiss === undefined) delete process.env.QINGAGENT_CACHE_SENTINEL_MIN_MISS;
    else process.env.QINGAGENT_CACHE_SENTINEL_MIN_MISS = originalMinMiss;
  });

  it("连续三个低命中且大 miss 的有效样本触发结构化告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observe(12_000, 12_000);
    observe(11_000, 13_000);
    expect(warn).not.toHaveBeenCalled();
    observe(10_000, 14_000);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[cacheSentinel] site=omObserve session=sentinel-session 连续低命中+大 miss(疑似前缀分叉/积压)",
      ),
      expect.objectContaining({
        site: "omObserve",
        session: "sentinel-session",
        hitMissSequence: ["12000/12000", "11000/13000", "10000/14000"],
      }),
    );
  });

  it("miss 单调上涨时仍只按连续低命中加大 miss 的组合规则触发", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observe(8_000, 11_000, "monotonic-miss");
    observe(8_000, 12_000, "monotonic-miss");
    observe(8_000, 13_000, "monotonic-miss");

    expect(warn).toHaveBeenCalledOnce();
  });

  it("样本不足、请求过小或仅 miss 大但命中率健康时不触发", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    observe(4_000, 12_000, "only-two");
    observe(4_000, 12_000, "only-two");
    observe(500, 3_000, "short-request");
    observe(500, 3_000, "short-request");
    observe(500, 3_000, "short-request");
    observe(30_000, 11_000, "healthy-hit");
    observe(30_000, 12_000, "healthy-hit");
    observe(30_000, 13_000, "healthy-hit");

    expect(warn).not.toHaveBeenCalled();
  });

  it("环境开关为 0 时不采样也不触发", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.QINGAGENT_CACHE_SENTINEL = "0";
    observe(5_000, 12_000);
    observe(5_000, 12_000);
    observe(5_000, 12_000);

    expect(warn).not.toHaveBeenCalled();
  });

  it("同一键告警后至少等待三个新有效样本才允许再次告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let index = 0; index < 3; index += 1) observe(5_000, 12_000);
    expect(warn).toHaveBeenCalledTimes(1);

    observe(5_000, 12_000);
    observe(5_000, 12_000);
    expect(warn).toHaveBeenCalledTimes(1);
    observe(5_000, 12_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
