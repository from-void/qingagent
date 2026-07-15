import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@qingagent/db", () => ({ recordUsageEvent: recordUsageEventMock }));
const observeCacheOutcomeMock = vi.hoisted(() => vi.fn());
vi.mock("../llm/cacheEfficiencySentinel.js", () => ({ observeCacheOutcome: observeCacheOutcomeMock }));
const { wrapModernModelUsage } = await import("../llm/modernUsageModel.js");

const symbolReader = Symbol("private-reader");

class PrivateFieldModel {
  #value = "private-ok";

  doGenerate = vi.fn(async () => ({
    content: [],
    usage: {
      inputTokens: 15_000,
      outputTokens: 10,
      promptCacheHitTokens: 12_000,
      promptCacheMissTokens: 3_000,
    },
  }));

  doStream = vi.fn(async () => ({ stream: stream([]) }));

  get privateValue(): string {
    return this.#value;
  }

  readPrivate(): string {
    return this.#value;
  }

  [symbolReader](): string {
    return this.#value;
  }
}

function stream(parts: unknown[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function drain(source: ReadableStream): Promise<void> {
  const reader = source.getReader();
  while (!(await reader.read()).done) {
    // 只消费流。
  }
}

function options() {
  return {
    requestContext: new RequestContext([
      ["sessionId", "session-modern"],
      ["runId", "run-modern"],
    ] as never),
    callSite: "omSidecar",
    modelId: "glm-test",
    keyOrigin: "env" as const,
  };
}

describe("modern usage model", () => {
  beforeEach(() => {
    recordUsageEventMock.mockClear();
    observeCacheOutcomeMock.mockClear();
  });

  it("普通方法和 getter 始终以真实实例访问私有字段，并缓存绑定函数", async () => {
    const target = new PrivateFieldModel();
    const model = wrapModernModelUsage(target, options());

    expect(model.privateValue).toBe("private-ok");
    const first = model.readPrivate;
    expect(model.readPrivate).toBe(first);
    expect(first()).toBe("private-ok");
    expect(model[symbolReader]).toBe(model[symbolReader]);
    expect(model[symbolReader]()).toBe("private-ok");

    target.readPrivate = function (this: PrivateFieldModel): string {
      return this === target ? "rebound-ok" : "wrong-this";
    };
    const rebound = model.readPrivate;
    expect(rebound).not.toBe(first);
    expect(rebound()).toBe("rebound-ok");

    await model.doGenerate();
    await vi.waitFor(() => expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "omSidecar",
      inputTokens: 15_000,
      outputTokens: 10,
      cacheHitTokens: 12_000,
      cacheMissTokens: 3_000,
    })));
    expect(observeCacheOutcomeMock).toHaveBeenCalledWith({
      sessionId: "session-modern",
      callSite: "omSidecar",
      hitTokens: 12_000,
      missTokens: 3_000,
    });
  });

  it("v2/v3 finish usage 入账且 attempt 按真实请求递增", async () => {
    const base = {
      doStream: vi.fn(async () => ({
        stream: stream([{ type: "finish", usage: { inputTokens: 10, outputTokens: 2 } }]),
      })),
    };
    const model = wrapModernModelUsage(base, options());
    await drain((await model.doStream()).stream);
    await drain((await model.doStream()).stream);
    const calls = recordUsageEventMock.mock.calls as unknown as Array<[{ attempt?: number }]>;
    expect(calls.map(([event]) => event.attempt)).toEqual([1, 2]);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "omSidecar",
      inputTokens: 10,
      outputTokens: 2,
    }));
  });

  it("异常与无 finish 流都留 missing", async () => {
    const error = new Error("provider down");
    const model = wrapModernModelUsage({
      doStream: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ stream: stream([{ type: "text-delta", delta: "x" }]) }),
    }, options());
    await expect(model.doStream()).rejects.toBe(error);
    await drain((await model.doStream()).stream);
    expect(recordUsageEventMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_error",
      attempt: 1,
    }));
    expect(recordUsageEventMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      usageState: "missing",
      reason: "provider_stream_without_finish",
      attempt: 2,
    }));
  });

  it("同一 RequestContext 即使 resolver 重建 Proxy，attempt 仍连续", async () => {
    const shared = options();
    const make = () => wrapModernModelUsage({
      doStream: async () => ({ stream: stream([{ type: "finish", usage: { inputTokens: 1 } }]) }),
    }, shared);
    await drain((await make().doStream()).stream);
    await drain((await make().doStream()).stream);
    const calls = recordUsageEventMock.mock.calls as unknown as Array<[{ attempt?: number }]>;
    expect(calls.map(([event]) => event.attempt)).toEqual([1, 2]);
  });
});
