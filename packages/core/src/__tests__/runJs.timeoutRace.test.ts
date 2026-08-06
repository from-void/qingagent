import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnControl = vi.hoisted(() => ({
  nextChild: undefined as (() => unknown) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const actualSpawn = actual.spawn as (...args: unknown[]) => unknown;
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const nextChild = spawnControl.nextChild;
      if (!nextChild) return actualSpawn(...args);
      spawnControl.nextChild = undefined;
      return nextChild();
    },
  };
});

import { runJsInWorker } from "../tools/runJs.js";

function createLifecycleFakeChild() {
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  let killed = false;
  let closed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      if (killed || closed) return false;
      killed = true;
      for (const timer of scheduled) clearTimeout(timer);
      scheduled.clear();
      closed = true;
      child.emit("close", null, "SIGTERM");
      return true;
    }),
  });
  const scheduleWhileAlive = (delayMs: number, event: () => void) => {
    const timer = setTimeout(() => {
      scheduled.delete(timer);
      if (!killed && !closed) event();
    }, delayMs);
    scheduled.add(timer);
  };
  return {
    child,
    scheduleReady(delayMs: number) {
      scheduleWhileAlive(delayMs, () => child.emit("message", "ready"));
    },
    scheduleStderr(delayMs: number, text: string) {
      scheduleWhileAlive(delayMs, () => child.stderr.write(text));
    },
    dispose() {
      for (const timer of scheduled) clearTimeout(timer);
      scheduled.clear();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

describe("run_js 子进程启动与用户代码预算", () => {
  afterEach(() => {
    spawnControl.nextChild = undefined;
    vi.useRealTimers();
  });

  it("不传 timeout_ms 时不会在真实 OOM 证据写出前杀进程", async () => {
    vi.useFakeTimers();
    const fake = createLifecycleFakeChild();
    fake.scheduleReady(150);
    fake.scheduleStderr(
      1_045,
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    );
    spawnControl.nextChild = () => fake.child;

    try {
      const resultPromise = runJsInWorker({ code: "new Array(5e7).fill(0)" });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(45);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "资源超限",
        failureKind: "resourceExceeded",
      });
      expect(fake.child.kill).toHaveBeenCalledTimes(1);
    } finally {
      fake.dispose();
    }
  });

  it("显式执行超时从 ready 起算，不吞掉子进程启动时间", async () => {
    vi.useFakeTimers();
    const fake = createLifecycleFakeChild();
    fake.scheduleReady(900);
    spawnControl.nextChild = () => fake.child;

    try {
      const resultPromise = runJsInWorker({ code: "while (true) {}", timeout_ms: 100 });

      await vi.advanceTimersByTimeAsync(999);
      expect(fake.child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "timeout",
        failureKind: "timedOut",
      });
      expect(fake.child.kill).toHaveBeenCalledTimes(1);
    } finally {
      fake.dispose();
    }
  });

  it("子进程一直未 ready 时由独立启动上限终止并归为平台错误", async () => {
    vi.useFakeTimers();
    const fake = createLifecycleFakeChild();
    spawnControl.nextChild = () => fake.child;

    try {
      const resultPromise = runJsInWorker({ code: "return 1;" });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(fake.child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        stdout: "",
        error: "代码执行器不可用",
        failureKind: "platformError",
      });
      expect(fake.child.kill).toHaveBeenCalledTimes(1);
    } finally {
      fake.dispose();
    }
  });

  it("ready 前收到 abort 会立即杀掉子进程并归为取消", async () => {
    vi.useFakeTimers();
    const fake = createLifecycleFakeChild();
    fake.scheduleReady(150);
    spawnControl.nextChild = () => fake.child;
    const controller = new AbortController();

    try {
      const resultPromise = runJsInWorker({ code: "return 1;" }, controller.signal);
      controller.abort();

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "aborted",
        failureKind: "aborted",
      });
      expect(fake.child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(fake.child.kill).toHaveBeenCalledTimes(1);
    } finally {
      fake.dispose();
    }
  });
});
