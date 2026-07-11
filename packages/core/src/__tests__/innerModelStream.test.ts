import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
const getDeepseekModelMock = vi.hoisted(() => vi.fn(() => ({ modelId: "mock" })));
const resolveProtocolMock = vi.hoisted(() => vi.fn(() => "openai"));

vi.mock("ai", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", () => ({
  getDeepseekModel: getDeepseekModelMock,
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
