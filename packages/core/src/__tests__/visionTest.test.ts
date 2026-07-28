import { beforeEach, describe, expect, it, vi } from "vitest";

// 回归(验收 Agent B 发现):testVisionConnection 早期用 result.textStream 迭代,上游报错
// (401 鉴权 / 非 API 端点 / 协议不匹配 / 限流)时 textStream 静默结束、不抛 → 把失败的连通性
// 测试当成功(ok:true 假阳性)。改用 fullStream 检测 error part 并抛出。本测试锁死该行为。

const streamTextMock = vi.hoisted(() => vi.fn());
const getVisionModelMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", async (importActual) => {
  const actual = await importActual<typeof import("../llm/modelConfig.js")>();
  return { ...actual, getVisionModel: getVisionModelMock };
});

const { testVisionConnection, VISION_TEST_TIMEOUT_MS } =
  await import("../llm/visionTest.js");

type Part =
  | { type: "text-delta"; textDelta: string }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown }
  | { type: "abort" };
function fullStream(parts: Part[]): AsyncIterable<Part> {
  return (async function* () {
    for (const p of parts) yield p;
  })();
}

const VISION = { apiKey: "k", baseUrl: "https://x/v1", model: "m", protocol: "openai" as const };

describe("testVisionConnection", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    getVisionModelMock.mockReset();
    getVisionModelMock.mockResolvedValue({});
  });

  it("上游 error part(如鉴权失败)→ 抛错,不当成功", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "error", error: new Error("令牌已过期或验证不正确") }]),
    });
    await expect(testVisionConnection(VISION)).rejects.toThrow(/令牌已过期/);
  });

  it("正常往返(无 error,推理模型正文可能为空)→ 不抛(视为连通)", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "finish", finishReason: "length" }]),
    });
    await expect(testVisionConnection(VISION)).resolves.toBeUndefined();
  });

  it("有文本输出 → 不抛", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "text-delta", textDelta: "ok" }, { type: "finish", finishReason: "stop" }]),
    });
    await expect(testVisionConnection(VISION)).resolves.toBeUndefined();
  });

  it("fullStream abort part 判为失败，不把中止闭流当成功", async () => {
    streamTextMock.mockReturnValue({ fullStream: fullStream([{ type: "abort" }]) });

    await expect(testVisionConnection(VISION)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("调用方中止后 fullStream 静默闭流仍抛原始原因", async () => {
    const caller = new AbortController();
    const reason = new DOMException("用户取消图像连接测试", "AbortError");
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        caller.abort(reason);
        if (false) yield { type: "abort" as const };
      })(),
    });

    const pending = testVisionConnection(VISION, caller.signal);

    await expect(pending).rejects.toBe(reason);
  });

  it("getVisionModel 返回 null(配置未生效)→ 抛错", async () => {
    getVisionModelMock.mockResolvedValue(null);
    await expect(testVisionConnection(VISION)).rejects.toThrow(/未生效/);
  });

  it("12 秒计时从 DNS 配置预检前开始", async () => {
    vi.useFakeTimers();
    getVisionModelMock.mockImplementation(async (requestContext: {
      get(key: string): unknown;
    }) => {
      const signal = requestContext.get("abortSignal") as AbortSignal;
      return await new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    try {
      const pending = testVisionConnection(VISION);
      const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(VISION_TEST_TIMEOUT_MS);
      await rejection;
      expect(streamTextMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
