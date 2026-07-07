import { describe, expect, it } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  anthropicBaseUrl,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL_IDS,
  MODEL_OVERRIDES_CONTEXT_KEY,
  resolveBaseUrl,
  resolveModelId,
  resolveModelTier,
  resolveProtocol,
} from "../llm/modelConfig.js";

// 防御性解析:baseURL / 模型别名来自访客 header(不可信),必须枚举脏形态确保非法回退官方默认。
function ctx(overrides: unknown): RequestContext {
  return new RequestContext([[MODEL_OVERRIDES_CONTEXT_KEY, overrides]]);
}

describe("resolveBaseUrl", () => {
  it("无 override / 空对象 → 官方默认", () => {
    expect(resolveBaseUrl()).toBe(DEEPSEEK_BASE_URL);
    expect(resolveBaseUrl(ctx({}))).toBe(DEEPSEEK_BASE_URL);
    expect(resolveBaseUrl(ctx({ baseUrl: undefined }))).toBe(DEEPSEEK_BASE_URL);
  });

  it("合法自定义 baseURL 生效,并去掉尾部斜杠", () => {
    expect(resolveBaseUrl(ctx({ baseUrl: "https://proxy.example.com/v1" }))).toBe(
      "https://proxy.example.com/v1",
    );
    expect(resolveBaseUrl(ctx({ baseUrl: "https://proxy.example.com/v1/" }))).toBe(
      "https://proxy.example.com/v1",
    );
    expect(resolveBaseUrl(ctx({ baseUrl: "  http://127.0.0.1:8000/v1  " }))).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  it.each(["", "   ", "not a url", "javascript:alert(1)", "ftp://x/v1", "//noproto/v1", "x".repeat(301)])(
    "非法 baseURL 回退官方默认 [%#]",
    (bad) => {
      expect(resolveBaseUrl(ctx({ baseUrl: bad }))).toBe(DEEPSEEK_BASE_URL);
    },
  );
});

describe("resolveModelId", () => {
  it("无 override / 空对象 → 官方默认(分 tier)", () => {
    expect(resolveModelId()).toBe(DEEPSEEK_MODEL_IDS.flash);
    expect(resolveModelId(ctx({}), "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
    expect(resolveModelId(ctx({}), "pro")).toBe(DEEPSEEK_MODEL_IDS.pro);
    expect(resolveModelId(ctx({ modelIds: {} }), "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
  });

  it("合法自定义别名生效(支持 org/model:tag 形态)", () => {
    expect(resolveModelId(ctx({ modelIds: { flash: "deepseek-v5-flash" } }), "flash")).toBe(
      "deepseek-v5-flash",
    );
    expect(resolveModelId(ctx({ modelIds: { pro: "vendor/model-v2:latest" } }), "pro")).toBe(
      "vendor/model-v2:latest",
    );
  });

  it("只覆盖对应 tier,另一 tier 仍走默认", () => {
    const c = ctx({ modelIds: { flash: "custom-flash" } });
    expect(resolveModelId(c, "flash")).toBe("custom-flash");
    expect(resolveModelId(c, "pro")).toBe(DEEPSEEK_MODEL_IDS.pro);
  });

  it("当前档位为 pro 时,默认 flash 出口解析到 pro,且自定义 pro 别名生效", () => {
    expect(resolveModelTier(ctx({ tier: "pro" }))).toBe("pro");
    expect(resolveModelId(ctx({ tier: "pro" }), "flash")).toBe(DEEPSEEK_MODEL_IDS.pro);
    expect(resolveModelId(ctx({ tier: "pro", modelIds: { pro: "custom-pro" } }), "flash")).toBe(
      "custom-pro",
    );
  });

  it("当前档位缺省/非法时仍是 flash;显式请求 pro 不被 flash 档覆盖", () => {
    expect(resolveModelTier(ctx({}))).toBe("flash");
    expect(resolveModelTier(ctx({ tier: "ultra" }))).toBe("flash");
    expect(resolveModelId(ctx({ tier: "flash" }), "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
    expect(resolveModelId(ctx({ tier: "flash" }), "pro")).toBe(DEEPSEEK_MODEL_IDS.pro);
  });

  it.each(["", "   ", "has space", "bad|pipe", "emoji😀", "x".repeat(121)])(
    "非法别名回退官方默认 [%#]",
    (bad) => {
      expect(resolveModelId(ctx({ modelIds: { flash: bad } }), "flash")).toBe(DEEPSEEK_MODEL_IDS.flash);
    },
  );
});

describe("resolveProtocol", () => {
  it("默认 openai;仅精确 anthropic 生效,其余(含大小写/别名)回退 openai", () => {
    expect(resolveProtocol()).toBe("openai");
    expect(resolveProtocol(ctx({}))).toBe("openai");
    expect(resolveProtocol(ctx({ protocol: "openai" }))).toBe("openai");
    expect(resolveProtocol(ctx({ protocol: "ANTHROPIC" }))).toBe("openai");
    expect(resolveProtocol(ctx({ protocol: "claude" }))).toBe("openai");
    expect(resolveProtocol(ctx({ protocol: "anthropic" }))).toBe("anthropic");
  });
});

describe("anthropicBaseUrl", () => {
  it("不含 /vN 时补 /v1;已含 /vN 保留;去尾部斜杠", () => {
    // 用户按 Claude Code 习惯填到 /api/anthropic(不带 /v1)→ 补齐
    expect(anthropicBaseUrl("https://open.bigmodel.cn/api/anthropic")).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1",
    );
    expect(anthropicBaseUrl("https://open.bigmodel.cn/api/anthropic/")).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1",
    );
    expect(anthropicBaseUrl("https://host/api/anthropic/v1")).toBe("https://host/api/anthropic/v1");
    expect(anthropicBaseUrl("https://host/v2")).toBe("https://host/v2");
  });
});
