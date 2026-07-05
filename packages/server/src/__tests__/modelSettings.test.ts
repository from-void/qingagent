import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCore = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    SETTING_DEEPSEEK_GLOBAL_KEY: "deepseek_global_api_key",
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
    testVisionConnection: vi.fn(async () => undefined),
  };
});

vi.mock("@qingagent/core", () => mockCore);

const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDeepseekApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
    }
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
    expect(putJson).toEqual({
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
    });
  });

  it("test-custom 正常公网 baseUrl 通过 SSRF 校验后请求 /models", async () => {
    const app = await loadApp();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

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
    expect(mockCore.validateFetchUrl).toHaveBeenCalledWith("https://api.example.com/v1");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", {
      headers: { Authorization: "Bearer sk-public" },
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it.each([
    "http://127.0.0.1:8080/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.4/v1",
    "http://localhost:8080/v1",
  ])("test-custom 在 fetch 前拒绝敏感 baseUrl:%s", async (baseUrl) => {
    const app = await loadApp();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/api/v1/settings/model/test-custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "sk-private", protocol: "openai" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false });
    expect(String(json.error)).toContain("公开的 API 地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
