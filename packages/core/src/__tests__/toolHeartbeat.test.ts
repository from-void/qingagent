import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startToolHeartbeat,
  writeToolStreamChunk,
} from "../tools/toolHeartbeat.js";

// 对抗性单测:工具心跳 helper 的脏路径。被测的是项目真实导出 startToolHeartbeat,
// 绝不在此重写其逻辑。重点验证:① writer 缺失/畸形不抛;② 按 interval 递增 emit;
// ③ intervalMs 越界被夹到 [1000,30000];④ stop() 后不再 emit;⑤ writer.write 同步
// 抛错被吞且不打断后续 tick;⑥ writer.write 返回 rejected promise 不冒 unhandled rejection。

describe("startToolHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. writer 缺失的各种形态:不抛,且返回的 stop 可安全调用
  describe("writer 缺失/畸形 → no-op,不抛", () => {
    it("context 为 undefined", () => {
      let stop!: () => void;
      expect(() => {
        stop = startToolHeartbeat(undefined, { tool: "t" });
      }).not.toThrow();
      // 推进时间不会有任何副作用,stop 也能安全调用
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      expect(() => stop()).not.toThrow();
    });

    it("context.writer 为 undefined", () => {
      let stop!: () => void;
      expect(() => {
        stop = startToolHeartbeat({ writer: undefined }, { tool: "t" });
      }).not.toThrow();
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      expect(() => stop()).not.toThrow();
    });

    it("writer 无 write 方法(write 非函数)", () => {
      let stop!: () => void;
      expect(() => {
        stop = startToolHeartbeat({ writer: { write: "nope" } }, { tool: "t" });
      }).not.toThrow();
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      expect(() => stop()).not.toThrow();
    });

    it("context 为非对象原始值(string)也不抛", () => {
      let stop!: () => void;
      expect(() => {
        stop = startToolHeartbeat("garbage" as unknown, { tool: "t" });
      }).not.toThrow();
      expect(() => stop()).not.toThrow();
    });
  });

  // 2. 正常:推进 N×interval → write 被调用 N 次,type 恒为 tool-heartbeat,seq 递增 1,2,3...
  it("按 interval 周期 emit,seq 从 1 递增、type 恒为 tool-heartbeat、带 tool 名", async () => {
    const write = vi.fn();
    const stop = startToolHeartbeat({ writer: { write } }, {
      tool: "generateSvg",
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000 * 3); // 推进 3 个周期
    expect(write).toHaveBeenCalledTimes(3);

    const chunks = write.mock.calls.map((c) => c[0]);
    expect(chunks.map((ch) => ch.type)).toEqual([
      "tool-heartbeat",
      "tool-heartbeat",
      "tool-heartbeat",
    ]);
    expect(chunks.map((ch) => ch.seq)).toEqual([1, 2, 3]);
    expect(chunks.every((ch) => ch.tool === "generateSvg")).toBe(true);

    stop();
  });

  it("默认 intervalMs 为 10s:推进 9.9s 不 emit,满 10s emit 一次", async () => {
    const write = vi.fn();
    const stop = startToolHeartbeat({ writer: { write } }, { tool: "t" });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 凑满 10_000
    expect(write).toHaveBeenCalledTimes(1);

    stop();
  });

  // 3. 自定义 intervalMs 生效 + 越界值被夹到 [1000,30000]
  describe("intervalMs 夹取到 [1000,30000]", () => {
    it("自定义合法值(2000)生效", async () => {
      const write = vi.fn();
      const stop = startToolHeartbeat({ writer: { write } }, {
        tool: "t",
        intervalMs: 2_000,
      });
      await vi.advanceTimersByTimeAsync(2_000 * 2);
      expect(write).toHaveBeenCalledTimes(2);
      stop();
    });

    it("过小(100)被夹到下界 1000:1000ms 才 emit", async () => {
      const write = vi.fn();
      const stop = startToolHeartbeat({ writer: { write } }, {
        tool: "t",
        intervalMs: 100,
      });
      // 若未夹取,100ms 就该 emit;夹到 1000 后此刻应为 0 次
      await vi.advanceTimersByTimeAsync(999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); // 满 1000
      expect(write).toHaveBeenCalledTimes(1);
      stop();
    });

    it("过大(999999)被夹到上界 30000:30000ms 才 emit 第一次", async () => {
      const write = vi.fn();
      const stop = startToolHeartbeat({ writer: { write } }, {
        tool: "t",
        intervalMs: 999_999,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); // 满 30000
      expect(write).toHaveBeenCalledTimes(1);
      stop();
    });
  });

  // 4. stop() 后再推进时间 → 不再有新的 write 调用
  it("stop() 后不再 emit,且重复 stop() 安全", async () => {
    const write = vi.fn();
    const stop = startToolHeartbeat({ writer: { write } }, {
      tool: "t",
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000 * 2);
    expect(write).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(1_000 * 5); // stop 之后大量推进
    expect(write).toHaveBeenCalledTimes(2); // 没有新增

    expect(() => stop()).not.toThrow(); // 幂等
    await vi.advanceTimersByTimeAsync(1_000 * 5);
    expect(write).toHaveBeenCalledTimes(2);
  });

  // 5. writer.write 同步 throw → 被吞掉,后续 tick 照常 emit,调用方不收异常
  it("write 同步抛错被吞掉,后续 tick 仍照常 emit", async () => {
    const write = vi.fn(() => {
      throw new Error("boom");
    });
    const stop = startToolHeartbeat({ writer: { write } }, {
      tool: "t",
      intervalMs: 1_000,
    });

    // 每个 tick 都抛,但 advanceTimersByTime 不应把异常冒出来
    await vi.advanceTimersByTimeAsync(1_000 * 3);
    expect(write).toHaveBeenCalledTimes(3); // 吞错后定时器存活、继续 emit

    stop();
  });

  it("write 时而抛错时而成功:抛错的 tick 不阻断后续成功 tick(seq 仍持续推进)", async () => {
    const write = vi.fn((chunk: { seq: number }) => {
      if (chunk.seq === 2) throw new Error("boom on 2");
    });
    const stop = startToolHeartbeat({ writer: { write } }, {
      tool: "t",
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000 * 3);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.map((c) => (c[0] as { seq: number }).seq)).toEqual([
      1, 2, 3,
    ]);

    stop();
  });

  // 6. writer.write 返回 rejected Promise → 不产生 unhandled rejection
  it("write 返回 rejected Promise 被内部 catch 吞掉,不冒 unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    const write = vi.fn(() => Promise.reject(new Error("async boom")));
    const stop = startToolHeartbeat({ writer: { write } }, {
      tool: "t",
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000 * 3);
    expect(write).toHaveBeenCalledTimes(3);

    stop();

    // 切回真实定时器,给微任务队列/事件循环一拍机会冒出未捕获 rejection(若有)
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);

    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("心跳与工具进度共用 writer 时串行写入，且首个成功发送只记一次 info", async () => {
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const write = vi.fn(async (chunk: Record<string, unknown>) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      if (chunk.type === "writedraft-progress") await progressGate;
      activeWrites -= 1;
    });
    const writer = { write };
    const observe = { log: vi.fn() };

    const progressWrite = writeToolStreamChunk(
      writer,
      { type: "writedraft-progress", progress: { phase: "writing" } },
    );
    const stop = startToolHeartbeat(
      { writer, observe },
      { tool: "writeDraft", intervalMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);

    releaseProgress();
    await progressWrite;
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(maxActiveWrites).toBe(1);
    expect(observe.log).toHaveBeenCalledTimes(1);
    expect(observe.log).toHaveBeenCalledWith(
      "info",
      "Tool heartbeat emitted",
      expect.objectContaining({ tool: "writeDraft", emittedCount: 1 }),
    );
    stop();
  });

  // unref:定时器存在 unref 方法时被调用(不阻塞进程退出)。用真实 setInterval 验证。
  it("定时器被 unref(不阻塞进程退出)", () => {
    const realInterval = globalThis.setInterval;
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>;
    const intervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeTimer);

    try {
      const stop = startToolHeartbeat({ writer: { write: vi.fn() } }, {
        tool: "t",
      });
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      intervalSpy.mockRestore();
      globalThis.setInterval = realInterval;
    }
  });
});
