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

const { testVisionConnection } = await import("../llm/visionTest.js");

type Part = { type: "text-delta"; textDelta: string } | { type: "finish"; finishReason: string } | { type: "error"; error: unknown };
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

  it("getVisionModel 返回 null(配置未生效)→ 抛错", async () => {
    getVisionModelMock.mockResolvedValue(null);
    await expect(testVisionConnection(VISION)).rejects.toThrow(/未生效/);
  });
});
