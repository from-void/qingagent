import { describe, expect, it } from "vitest";
import { withBrowserContextSlot } from "../browser/pool.js";
import {
  ExportBusyError,
  ExportDeadlineExceededError,
  withExportSlot,
} from "./exportSlot.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

describe("withExportSlot", () => {
  it("所有导出后端共享最多 3 个并发槽", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const gates = Array.from({ length: 4 }, deferred);
    const tasks = gates.map((gate, index) => {
      const run = async () => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
      };
      return index === gates.length - 1
        ? withBrowserContextSlot(run)
        : withExportSlot(run, { executionTimeoutMs: 2_000 });
    });

    await until(() => active === 3);
    expect(maxActive).toBe(3);
    gates[0]!.resolve();
    await until(() => started === 4);
    expect(active).toBe(3);
    gates.slice(1).forEach((gate) => gate.resolve());
    await Promise.all(tasks);
    expect(maxActive).toBe(3);
  });

  it("执行 deadline 只在拿到槽位后开始，4 并发排队时间不侵蚀第 4 个任务预算", async () => {
    const blockers = Array.from({ length: 3 }, deferred);
    let activeBlockers = 0;
    const blockerTasks = blockers.map((gate) =>
      withExportSlot(async () => {
        activeBlockers += 1;
        await gate.promise;
      }, { queueTimeoutMs: 1_000, executionTimeoutMs: 1_000 }),
    );
    await until(() => activeBlockers === 3);

    let fourthStarted = false;
    const fourth = withExportSlot(async () => {
      fourthStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return "ok";
    }, { queueTimeoutMs: 1_000, executionTimeoutMs: 40 });

    // 排队时间已超过自身 40ms 执行预算；旧实现会在尚未拿槽时误杀。
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(fourthStarted).toBe(false);
    blockers[0]!.resolve();
    await expect(fourth).resolves.toBe("ok");

    blockers.slice(1).forEach((gate) => gate.resolve());
    await Promise.all(blockerTasks);
  });

  it("排队等待超时返回可重试繁忙，不会启动执行体", async () => {
    const blockers = Array.from({ length: 3 }, deferred);
    let activeBlockers = 0;
    const blockerTasks = blockers.map((gate) =>
      withExportSlot(async () => {
        activeBlockers += 1;
        await gate.promise;
      }, { queueTimeoutMs: 1_000, executionTimeoutMs: 1_000 }),
    );
    await until(() => activeBlockers === 3);

    let started = false;
    const queued = withExportSlot(async () => {
      started = true;
    }, { queueTimeoutMs: 20, executionTimeoutMs: 1_000 });
    await expect(queued).rejects.toMatchObject({
      name: "ExportBusyError",
      code: "EXPORT_BUSY",
      retryable: true,
    });
    expect(started).toBe(false);
    await expect(queued).rejects.toBeInstanceOf(ExportBusyError);

    blockers.forEach((gate) => gate.resolve());
    await Promise.all(blockerTasks);
  });

  it("获得槽位后的执行超时会 abort 后端并拒绝", async () => {
    let observedAbort = false;
    const pending = withExportSlot(
      async ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        }),
      { queueTimeoutMs: 1_000, executionTimeoutMs: 20 },
    );

    await expect(pending).rejects.toBeInstanceOf(ExportDeadlineExceededError);
    expect(observedAbort).toBe(true);
  });
});
