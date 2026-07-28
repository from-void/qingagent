import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
const getDeepseekModelMock = vi.hoisted(() => vi.fn(() => ({
  modelId: "mock",
  specificationVersion: "v2",
})));
const resolveProtocolMock = vi.hoisted(() => vi.fn(() => "openai"));
const resolveModelParamsMock = vi.hoisted(() => vi.fn(() => ({})));
const defaultBranchBufferBytes = vi.hoisted(() => 4 * 1024 * 1024);
const branchCallMock = vi.hoisted(() => vi.fn());
const getSessionSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("ai-v5", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", () => ({
  branchCall: branchCallMock,
  DEFAULT_BRANCH_STREAM_BUFFER_BYTES: defaultBranchBufferBytes,
  getDeepseekModel: getDeepseekModelMock,
  getSessionSnapshot: getSessionSnapshotMock,
  resolveModelParams: resolveModelParamsMock,
  resolveProtocol: resolveProtocolMock,
}));

const { streamInnerModel } = await import("../llm/innerModelStream.js");

function fullStream(parts: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

describe("streamInnerModel", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    getDeepseekModelMock.mockClear();
    branchCallMock.mockReset();
    getSessionSnapshotMock.mockReset();
    getSessionSnapshotMock.mockReturnValue(null);
    resolveModelParamsMock.mockReset();
    resolveModelParamsMock.mockReturnValue({});
    resolveProtocolMock.mockReturnValue("openai");
  });

  it("累积 text delta、回传首字节/finishReason，并把 lane/abort/retry 交给框架", async () => {
    streamTextMock.mockReturnValue({ fullStream: fullStream([
      { type: "text-delta", text: "甲" },
      { type: "text-delta", text: "乙" },
      { type: "finish", finishReason: "stop" },
    ]) });
    const starts: number[] = [];
    const deltas: string[] = [];
    const abortController = new AbortController();
    const result = await streamInnerModel({
      callSite: "writeDraft",
      lane: 3,
      messages: [{ role: "user", content: "写" }],
      thinking: false,
      temperature: 0.4,
      abortSignal: abortController.signal,
      maxRetries: 2,
      maxTokens: 65_536,
      onContentStart: (ms) => starts.push(ms),
      onContentDelta: (_delta, raw) => deltas.push(raw),
    });

    expect(result).toMatchObject({ raw: "甲乙", finishReason: "stop" });
    expect(starts).toHaveLength(1);
    expect(deltas).toEqual(["甲", "甲乙"]);
    expect(getDeepseekModelMock).toHaveBeenCalledWith(undefined, "flash", {
      callSite: "writeDraft",
      lane: 3,
      thinking: false,
    });
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: abortController.signal,
      maxRetries: 2,
      maxOutputTokens: 65_536,
      temperature: 0.4,
    }));
  });

  it("fullStream error part 显式抛出，不把错误当空文本成功", async () => {
    const error = new Error("upstream failed");
    streamTextMock.mockReturnValue({ fullStream: fullStream([{ type: "error", error }]) });
    await expect(streamInnerModel({
      callSite: "generateSvg",
      prompt: "画图",
      thinking: false,
      temperature: 0.4,
    })).rejects.toBe(error);
  });

  it("有快照时借道并透传 lane/采样/流式回调，不再发独立 streamText", async () => {
    const snapshot = { sessionId: "s" };
    getSessionSnapshotMock.mockReturnValue(snapshot);
    branchCallMock.mockImplementationOnce(async (input: {
      onActivity?: () => void;
      onRawContentStart?: (observedAt: number) => void;
      onTextDelta?: (delta: string, raw: string) => void;
    }) => {
      input.onActivity?.();
      input.onActivity?.();
      input.onRawContentStart?.(Date.now());
      input.onTextDelta?.("甲乙", "甲乙");
      return { ok: true, text: "甲乙", finishReason: "stop", attempts: 1, toolCallRetries: 0 };
    });
    const deltas: string[] = [];
    const starts: number[] = [];
    let activities = 0;

    const result = await streamInnerModel({
      callSite: "writeDraft",
      lane: 2,
      attempt: 4,
      messages: [{ role: "user", content: "fallback" }],
      branchSteeringTail: "不要调用工具，输出 QingML",
      thinking: false,
      temperature: 0.4,
      maxTokens: 65_536,
      onActivity: () => { activities += 1; },
      onContentStart: (ms) => starts.push(ms),
      onContentDelta: (_delta, raw) => deltas.push(raw),
    });

    expect(result).toMatchObject({ raw: "甲乙", finishReason: "stop" });
    expect(activities).toBe(2);
    expect(starts).toHaveLength(1);
    expect(deltas).toEqual(["甲乙"]);
    expect(branchCallMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionSnapshot: snapshot,
      callSite: "writeDraft",
      lane: 2,
      attempt: 4,
      thinking: false,
      temperature: 0.4,
      maxTokens: 65_536,
      maxBufferedTextBytes: defaultBranchBufferBytes,
      streamTextDeltas: true,
    }));
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("BranchCall 见字后失败时先重置候选再降级，且多字节 delta 按新候选重新累积", async () => {
    getSessionSnapshotMock.mockReturnValue({ sessionId: "s" });
    branchCallMock.mockImplementationOnce(async (input: {
      onActivity?: () => void;
      onRawContentStart?: (observedAt: number) => void;
      onTextDelta?: (delta: string, raw: string, observedAt: number) => void;
    }) => {
      input.onActivity?.();
      input.onRawContentStart?.(Date.now());
      input.onTextDelta?.("废弃😀", "废弃😀", Date.now());
      return {
        ok: false,
        reason: "tool_call",
        attempts: 2,
        toolCallRetries: 1,
      };
    });
    streamTextMock.mockReturnValue({ fullStream: fullStream([
      { type: "text-delta", text: "降级" },
      { type: "text-delta", text: "成功😀" },
      { type: "finish", finishReason: "stop" },
    ]) });
    const starts: number[] = [];
    const events: string[] = [];
    let currentBytes = 0;

    const result = await streamInnerModel({
      callSite: "generateSvg",
      attempt: 4,
      prompt: "画图",
      branchSteeringTail: "只输出 SVG",
      thinking: false,
      temperature: 0.4,
      onContentStart: (ms) => starts.push(ms),
      onContentReset: () => {
        currentBytes = 0;
        events.push("reset");
      },
      onContentDelta: (delta) => {
        currentBytes += Buffer.byteLength(delta, "utf8");
        events.push(`delta:${delta}`);
      },
    });

    expect(result.raw).toBe("降级成功😀");
    expect(starts).toHaveLength(1);
    expect(events).toEqual(["delta:废弃😀", "reset", "delta:降级", "delta:成功😀"]);
    expect(currentBytes).toBe(Buffer.byteLength("降级成功😀", "utf8"));
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(getDeepseekModelMock).toHaveBeenCalledWith(undefined, "flash", expect.objectContaining({
      attempt: 6,
    }));
  });

  it("用户三项采样覆盖在 branch/fallback wire 保持一致", async () => {
    getSessionSnapshotMock.mockReturnValue({ sessionId: "s" });
    resolveModelParamsMock.mockReturnValue({
      temperature: 0.73,
      topP: 0.82,
      maxOutputTokens: 3456,
    });
    branchCallMock.mockResolvedValueOnce({
      ok: false,
      reason: "provider_error",
      attempts: 1,
      toolCallRetries: 0,
    });
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "finish", finishReason: "stop" }]),
    });

    await streamInnerModel({
      callSite: "writeDraft",
      prompt: "fallback",
      branchSteeringTail: "branch",
      thinking: false,
      temperature: 0.4,
      maxTokens: 8192,
    });

    expect(branchCallMock).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.73,
      topP: 0.82,
      maxTokens: 3456,
    }));
    // fallback 直接走当前 AI SDK 5 transport，使用 maxOutputTokens；
    // branchCall 仍以内部兼容参数 maxTokens 接收同一个覆盖值。
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.73,
      topP: 0.82,
      maxOutputTokens: 3456,
    }));
  });

  it("Anthropic thinking 使用原生 providerOptions 且不传 temperature", async () => {
    resolveProtocolMock.mockReturnValue("anthropic");
    streamTextMock.mockReturnValue({ fullStream: fullStream([{ type: "finish", finishReason: "stop" }]) });
    await streamInnerModel({
      callSite: "writeDraft",
      prompt: "推理",
      thinking: true,
      temperature: 0.3,
    });
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } } },
    }));
    expect(streamTextMock.mock.calls[0]![0]).not.toHaveProperty("temperature");
  });
});
