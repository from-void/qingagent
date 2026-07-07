import { describe, expect, it, vi } from "vitest";

// mock @qingagent/core:无站点 global key、无参数(隔离 DB),专注测 header → ModelOverrides 解析
vi.mock("@qingagent/core", () => ({
  SETTING_DEEPSEEK_GLOBAL_KEY: "deepseek_global_key",
  SETTING_MODEL_PARAMS: "model_params",
  getAppSetting: vi.fn(async () => null),
  sanitizeBaseUrl: (raw: string | undefined) => {
    const value = raw?.trim();
    if (!value) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return value.replace(/\/+$/, "");
    } catch {
      return undefined;
    }
  },
  sanitizeModelId: (raw: string | undefined) => {
    const value = raw?.trim();
    return value && /^[A-Za-z0-9._:\/-]+$/.test(value) ? value : undefined;
  },
  validateFetchUrl: vi.fn(async (raw: string) => {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "169.254.169.254" ||
      hostname.startsWith("10.")
    ) {
      throw new Error(`blocked ${hostname}`);
    }
    return url;
  }),
}));

import { resolveRequestModelOverrides } from "../modelOverridesProvider.js";

const VKEY = `sk-${"a".repeat(32)}`;

// 回归:codex review P1 — 自定义 baseURL/协议/模型名必须绑定 visitor key,
// 否则无 key 的请求会借用站点 global/env key 的 Authorization 打到任意 endpoint(凭据泄露)。
describe("resolveRequestModelOverrides — 自定义 endpoint 绑定 visitor key(P1)", () => {
  it("无 visitor key 时,baseUrl/protocol/modelFlash 一律忽略", async () => {
    const r = await resolveRequestModelOverrides({
      visitorKey: null,
      baseUrl: "https://evil.example.com/v1",
      modelFlash: "evil-model",
      modelPro: "evil-pro",
      protocol: "anthropic",
    });
    expect(r.visitorApiKey).toBeUndefined();
    expect(r.baseUrl).toBeUndefined();
    expect(r.modelIds).toBeUndefined();
    expect(r.protocol).toBeUndefined();
  });

  it("空字符串 visitor key 同样视为无 key,忽略自定义 endpoint", async () => {
    const r = await resolveRequestModelOverrides({
      visitorKey: "   ",
      baseUrl: "https://evil.example.com/v1",
      protocol: "anthropic",
    });
    expect(r.baseUrl).toBeUndefined();
    expect(r.protocol).toBeUndefined();
  });

  it("带 visitor key 时,自定义 baseURL/协议/模型名生效", async () => {
    const r = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      modelFlash: "glm-5.2",
      modelPro: "glm-5.2",
      protocol: "anthropic",
    });
    expect(r.visitorApiKey).toBe(VKEY);
    expect(r.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(r.modelIds).toEqual({ flash: "glm-5.2", pro: "glm-5.2" });
    expect(r.protocol).toBe("anthropic");
  });

  it("protocol=anthropic 但缺少合法 baseUrl 时忽略协议 override", async () => {
    const missingBaseUrl = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      protocol: "anthropic",
    });
    const invalidBaseUrl = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl: "notaurl",
      protocol: "anthropic",
    });
    const blockedBaseUrl = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl: "http://127.0.0.1:11434/v1",
      protocol: "anthropic",
    });

    expect(missingBaseUrl.baseUrl).toBeUndefined();
    expect(missingBaseUrl.protocol).toBeUndefined();
    expect(invalidBaseUrl.baseUrl).toBeUndefined();
    expect(invalidBaseUrl.protocol).toBeUndefined();
    expect(blockedBaseUrl.baseUrl).toBeUndefined();
    expect(blockedBaseUrl.protocol).toBeUndefined();
  });

  it.each([
    "http://127.0.0.1:11434/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/v1",
    "http://localhost:8080/v1",
  ])("带 visitor key 但 baseUrl 指向敏感地址时丢弃:%s", async (baseUrl) => {
    const r = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl,
      modelFlash: "safe-model-name",
    });

    expect(r.visitorApiKey).toBe(VKEY);
    expect(r.baseUrl).toBeUndefined();
    expect(r.modelIds).toEqual({ flash: "safe-model-name" });
  });

  it("带 visitor key 但 protocol 非 anthropic → 不设 protocol(默认 openai)", async () => {
    const r = await resolveRequestModelOverrides({ visitorKey: VKEY, protocol: "claude" });
    expect(r.protocol).toBeUndefined();
  });
});

describe("resolveRequestModelOverrides — 模型档位 header", () => {
  it("x-model-tier 不依赖 visitor key,可切换官方 pro/flash", async () => {
    const pro = await resolveRequestModelOverrides({ visitorKey: null, modelTier: "pro" });
    const flash = await resolveRequestModelOverrides({ visitorKey: null, modelTier: "flash" });

    expect(pro.tier).toBe("pro");
    expect(flash.tier).toBe("flash");
  });

  it("非法档位忽略,保持服务端默认 flash", async () => {
    const r = await resolveRequestModelOverrides({ visitorKey: VKEY, modelTier: "ultra" });
    expect(r.tier).toBeUndefined();
  });
});

describe("resolveRequestModelOverrides — vision header 安全解析", () => {
  it("无 x-vision-key 时,vision baseUrl/protocol/model 一律忽略", async () => {
    const r = await resolveRequestModelOverrides({
      visionKey: null,
      visionBaseUrl: "https://evil.example.com/v1",
      visionModel: "evil-vision",
      visionProtocol: "anthropic",
    });
    expect(r.vision).toBeUndefined();
  });

  it("带 x-vision-key 时,解析独立 vision 配置", async () => {
    const r = await resolveRequestModelOverrides({
      visionKey: VKEY,
      visionBaseUrl: "https://vision.example.com/v1/",
      visionModel: "vision-model-1",
      visionProtocol: "openai",
    });
    expect(r.vision).toEqual({
      apiKey: VKEY,
      baseUrl: "https://vision.example.com/v1",
      model: "vision-model-1",
      protocol: "openai",
    });
  });

  it("带 x-vision-key 但 vision endpoint 字段非法时只保留 key,不透传脏 endpoint", async () => {
    const r = await resolveRequestModelOverrides({
      visionKey: VKEY,
      visionBaseUrl: "file:///etc/passwd",
      visionModel: "bad model with spaces",
      visionProtocol: "unknown",
    });
    expect(r.vision).toEqual({ apiKey: VKEY });
  });
});
