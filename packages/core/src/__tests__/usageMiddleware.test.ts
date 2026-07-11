import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../db/usageRepo.js", () => ({ recordUsageEvent: recordUsageEventMock }));

const { createUsageMiddleware } = await import("../llm/usageMiddleware.js");

function context(): RequestContext {
  return new RequestContext([
    ["sessionId", "session-mw"],
    ["runId", "run-mw"],
  ] as never) as unknown as RequestContext;
}

function middleware() {
  return createUsageMiddleware({
    requestContext: context(),
    callSite: "middleware-test",
    modelId: "glm-test",
    keyOrigin: "env",
  });
}

function streamOf(parts: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("usage middleware", () => {
  beforeEach(() => recordUsageEventMock.mockClear());

  it("wrapGenerate 从返回值记录 usage 与 Anthropic cache creation", async () => {
    const result = {
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 20 },
      providerMetadata: { anthropic: { cacheReadInputTokens: 60, cacheCreationInputTokens: 30 } },
    };
    await middleware().wrapGenerate!({
      doGenerate: async () => result,
      doStream: vi.fn(),
      params: {},
      model: {},
    } as never);

    expect(recordUsageEventMock).toHaveBeenCalledOnce();
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-mw",
      runId: "run-mw",
      callSite: "middleware-test",
      modelId: "glm-test",
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 60,
      cacheCreationTokens: 30,
      attempt: 1,
    }));
  });

  it("wrapGenerate 异常也留一条 missing，且原异常继续抛出", async () => {
    const error = new Error("provider down");
    await expect(middleware().wrapGenerate!({
      doGenerate: async () => { throw error; },
      doStream: vi.fn(),
      params: {},
      model: {},
    } as never)).rejects.toBe(error);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_error",
    }));
  });

  it("wrapStream 截获 finish 记 recorded，并原样转发 part", async () => {
    const parts = [
      { type: "text-delta", textDelta: "ok" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 12, completionTokens: 3 },
        providerMetadata: { anthropic: { cacheReadInputTokens: 8, cacheCreationInputTokens: 2 } },
      },
    ];
    const result = await middleware().wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({ stream: streamOf(parts), rawCall: { rawPrompt: null, rawSettings: {} } }),
      params: {},
      model: {},
    } as never);

    await expect(drain(result.stream)).resolves.toEqual(parts);
    expect(recordUsageEventMock).toHaveBeenCalledOnce();
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 12,
      outputTokens: 3,
      cacheHitTokens: 8,
      cacheCreationTokens: 2,
    }));
  });

  it("流正常结束但没有 finish part 时留 missing", async () => {
    const result = await middleware().wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({
        stream: streamOf([{ type: "text-delta", textDelta: "truncated" }]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      params: {},
      model: {},
    } as never);
    await drain(result.stream);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_stream_without_finish",
    }));
  });

  it("abort 导致流抛错时留 missing，且不吞错误", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("aborted", "AbortError");
    const result = await middleware().wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({
        stream: new ReadableStream({ start(streamController) { streamController.error(error); } }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      params: { abortSignal: controller.signal },
      model: {},
    } as never);

    await expect(drain(result.stream)).rejects.toBe(error);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_aborted",
    }));
  });

  it("同一包装模型的真实 provider 请求 attempt 连续递增", async () => {
    const mw = middleware();
    const invoke = () => mw.wrapGenerate!({
      doGenerate: async () => ({
        text: "ok",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      doStream: vi.fn(),
      params: {},
      model: {},
    } as never);
    await invoke();
    await invoke();
    const calls = recordUsageEventMock.mock.calls as unknown as Array<[{ attempt?: number }]>;
    expect(calls.map(([event]) => event.attempt)).toEqual([1, 2]);
  });

  it("doStream 已发请求但消费者尚未 pull 时，abort 立即留 missing", async () => {
    const controller = new AbortController();
    await middleware().wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({
        stream: new ReadableStream(),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      params: { abortSignal: controller.signal },
      model: {},
    } as never);
    controller.abort();
    await vi.waitFor(() => expect(recordUsageEventMock).toHaveBeenCalledOnce());
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_aborted",
      attempt: 1,
    }));
  });

  it("doStream 已发请求但返回已锁流时留 missing", async () => {
    const stream = new ReadableStream();
    stream.getReader();
    await expect(middleware().wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({
        stream,
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      params: {},
      model: {},
    } as never)).rejects.toThrow(/locked/i);
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "missing",
      reason: "provider_request_error",
    }));
  });
});
