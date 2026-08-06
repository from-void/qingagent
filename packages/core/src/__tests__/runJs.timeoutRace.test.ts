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

function createFakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

describe("run_js 默认超时与 OOM 归因竞态", () => {
  afterEach(() => {
    spawnControl.nextChild = undefined;
    vi.useRealTimers();
  });

  it("不传 timeout_ms 时，默认超时后才到达的 V8 OOM 信号仍归为 resourceExceeded", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnControl.nextChild = () => child;

    try {
      const resultPromise = runJsInWorker({ code: "new Array(5e7).fill(0)" });

      await vi.advanceTimersByTimeAsync(999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledTimes(1);

      child.stderr.write(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
      );

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "资源超限",
        failureKind: "resourceExceeded",
      });
    } finally {
      child.emit("close", null, "SIGTERM");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it("不传 timeout_ms 时，默认超时后才到达的 SIGABRT 终态仍归为 resourceExceeded", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnControl.nextChild = () => child;

    try {
      const resultPromise = runJsInWorker({ code: "new Array(5e7).fill(0)" });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit("close", null, "SIGABRT");

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "资源超限",
        failureKind: "resourceExceeded",
      });
    } finally {
      child.emit("close", null, "SIGABRT");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it("普通默认超时随子进程 close 立即归为 timedOut，不增加固定等待窗", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    child.kill.mockImplementation(() => {
      child.emit("close", null, "SIGTERM");
      return true;
    });
    spawnControl.nextChild = () => child;

    try {
      const resultPromise = runJsInWorker({ code: "while (true) {}" });

      await vi.advanceTimersByTimeAsync(999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "timeout",
        failureKind: "timedOut",
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      child.emit("close", null, "SIGTERM");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
