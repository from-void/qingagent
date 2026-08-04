import { describe, expect, it, vi } from "vitest";
import { RunPythonMemoryBudgetCoordinator } from "../pythonMemoryBudget.js";

describe("run_python 全局 RSS 总额协调", () => {
  it("并发 Worker 共享首个基线，且只在全局总额超限时统一终止", () => {
    const coordinator = new RunPythonMemoryBudgetCoordinator(1_000);
    const firstExceeded = vi.fn();
    const secondExceeded = vi.fn();
    const releaseFirst = coordinator.register(10_000, firstExceeded);
    const releaseSecond = coordinator.register(10_600, secondExceeded);

    coordinator.poll(10_999);
    expect(firstExceeded).not.toHaveBeenCalled();
    expect(secondExceeded).not.toHaveBeenCalled();

    coordinator.poll(11_001);
    expect(firstExceeded).toHaveBeenCalledTimes(1);
    expect(secondExceeded).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseSecond();
    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.baselineRss).toBeNull();
  });
});
