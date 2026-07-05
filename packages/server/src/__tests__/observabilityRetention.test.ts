import { describe, expect, it, vi } from "vitest";
import { enforceObservabilityTraceRetention } from "../observabilityRetention";
import type {
  ObservabilityRetentionLogger,
  ObservabilityTraceRetentionStore,
} from "../observabilityRetention";

function makeLogger(): ObservabilityRetentionLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

// 模拟 DuckDBStore.getConnection() 返回的连接:runAndReadAll 按"最新优先"返回 traceId 行。
function makeStore(traceIds: string[]): ObservabilityTraceRetentionStore & {
  closeConnection: ReturnType<typeof vi.fn>;
} {
  const connection = {
    runAndReadAll: vi.fn(async () => ({
      getRowObjects: () => traceIds.map((traceId) => ({ traceId })),
    })),
  };
  return {
    getConnection: vi.fn(async () => connection),
    closeConnection: vi.fn(),
    batchDeleteTraces: vi.fn(async () => undefined),
  };
}

describe("observability trace retention", () => {
  it("trims traces after the newest maxTraces entries", async () => {
    const store = makeStore(["trace-1", "trace-2", "trace-3", "trace-4"]);

    const result = await enforceObservabilityTraceRetention({
      store,
      maxTraces: 2,
      logger: makeLogger(),
    });

    expect(store.batchDeleteTraces).toHaveBeenCalledTimes(1);
    expect(store.batchDeleteTraces).toHaveBeenCalledWith({
      traceIds: ["trace-3", "trace-4"],
    });
    // 连接必须释放,避免每轮保留泄漏一个连接。
    expect(store.closeConnection).toHaveBeenCalled();
    expect(result).toMatchObject({
      total: 4,
      deleted: 2,
      remaining: 2,
      traceIdsDeleted: ["trace-3", "trace-4"],
    });
  });

  it("does not delete when trace count is within maxTraces", async () => {
    const store = makeStore(["trace-1", "trace-2"]);

    const result = await enforceObservabilityTraceRetention({
      store,
      maxTraces: 2,
      logger: makeLogger(),
    });

    expect(store.batchDeleteTraces).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      total: 2,
      deleted: 0,
      remaining: 2,
      traceIdsDeleted: [],
    });
  });
});
