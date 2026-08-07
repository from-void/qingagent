import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";

const recordUsageEventMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  recordUsageEvent: recordUsageEventMock,
}));

const {
  createUsageMiddleware,
  isCompleteUsage,
  modelCallOutputDelta,
  observeModelUsageConsistency,
  recordModelCallOutcome,
  serializeModelCallPrompt,
} = await import("../llm/usageMiddleware.js");
interface TestWireAttempt {
  wireAttemptSeq: number;
  startedAt: number;
  requestEstimate: { uncachedInputText?: string };
  responseStatus: number | null;
  responseReceivedAt: number | null;
  endedAt: number | null;
  usage: {
    completeness: "complete" | "partial-input";
    usage: Record<string, unknown>;
  } | null;
  outputText: string;
  parseStoppedReason: "frame_limit" | "total_limit" | "parse_error" | null;
  transportError: string | null;
}

interface TestWireScope {
  wireAttemptSeq: number;
  attempts: TestWireAttempt[];
  finalized: boolean;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onFinalizeTimeout: (scope: TestWireScope) => void;
}

function context(): RequestContext {
  return new RequestContext([
    ["sessionId", "session-mw"],
    ["runId", "run-mw"],
  ] as never) as unknown as RequestContext;
}

function middleware() {
  return createUsageMiddleware({
    requestContext: context(),
    callSite: "webSearch",
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

function observedAttempt(overrides: Partial<TestWireAttempt> = {}): TestWireAttempt {
  return {
    wireAttemptSeq: 1,
    startedAt: Date.now(),
    requestEstimate: { uncachedInputText: JSON.stringify({ messages: [{ content: "真实请求" }] }) },
    responseStatus: 200,
    responseReceivedAt: Date.now(),
    endedAt: Date.now(),
    usage: null,
    outputText: "半截输出",
    parseStoppedReason: null,
    transportError: null,
    ...overrides,
  };
}

function observedScope(attempts: TestWireAttempt[]): TestWireScope {
  return {
    wireAttemptSeq: attempts.length,
    attempts,
    finalized: false,
    idleTimeoutMs: 5 * 60_000,
    idleTimer: null,
    onFinalizeTimeout: () => {},
  };
}

describe("usage middleware", () => {
  beforeEach(() => recordUsageEventMock.mockClear());

  it("有 reason 但 usage 计数完整时仍记 recorded 并保留 reason", async () => {
    await recordModelCallOutcome({
      sessionId: "session-reason-with-usage",
      callSite: "webSearch",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
      attempt: 1,
      transport: "manual-api",
      startedAt: Date.now(),
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        promptCacheHitTokens: 100,
        promptCacheMissTokens: 20,
      },
      usageEstimate: {
        uncachedInputText: "这份估算不得混入 provider 实测",
        outputText: "估算输出",
      },
      reason: "provider_stream_error_part",
    });

    expect(recordUsageEventMock).toHaveBeenCalledOnce();
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "recorded",
      reason: "provider_stream_error_part",
      inputTokens: 120,
      outputTokens: 30,
      cacheHitTokens: 100,
      cacheMissTokens: 20,
    }));
  });

  it("统一终态以调用开始时刻固化北京时间高峰金额", async () => {
    const previous = process.env.DEEPSEEK_PEAK_PRICING_JSON;
    process.env.DEEPSEEK_PEAK_PRICING_JSON = JSON.stringify({ enabled: true });
    try {
      const startedAt = Date.parse("2026-08-06T01:30:00.000Z");
      await recordModelCallOutcome({
        sessionId: "session-peak",
        callSite: "agentChat",
        modelId: "deepseek-v4-flash",
        keyOrigin: "visitor",
        attempt: 1,
        transport: "manual-api",
        startedAt,
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          promptCacheHitTokens: 100,
          promptCacheMissTokens: 20,
        },
      });

      expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
        occurredAt: startedAt,
        costCny: expect.closeTo(0.000164, 12),
        pricingTier: "peak",
        pricingMultiplier: 2,
      }));
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_PEAK_PRICING_JSON;
      else process.env.DEEPSEEK_PEAK_PRICING_JSON = previous;
    }
  });

  it("recorded 统一要求输入与输出计数完整，单边 SDK usage 只能降为 estimated", async () => {
    expect(isCompleteUsage({ inputTokens: 12 })).toBe(false);
    expect(isCompleteUsage({ outputTokens: 3 })).toBe(false);
    expect(isCompleteUsage({ inputTokens: 0, outputTokens: 0 })).toBe(true);

    await recordModelCallOutcome({
      sessionId: "partial-sdk",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "mastra-v2-v3",
      startedAt: Date.now(),
      usage: { inputTokens: 12 },
      usageEstimate: { outputText: "补估输出" },
    });
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "estimated",
      inputTokens: 12,
      outputTokens: expect.any(Number),
    }));
  });

  it.each([
    "provider_stream_error",
    "provider_stream_error_part",
    "provider_stream_without_finish",
    "provider_stream_cancelled",
    "provider_request_error",
    "provider_stream_invalid",
    "provider_request_aborted",
  ])("响应 2xx 且无完整 usage 的 %s 按 wire 请求/输出素材记 estimated", async (reason) => {
    await recordModelCallOutcome({
      sessionId: `wire-${reason}`,
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "mastra-v2-v3",
      startedAt: Date.now(),
      usage: null,
      usageEstimate: { uncachedInputText: "" },
      reason,
      wireScope: observedScope([observedAttempt()]),
    });
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "estimated",
      reason,
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    }));
    const calls = recordUsageEventMock.mock.calls as unknown as Array<[Record<string, number>]>;
    const event = calls.at(-1)![0];
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.outputTokens).toBeGreaterThan(0);
  });

  it("异常终态但 wire 已捕获完整 usage 时仍 recorded", async () => {
    await recordModelCallOutcome({
      sessionId: "wire-complete-error",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "mastra-v2-v3",
      startedAt: Date.now(),
      usage: null,
      reason: "provider_stream_error",
      wireScope: observedScope([observedAttempt({
        usage: {
          completeness: "complete",
          usage: { prompt_tokens: 41, completion_tokens: 9 },
        },
      })]),
    });
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "recorded",
      inputTokens: 41,
      outputTokens: 9,
      reason: "provider_stream_error",
    }));
  });

  it("SDK 与 wire 完整 usage 做双解析一致性检查", async () => {
    const observations: Array<{ consistent: boolean }> = [];
    const stop = observeModelUsageConsistency((observation) => observations.push(observation));
    try {
      await recordModelCallOutcome({
        sessionId: "wire-sdk-consistency",
        callSite: "agentChat",
        modelId: "deepseek-v4-flash",
        keyOrigin: "env",
        attempt: 1,
        transport: "mastra-v2-v3",
        startedAt: Date.now(),
        usage: { inputTokens: 41, outputTokens: 9 },
        wireScope: observedScope([observedAttempt({
          usage: {
            completeness: "complete",
            usage: { prompt_tokens: 41, completion_tokens: 9 },
          },
        })]),
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ consistent: true });
    } finally {
      stop();
    }
  });

  it("无响应单独落 billing_unknown，绝不落 estimated/missing", async () => {
    await recordModelCallOutcome({
      sessionId: "wire-no-response",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "mastra-v2-v3",
      startedAt: Date.now(),
      usage: null,
      reason: "provider_request_error",
      wireScope: observedScope([observedAttempt({
        responseStatus: null,
        responseReceivedAt: null,
        outputText: "",
        transportError: "TypeError",
      })]),
    });
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "billing_unknown",
      reason: "no_response",
    }));
  });

  it("Anthropic message_start 部分 usage 只记 estimated 且保留真实 input", async () => {
    await recordModelCallOutcome({
      sessionId: "wire-anthropic-partial",
      callSite: "webSearch",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "manual-api",
      startedAt: Date.now(),
      usage: null,
      reason: "search_links_early_abort",
      wireScope: observedScope([observedAttempt({
        usage: {
          completeness: "partial-input",
          usage: { input_tokens: 37, cache_read_input_tokens: 11 },
        },
      })]),
    });
    expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
      usageState: "estimated",
      reason: "wire-partial:search_links_early_abort",
      inputTokens: 37,
      cacheHitTokens: 11,
      cacheAccountingState: "unknown",
    }));
  });

  it("非终态物理尝试按行内容定档，complete/可估算照常计入，只有 no_response 为零值 unknown", async () => {
    await recordModelCallOutcome({
      sessionId: "wire-multi-attempt",
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "env",
      attempt: 1,
      transport: "mastra-v2-v3",
      startedAt: Date.now(),
      usage: { inputTokens: 13, outputTokens: 5 },
      wireScope: observedScope([
        observedAttempt({
          wireAttemptSeq: 1,
          usage: { completeness: "complete", usage: { prompt_tokens: 7, completion_tokens: 2 } },
        }),
        observedAttempt({
          wireAttemptSeq: 2,
          responseStatus: null,
          responseReceivedAt: null,
          outputText: "",
        }),
        observedAttempt({ wireAttemptSeq: 3 }),
      ]),
    });
    const calls = recordUsageEventMock.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.map(([event]) => ({
      state: event.usageState,
      input: event.inputTokens,
      output: event.outputTokens,
    }))).toEqual([
      { state: "recorded", input: 7, output: 2 },
      { state: "billing_unknown", input: undefined, output: undefined },
      { state: "recorded", input: 13, output: 5 },
    ]);
  });

  it("H9 不读不 cancel 时响应头计时直接落一条 finalize_timeout，迟到终态不双写", async () => {
    vi.useFakeTimers();
    try {
      const {
        beginWireAttempt,
        createWireScope,
        observeWireResponse,
      } = await import("../llm/wireUsage.js");
      let scope!: TestWireScope;
      const base = {
        sessionId: "wire-h9",
        callSite: "agentChat" as const,
        modelId: "deepseek-v4-flash",
        keyOrigin: "env" as const,
        attempt: 1,
        transport: "mastra-v2-v3" as const,
        startedAt: Date.now(),
        usage: null,
      };
      scope = createWireScope({
        idleTimeoutMs: 25,
        onFinalizeTimeout: () => {
          void recordModelCallOutcome({
            ...base,
            reason: "finalize_timeout",
            wireScope: scope as never,
          });
        },
      });
      const attempt = beginWireAttempt(scope, "https://example.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "不能等 chunk" }] }),
      });
      observeWireResponse(scope, attempt, new Response(new ReadableStream<Uint8Array>({
        pull() {
          // 永远无 chunk。
        },
      }), { headers: { "content-type": "text/event-stream" } }));

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(recordUsageEventMock).toHaveBeenCalledOnce());
      expect(recordUsageEventMock).toHaveBeenCalledWith(expect.objectContaining({
        usageState: "estimated",
        reason: "finalize_timeout",
      }));
      await recordModelCallOutcome({
        ...base,
        usage: { inputTokens: 9, outputTokens: 1 },
        wireScope: scope as never,
      });
      expect(recordUsageEventMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("估算素材面对循环 prompt 与脏 stream part 时 fail-closed", () => {
    const circular: { prompt?: unknown; self?: unknown } = { prompt: ["ok"] };
    circular.self = circular;
    circular.prompt = circular;

    expect(serializeModelCallPrompt(circular)).toBe("");
    expect(serializeModelCallPrompt(null)).toBe("");
    expect(modelCallOutputDelta({ type: "text-delta", delta: "正文" })).toBe("正文");
    expect(modelCallOutputDelta({ type: "reasoning-delta", delta: "思考" })).toBe("思考");
    expect(modelCallOutputDelta({ type: "tool-input-delta", delta: "{\"a\":" })).toBe("{\"a\":");
    expect(modelCallOutputDelta({ type: "text-delta", delta: 42 })).toBe("");
    expect(modelCallOutputDelta({ type: "error", delta: "内部错误" })).toBe("");
  });

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
      callSite: "webSearch",
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

  it("主链流收到部分正文后被停止，以 prompt 与已收 delta 记 estimated", async () => {
    const controller = new AbortController();
    const agentMiddleware = createUsageMiddleware({
      requestContext: context(),
      callSite: "agentChat",
      modelId: "deepseek-v4-flash",
      keyOrigin: "visitor",
    });
    const result = await agentMiddleware.wrapStream!({
      doGenerate: vi.fn(),
      doStream: async () => ({
        stream: new ReadableStream({
          start(streamController) {
            streamController.enqueue({ type: "text-delta", delta: "半截回复" });
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      params: {
        abortSignal: controller.signal,
        prompt: [{ role: "user", content: [{ type: "text", text: "请分析这份中文资料" }] }],
      },
      model: {},
    } as never);

    const reader = result.stream.getReader();
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", delta: "半截回复" },
    });
    controller.abort();
    await vi.waitFor(() => expect(recordUsageEventMock).toHaveBeenCalledOnce());
    await reader.cancel();

    const calls = recordUsageEventMock.mock.calls as unknown as Array<[{
      inputTokens?: number;
      outputTokens?: number;
      usageState?: string;
      reason?: string;
    }]>;
    const [event] = calls[0]!;
    expect(event).toMatchObject({
      usageState: "estimated",
      reason: "provider_request_aborted",
    });
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(event.outputTokens).toBeGreaterThan(0);
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
