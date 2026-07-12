// 0702 review Lane A · Round 2:SSE 长连接资源回收验证。
// GET /events 每个订阅注册一个 frameLog listener + 一个 15s 心跳 setInterval,
// 断开时依赖 stream.onAbort 里的 clearInterval + unsubscribe 全量回收。
// 若 onAbort 不触发或回收不彻底,listener 泄漏会让 InMemoryFrameLog 的 Set 无限增长
// (每帧还多做无效分发),心跳泄漏则是常驻定时器。此测试用真实 Hono app 做
// 连接-断开压测,直接断言两类资源归零。
import { describe, expect, it } from "vitest";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openEvents(sessionId: string, epoch: number) {
  const controller = new AbortController();
  const res = await app.request(
    `/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&after=0&epoch=${epoch}`,
    { method: "GET", signal: controller.signal },
  );
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  // 拉一次 body 让流真正建立(订阅在 streamSSE 回调里同步注册,但读一口更稳)。
  const reader = res.body?.getReader();
  return { controller, reader };
}

describe("GET /api/v1/events 断连资源回收", () => {
  it("多订阅者全部断开后 frameLog listener 与心跳定时器全量回收", async () => {
    // 用真实命令创建会话,拿到合法 epoch
    const started = await app.request("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "startSession",
        data: { mode: { kind: "new", data: { template: null } } },
      }),
    });
    expect(started.status).toBe(200);
    const { sessionId, epoch } = (await started.json()) as {
      sessionId: string;
      epoch: number;
    };

    // 统计本用例期间新建/清理的 15s 心跳定时器(按 delay 过滤,不干扰其它定时器)。
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const heartbeatTimers = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
      const timer = realSetInterval(fn as never, delay as never, ...(rest as never[]));
      if (delay === 15_000) heartbeatTimers.add(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer?: unknown) => {
      heartbeatTimers.delete(timer);
      return realClearInterval(timer as never);
    }) as typeof clearInterval;

    try {
      const subscribers: Awaited<ReturnType<typeof openEvents>>[] = [];
      for (let i = 0; i < 12; i++) {
        subscribers.push(await openEvents(sessionId, epoch));
      }
      await sleep(50);
      expect(sessionManager.frameLog.hasSubscribers(sessionId)).toBe(true);
      expect(heartbeatTimers.size).toBe(12);

      // 全部断开(模拟客户端关标签页/网络断开)
      for (const sub of subscribers) {
        sub.controller.abort();
        await sub.reader?.cancel().catch(() => undefined);
      }
      // onAbort 是异步分发,轮询等待回收完成
      const deadline = Date.now() + 3_000;
      while (
        (sessionManager.frameLog.hasSubscribers(sessionId) || heartbeatTimers.size > 0) &&
        Date.now() < deadline
      ) {
        await sleep(25);
      }

      // 关键断言:listener 全量注销、心跳定时器全量 clear
      expect(sessionManager.frameLog.hasSubscribers(sessionId)).toBe(false);
      expect(heartbeatTimers.size).toBe(0);

      // 反复连接-断开 3 轮不累积(防单次侥幸)
      for (let round = 0; round < 3; round++) {
        const churn = await openEvents(sessionId, epoch);
        await sleep(20);
        churn.controller.abort();
        await churn.reader?.cancel().catch(() => undefined);
      }
      const deadline2 = Date.now() + 3_000;
      while (
        (sessionManager.frameLog.hasSubscribers(sessionId) || heartbeatTimers.size > 0) &&
        Date.now() < deadline2
      ) {
        await sleep(25);
      }
      expect(sessionManager.frameLog.hasSubscribers(sessionId)).toBe(false);
      expect(heartbeatTimers.size).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  }, 20_000);
});
