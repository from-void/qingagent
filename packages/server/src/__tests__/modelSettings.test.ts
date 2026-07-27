import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCore = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    DEEPSEEK_MODEL_IDS: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
    KIMI_BASE_URL: "https://api.kimi.com/coding/v1",
    KIMI_MODEL_IDS: { flash: "kimi-for-coding", pro: "k3" },
    SETTING_DEEPSEEK_GLOBAL_KEY: "deepseek_global_api_key",
    SETTING_KIMI_GLOBAL_KEY: "kimi_global_api_key",
    SETTING_MODEL_PROVIDER: "model_provider",
    SETTING_MODEL_PARAMS: "model_param_overrides",
    MODEL_OVERRIDES_CONTEXT_KEY: "modelOverrides",
    VISION_TEST_TIMEOUT_MS: 12_000,
    getAppSetting: vi.fn(async (key: string) => store.get(key) ?? null),
    setAppSetting: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteAppSetting: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    sanitizeBaseUrl: vi.fn((raw: string | undefined) => {
      const value = raw?.trim();
      if (!value) return undefined;
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        return value.replace(/\/+$/, "");
      } catch {
        return undefined;
      }
    }),
    sanitizeModelId: vi.fn((raw: string | undefined) => {
      const value = raw?.trim();
      return value && /^[A-Za-z0-9._:\/-]+$/.test(value) ? value : undefined;
    }),
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
    modelFetch: vi.fn(async () => new Response(null, { status: 200 })),
    testVisionConnection: vi.fn(async () => undefined),
    testTextModelConnection: vi.fn(async () => undefined),
  };
});

vi.mock("@qingagent/core", () => mockCore);

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
const originalKimiApiKey = process.env.KIMI_API_KEY;
const originalProvider = process.env.QINGAGENT_MODEL_PROVIDER;

async function loadApp() {
  const { Hono } = await import("hono");
  const { modelSettingsRoutes } = await import("../routes/modelSettings");
  const app = new Hono();
  app.route("/api/v1", modelSettingsRoutes);
  return app;
}

describe("modelSettingsRoutes", () => {
  beforeEach(() => {
    mockCore.store.clear();
    vi.clearAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.QINGAGENT_MODEL_PROVIDER;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDeepseekApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
    }
    if (originalKimiApiKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = originalKimiApiKey;
    if (originalProvider === undefined) delete process.env.QINGAGENT_MODEL_PROVIDER;
    else process.env.QINGAGENT_MODEL_PROVIDER = originalProvider;
  });

  it("PUT/GET 都不回传明文 DeepSeek key", async () => {
    const app = await loadApp();
    const apiKey = "sk-deepseek-secret-123456";

    const put = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        params: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 },
      }),
    });

    expect(put.status).toBe(200);
    const putJson = await put.json();
    expect(putJson).toMatchObject({
      provider: "deepseek",
      apiKeyConfigured: true,
      maskedTail: "3456",
      source: "db",
      params: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 },
    });
    expect(JSON.stringify(putJson)).not.toContain(apiKey);

    const get = await app.request("/api/v1/settings/model");
    expect(get.status).toBe(200);
    const getJson = await get.json();
    expect(getJson.maskedTail).toBe("3456");
    expect(getJson.source).toBe("db");
    expect(JSON.stringify(getJson)).not.toContain(apiKey);
  });

  it("老数据无 provider 视为 DeepSeek；切换 Kimi 后两家 key 分开保留", async () => {
    const app = await loadApp();
    mockCore.store.set(mockCore.SETTING_DEEPSEEK_GLOBAL_KEY, "deepseek-secret-1111");

    const legacy = await app.request("/api/v1/settings/model");
    await expect(legacy.json()).resolves.toMatchObject({
      provider: "deepseek",
      maskedTail: "1111",
      providers: {
        deepseek: { apiKeyConfigured: true, maskedTail: "1111", source: "db" },
        kimi: { apiKeyConfigured: false, maskedTail: null, source: "none" },
      },
    });

    const kimiPut = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "kimi", apiKey: "kimi-secret-2222" }),
    });
    expect(kimiPut.status).toBe(200);
    await expect(kimiPut.json()).resolves.toMatchObject({
      provider: "kimi",
      maskedTail: "2222",
      providers: {
        deepseek: { maskedTail: "1111" },
        kimi: { maskedTail: "2222" },
      },
    });
    expect(mockCore.store.get(mockCore.SETTING_DEEPSEEK_GLOBAL_KEY)).toBe("deepseek-secret-1111");
    expect(mockCore.store.get(mockCore.SETTING_KIMI_GLOBAL_KEY)).toBe("kimi-secret-2222");

    const switchBack = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });
    await expect(switchBack.json()).resolves.toMatchObject({
      provider: "deepseek",
      maskedTail: "1111",
      providers: { kimi: { maskedTail: "2222" } },
    });
  });

  it("非法 provider 返回 400，不改写现有设置", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "other", apiKey: "must-not-save" }),
    });
    expect(res.status).toBe(400);
    expect(mockCore.setAppSetting).not.toHaveBeenCalled();
  });

  it("params 未知字段返回 400 并点名字段(R5-B 回归)", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: { temperature: 0.5, hax: 1, oops: 2 } }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(String(json.error)).toContain("unknown field");
    expect(String(json.error)).toContain("hax");
  });

  it("空 apiKey 会删除已保存 key 且响应不带旧明文", async () => {
    const app = await loadApp();
    mockCore.store.set(mockCore.SETTING_DEEPSEEK_GLOBAL_KEY, "sk-old-secret-9999");

    const res = await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      apiKeyConfigured: false,
      maskedTail: null,
      source: "none",
    });
    expect(JSON.stringify(json)).not.toContain("sk-old-secret-9999");
  });

  it("vision test 请求体结构错误返回 400", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/settings/vision/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "bad",
        baseUrl: "https://vision.example.com/v1",
        apiKey: "sk-vision",
        model: "vision-model",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, errorKind: "invalid_config" });
    expect(mockCore.testVisionConnection).not.toHaveBeenCalled();
  });

  it("vision test 空 key 返回 200 + missing_key", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/settings/vision/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "openai",
        baseUrl: "https://vision.example.com/v1",
        apiKey: " ",
        model: "vision-model",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, errorKind: "missing_key", message: "缺少 API key" });
    expect(mockCore.testVisionConnection).not.toHaveBeenCalled();
  });

  it("vision test 鉴权失败返回 200 + auth", async () => {
    const app = await loadApp();
    const authError = new Error("Unauthorized");
    (authError as Error & { statusCode: number }).statusCode = 401;
    mockCore.testVisionConnection.mockRejectedValueOnce(authError);

    const res = await app.request("/api/v1/settings/vision/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "anthropic",
        baseUrl: "https://vision.example.com/api/anthropic/",
        apiKey: "sk-vision",
        model: "vision-model",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, errorKind: "auth" });
    expect(mockCore.testVisionConnection).toHaveBeenCalledWith({
      apiKey: "sk-vision",
      baseUrl: "https://vision.example.com/api/anthropic",
      model: "vision-model",
      protocol: "anthropic",
    }, expect.any(AbortSignal));
  });

  it("test-custom 正常公网 baseUrl 通过 SSRF 校验后请求 /models", async () => {
    const app = await loadApp();

    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: " https://api.example.com/v1/ ",
        apiKey: " sk-public ",
        protocol: "openai",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      normalizedBaseUrl: "https://api.example.com/v1",
    });
    expect(mockCore.validateModelFetchUrl).toHaveBeenCalledWith("https://api.example.com/v1");
    expect(mockCore.modelFetch).toHaveBeenCalledWith("https://api.example.com/v1/models", {
      headers: { Authorization: "Bearer sk-public" },
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it("test-custom 的 /models 探测复用 modelFetch 并拒绝重定向到私网", async () => {
    const app = await loadApp();
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    mockCore.modelFetch.mockRejectedValueOnce(
      new TypeError("fetch failed", {
        cause: new Error("Blocked private address for 169.254.169.254: 169.254.169.254"),
      }),
    );

    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://public-provider.example/v1",
        apiKey: "sk-must-not-leak",
        protocol: "openai",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "无法连接该地址" });
    expect(mockCore.modelFetch).toHaveBeenCalledWith(
      "https://public-provider.example/v1/models",
      {
        headers: { Authorization: "Bearer sk-must-not-leak" },
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("test-custom anthropic 走 core 计费工厂的最小 messages 连通测试", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://glm.example.com/v1",
        apiKey: "glm-key",
        protocol: "anthropic",
        model: "glm-4.6",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(mockCore.testTextModelConnection).toHaveBeenCalledWith({
      apiKey: "glm-key",
      baseUrl: "https://glm.example.com/v1",
      model: "glm-4.6",
      protocol: "anthropic",
      timeoutMs: 12_000,
    });
  });

  it("Kimi test-custom 的 401/403 按套餐权限提示，不误报 keyInvalid", async () => {
    const app = await loadApp();
    const permissionError = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    mockCore.testTextModelConnection.mockRejectedValueOnce(permissionError);
    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        apiKey: "kimi-test-key",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      permissionDenied: true,
    });
    expect(mockCore.testTextModelConnection).toHaveBeenCalledWith({
      provider: "kimi",
      apiKey: "kimi-test-key",
      baseUrl: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      protocol: "openai",
      timeoutMs: 12_000,
    });
  });

  it("Kimi 测连接复用当前 provider 配置走最短对话，不探测未验证的 /models", async () => {
    const app = await loadApp();
    await app.request("/api/v1/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "kimi", apiKey: "kimi-db-key" }),
    });
    const res = await app.request("/api/v1/settings/model/balance");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      provider: "kimi",
      balanceUnsupported: true,
    });
    expect(mockCore.testTextModelConnection).toHaveBeenCalledWith({
      provider: "kimi",
      apiKey: "kimi-db-key",
      baseUrl: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      protocol: "openai",
      timeoutMs: 10_000,
    });
    expect(mockCore.modelFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.4/v1",
    "http://192.168.1.4/v1",
    "http://[fc00::1]:8080/v1",
  ])("test-custom 在 fetch 前拒绝敏感 baseUrl:%s", async (baseUrl) => {
    const app = await loadApp();

    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "sk-private", protocol: "openai" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false });
    expect(String(json.error)).toContain("内网、链路本地和云元数据地址默认禁止");
    expect(mockCore.modelFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
  ])("test-custom 允许本机模型并继续连通测试:%s", async (baseUrl) => {
    const app = await loadApp();

    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "sk-local", protocol: "openai" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, normalizedBaseUrl: baseUrl });
    expect(mockCore.modelFetch).toHaveBeenCalled();
  });
});
