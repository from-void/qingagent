import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { DEEPSEEK_FILE_SENTINEL_URL_RE } from "../llm/deepseekFiles.js";

const compatibleOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const createOpenAICompatibleMock = vi.hoisted(() => vi.fn((options: Record<string, unknown>) => {
  compatibleOptions.push(options);
  return {
    chatModel: (modelId: string) => ({ modelId, provider: options.name }),
  };
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ modelId })),
}));
vi.mock("ai-v5", async (importActual) => {
  const actual = await importActual<typeof import("ai-v5")>();
  return {
    ...actual,
    wrapLanguageModel: ({ model }: { model: unknown }) => model,
  };
});

const {
  getVisionModel,
  getVisionModelWithConfig,
} = await import("../llm/modelConfig.js");

function requestContext(overrides: Record<string, unknown>): RequestContext {
  return new RequestContext([["modelOverrides", overrides]] as never) as unknown as RequestContext;
}

afterEach(() => {
  compatibleOptions.length = 0;
  createOpenAICompatibleMock.mockClear();
});

describe("vision provider construction", () => {
  it("DeepSeek provider 以函数声明哨兵 supportedUrls 并挂载 wire transform", async () => {
    const rc = requestContext({ provider: "deepseek", visitorApiKey: "sk-deepseek-vision" });

    const resolved = await getVisionModelWithConfig(rc, { callSite: "readImage" });

    expect(resolved?.config.provider).toBe("deepseek");
    expect(compatibleOptions).toHaveLength(1);
    const options = compatibleOptions[0]!;
    expect(options.name).toBe("deepseek");
    expect(options.supportedUrls).toBeTypeOf("function");
    expect((options.supportedUrls as () => Record<string, RegExp[]>)()).toEqual({
      "image/*": [DEEPSEEK_FILE_SENTINEL_URL_RE],
    });
    expect(options.transformRequestBody).toBeTypeOf("function");
  });

  it("Kimi 保留专属 transform，custom 不声明哨兵 supportedUrls", async () => {
    await getVisionModelWithConfig(requestContext({
      provider: "kimi",
      visitorApiKey: "sk-kimi-vision",
    }));
    expect(compatibleOptions[0]?.name).toBe("kimi");
    expect(compatibleOptions[0]?.supportedUrls).toBeUndefined();
    expect(compatibleOptions[0]?.transformRequestBody).toBeTypeOf("function");

    await getVisionModelWithConfig(requestContext({
      provider: "deepseek",
      vision: {
        apiKey: "sk-custom-vision",
        baseUrl: "https://1.1.1.1/v1",
        model: "custom-vision",
      },
    }));
    expect(compatibleOptions[1]?.supportedUrls).toBeUndefined();
    expect(compatibleOptions[1]?.transformRequestBody).toBeUndefined();
  });

  it("getVisionModel 薄壳仍返回模型实例", async () => {
    const model = await getVisionModel(requestContext({
      provider: "deepseek",
      visitorApiKey: "sk-thin-wrapper",
    }));
    expect((model as { modelId?: string } | null)?.modelId).toBe("deepseek-v4-flash-vision-exp");
  });
});
