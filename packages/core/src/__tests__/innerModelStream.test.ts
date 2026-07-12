import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
const getDeepseekModelMock = vi.hoisted(() => vi.fn(() => ({ modelId: "mock" })));
const resolveProtocolMock = vi.hoisted(() => vi.fn(() => "openai"));
const branchCallMock = vi.hoisted(() => vi.fn());
const getSessionSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", () => ({
  branchCall: branchCallMock,
  getDeepseekModel: getDeepseekModelMock,
  getSessionSnapshot: getSessionSnapshotMock,
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
    resolveProtocolMock.mockReturnValue("openai");
  });

  it("累积 text delta、回传首字节/finishReason，并把 lane/abort/retry 交给框架", async () => {
    streamTextMock.mockReturnValue({ fullStream: fullStream([
      { type: "text-delta", textDelta: "甲" },
      { type: "text-delta", textDelta: "乙" },
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
      onTextDelta?: (delta: string, raw: string) => void;
    }) => {
      input.onActivity?.();
      input.onActivity?.();
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
      maxTokens: 4096,
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
      maxTokens: 4096,
      streamTextDeltas: true,
    }));
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("BranchCall 单次失败时完整降级原 streamText 路径", async () => {
    getSessionSnapshotMock.mockReturnValue({ sessionId: "s" });
    branchCallMock.mockResolvedValueOnce({
      ok: false,
      reason: "tool_call",
      attempts: 2,
      toolCallRetries: 1,
    });
    streamTextMock.mockReturnValue({ fullStream: fullStream([
      { type: "text-delta", textDelta: "降级成功" },
      { type: "finish", finishReason: "stop" },
    ]) });

    const result = await streamInnerModel({
      callSite: "generateSvg",
      attempt: 4,
      prompt: "画图",
      branchSteeringTail: "只输出 SVG",
      thinking: false,
      temperature: 0.4,
    });

    expect(result.raw).toBe("降级成功");
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(getDeepseekModelMock).toHaveBeenCalledWith(undefined, "flash", expect.objectContaining({
      attempt: 6,
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
