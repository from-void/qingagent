import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock @qingagent/core:无站点 global key、无参数(隔离 DB),专注测 header → ModelOverrides 解析
const mockCore = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store, getAppSetting: vi.fn(async (key: string) => store.get(key) ?? null) };
});

vi.mock("@qingagent/core", async () => ({
  SETTING_DEEPSEEK_GLOBAL_KEY: "deepseek_global_key",
  SETTING_KIMI_GLOBAL_KEY: "kimi_global_key",
  SETTING_MODEL_PROVIDER: "model_provider",
  SETTING_MODEL_PARAMS: "model_params",
  getAppSetting: mockCore.getAppSetting,
  // 归一化用真实 canonical 实现(纯函数、无 DB 依赖),避免测试里另写一套口径失真。
  sanitizeBaseUrl: (await import("../../../core/src/llm/modelBaseUrl.js")).sanitizeBaseUrl,
  sanitizeModelId: (raw: string | undefined) => {
    const value = raw?.trim();
    return value && /^[A-Za-z0-9._:\/-]+$/.test(value) ? value : undefined;
  },
  validateModelFetchUrl: vi.fn(async (raw: string) => {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "169.254.169.254" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("[fc") ||
      hostname.startsWith("[fd")
    ) {
      throw new Error(`blocked ${hostname}`);
    }
    return url;
  }),
}));

import {
  invalidateModelOverridesCache,
  resolveRequestModelOverrides,
} from "../modelOverridesProvider.js";

const VKEY = `sk-${"a".repeat(32)}`;
const originalProviderEnv = process.env.QINGAGENT_MODEL_PROVIDER;

beforeEach(() => {
  mockCore.store.clear();
  invalidateModelOverridesCache();
  delete process.env.QINGAGENT_MODEL_PROVIDER;
});

afterEach(() => {
  if (originalProviderEnv === undefined) delete process.env.QINGAGENT_MODEL_PROVIDER;
  else process.env.QINGAGENT_MODEL_PROVIDER = originalProviderEnv;
});

describe("resolveRequestModelOverrides — provider 优先级", () => {
  it("visitor > db > env > 默认，并只注入当前 provider 的 global key", async () => {
    expect((await resolveRequestModelOverrides({})).provider).toBe("deepseek");

    process.env.QINGAGENT_MODEL_PROVIDER = "kimi";
    invalidateModelOverridesCache();
    expect((await resolveRequestModelOverrides({})).provider).toBe("kimi");

    mockCore.store.set("model_provider", "deepseek");
    mockCore.store.set("deepseek_global_key", "deepseek-db-key");
    mockCore.store.set("kimi_global_key", "kimi-db-key");
    invalidateModelOverridesCache();
    await expect(resolveRequestModelOverrides({})).resolves.toMatchObject({
      provider: "deepseek",
      globalApiKey: "deepseek-db-key",
    });

    await expect(resolveRequestModelOverrides({ provider: "kimi" })).resolves.toMatchObject({
      provider: "kimi",
      globalApiKey: "kimi-db-key",
    });
  });

  it("非法 visitor provider 忽略，继续走 DB 选择", async () => {
    mockCore.store.set("model_provider", "kimi");
    invalidateModelOverridesCache();
    expect((await resolveRequestModelOverrides({ provider: "unknown" })).provider).toBe("kimi");
  });
});

// 回归:代码评审 P1 — 自定义 baseURL/协议/模型名必须绑定 visitor key,
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
    // 入口即归一化:没有版本段就补 /v1(与 core resolveBaseUrl 同一 canonical 口径)
    expect(r.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic/v1");
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
      baseUrl: "http://10.0.0.8/v1",
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
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/v1",
    "http://192.168.1.8/v1",
    "http://[fc00::1]:8080/v1",
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

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
  ])("带 visitor key 时允许本机模型 endpoint:%s", async (baseUrl) => {
    const r = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl,
      modelFlash: "local-model",
    });

    expect(r.baseUrl).toBe(baseUrl);
    expect(r.modelIds).toEqual({ flash: "local-model" });
  });

  // 回归:用户把完整 endpoint(含 /chat/completions)填进 API 地址时,
  // overrides.baseUrl 必须已是 canonical 形态——下游消费口(如余额接口拼 `${baseUrl}/...`)
  // 直接用它,拿到未归一化值就会拼出坏路径。
  it.each([
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/chat/completions/", "https://api.example.com/v1"],
    ["https://proxy.example.com/openai/v1/messages", "https://proxy.example.com/openai/v1"],
    ["https://proxy.example.com/api?key=abc#frag", "https://proxy.example.com/api/v1"],
    ["https://proxy.example.com", "https://proxy.example.com/v1"],
  ])("baseUrl 入口归一化:%s → %s", async (input, expected) => {
    const r = await resolveRequestModelOverrides({ visitorKey: VKEY, baseUrl: input });
    expect(r.baseUrl).toBe(expected);
  });

  it("归一化后仍指向内网时照旧丢弃,并留服务端日志(不冒用户可见报错)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveRequestModelOverrides({
      visitorKey: VKEY,
      baseUrl: "http://10.0.0.8/v1/chat/completions",
    });
    expect(r.baseUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("已回退默认端点");
    warn.mockRestore();
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
