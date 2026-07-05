import { afterEach, describe, expect, it } from "vitest";
import { browserLaunchCandidates } from "./pool.js";

// 浏览器启动候选:① 探测到的系统浏览器 executablePath(优先,可控)② channel(QINGAGENT_BROWSER_CHANNELS)
// ③ 默认 Chromium 兜底。web/VPS 不设变量、无系统浏览器探测结果时只剩默认项,行为不变。
// 只校验候选的「种类与顺序」(launch 涉及真实 Playwright,不在单测里跑)。
describe("browserLaunchCandidates", () => {
  const origChannels = process.env.QINGAGENT_BROWSER_CHANNELS;
  afterEach(() => {
    if (origChannels === undefined) delete process.env.QINGAGENT_BROWSER_CHANNELS;
    else process.env.QINGAGENT_BROWSER_CHANNELS = origChannels;
  });

  it("末尾恒有默认兜底候选", () => {
    delete process.env.QINGAGENT_BROWSER_CHANNELS;
    const c = browserLaunchCandidates();
    expect(c.at(-1)?.kind).toBe("default");
  });

  it("channel 按 QINGAGENT_BROWSER_CHANNELS 顺序解析,去重", () => {
    process.env.QINGAGENT_BROWSER_CHANNELS = "msedge,chrome,msedge";
    const channels = browserLaunchCandidates()
      .filter((c) => c.kind === "channel")
      .map((c) => c.label);
    expect(channels).toEqual(["channel=msedge", "channel=chrome"]);
  });

  it("两侧空白被 trim,空项被滤掉", () => {
    process.env.QINGAGENT_BROWSER_CHANNELS = "  msedge , , chrome ,";
    const channels = browserLaunchCandidates()
      .filter((c) => c.kind === "channel")
      .map((c) => c.label);
    expect(channels).toEqual(["channel=msedge", "channel=chrome"]);
  });

  it("exec 候选排在 channel 之前(优先级)", () => {
    process.env.QINGAGENT_BROWSER_CHANNELS = "msedge,chrome";
    const kinds = browserLaunchCandidates().map((c) => c.kind);
    // exec(如有)> channel... > default,顺序单调:default 在最后,channel 段在 default 前。
    const firstChannelIdx = kinds.indexOf("channel");
    const defaultIdx = kinds.indexOf("default");
    expect(defaultIdx).toBeGreaterThan(firstChannelIdx);
    expect(kinds.at(-1)).toBe("default");
  });
});
