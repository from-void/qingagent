import { describe, expect, it } from "vitest";
import { withBrowserContextSlot } from "../browser/pool.js";
import {
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
        : withExportSlot(run, { timeoutMs: 2_000 });
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

  it("总时限包含排队/执行，超时会 abort 后端并拒绝", async () => {
    let observedAbort = false;
    const pending = withExportSlot(
      async ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        }),
      { timeoutMs: 20 },
    );

    await expect(pending).rejects.toBeInstanceOf(ExportDeadlineExceededError);
    expect(observedAbort).toBe(true);
  });
});
