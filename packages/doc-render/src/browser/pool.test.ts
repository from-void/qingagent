import { afterEach, describe, expect, it } from "vitest";
import { browserLaunchCandidates, withBrowserContextSlot } from "./pool.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("withBrowserContextSlot", () => {
  it("并发执行最多占用 3 个 browser context 槽位", async () => {
    const gates = Array.from({ length: 6 }, deferred);
    let active = 0;
    let peak = 0;
    let started = 0;
    const tasks = gates.map((gate) => withBrowserContextSlot(async () => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      try {
        await gate.promise;
      } finally {
        active -= 1;
      }
    }));

    try {
      await flushMicrotasks();
      expect(started).toBe(3);
      expect(peak).toBe(3);

      gates[0]!.resolve();
      await flushMicrotasks();
      expect(started).toBe(4);
      expect(peak).toBe(3);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.all(tasks);
    }
  });

  it("F10: 第 4 个排队任务取消后立即拒绝且不消耗后续槽位", async () => {
    const occupied = Array.from({ length: 3 }, deferred);
    let started = 0;
    const firstThree = occupied.map((gate) => withBrowserContextSlot(async () => {
      started += 1;
      await gate.promise;
    }));
    await flushMicrotasks();
    expect(started).toBe(3);

    const controller = new AbortController();
    let fourthStarted = false;
    const fourth = withBrowserContextSlot(async () => {
      fourthStarted = true;
    }, controller.signal);
    await flushMicrotasks();
    controller.abort(new DOMException("取消排队", "AbortError"));

    await expect(fourth).rejects.toMatchObject({ name: "AbortError" });
    expect(fourthStarted).toBe(false);

    const fifthGate = deferred();
    let fifthStarted = false;
    const fifth = withBrowserContextSlot(async () => {
      fifthStarted = true;
      await fifthGate.promise;
    });
    occupied[0]!.resolve();
    await flushMicrotasks();
    expect(fifthStarted).toBe(true);

    occupied.slice(1).forEach((gate) => gate.resolve());
    fifthGate.resolve();
    await Promise.all([...firstThree, fifth]);
  });
});

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
