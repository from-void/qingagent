import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCore = vi.hoisted(() => {
  class SearchProviderError extends Error {
    readonly kind: "auth" | "quota" | "network";
    readonly status?: number;

    constructor(kind: "auth" | "quota" | "network", message: string, status?: number) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }

  const store = new Map<string, string>();
  const health = new Map<string, {
    status: "ok" | "auth" | "quota";
    authRetryAt?: number;
    quotaUntil?: number;
  }>();
  const registry = [
    {
      id: "bing",
      label: "Bing 爬取",
      kind: "scrape",
      keyUrl: null,
      freeQuotaNote: "免费",
      buildProvider: () => ({ search: vi.fn(async () => []) }),
    },
    {
      id: "ddg",
      label: "DuckDuckGo",
      kind: "scrape",
      keyUrl: null,
      freeQuotaNote: "免费",
      buildProvider: () => ({ search: vi.fn(async () => []) }),
    },
    {
      id: "searxng",
      label: "SearXNG",
      kind: "scrape",
      keyUrl: "https://docs.searxng.org/",
      freeQuotaNote: "自建",
      buildProvider: () => ({ search: vi.fn(async () => []) }),
    },
    {
      id: "tavily",
      label: "Tavily",
      kind: "api",
      keyUrl: "https://app.tavily.com/",
      freeQuotaNote: "免费层",
      buildProvider: () => ({
        search: vi.fn(async () => [{ title: "ok", url: "https://example.com", snippet: "s" }]),
      }),
    },
  ];
  const ids = registry.map((item) => item.id);
  const parseSearchProviderConfig = vi.fn((raw: string | null) => {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const parsePrimarySearchConfig = vi.fn((raw: string | null) => {
    if (!raw) return { enabled: true };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { enabled: true };
      }
      const record = parsed as Record<string, unknown>;
      const config: { enabled: boolean; apiKey?: string } = {
        enabled: typeof record.enabled === "boolean" ? record.enabled : true,
      };
      if (typeof record.apiKey === "string" && record.apiKey.trim()) {
        config.apiKey = record.apiKey.trim();
      }
      return config;
    } catch {
      return { enabled: true };
    }
  });

  return {
    store,
    health,
    SETTING_SEARCH_PRIMARY: "search_primary",
    SETTING_SEARCH_PROVIDER_CONFIG: "search_provider_config",
    SEARCH_PROVIDER_REGISTRY: registry,
    SearchProviderError,
    clearManagedSearchProviderHealth: vi.fn((id: string) => health.delete(id)),
    clearSearchCache: vi.fn(),
    getSearchProviderHealth: vi.fn((id: string) => health.get(id) ?? { status: "ok" }),
    getAppSetting: vi.fn(async (key: string) => store.get(key) ?? null),
    getPrimarySearchConfig: vi.fn(async () =>
      parsePrimarySearchConfig(store.get("search_primary") ?? null),
    ),
    invalidateManagedSearchConfig: vi.fn(),
    invalidatePrimarySearchConfig: vi.fn(),
    isSearchProviderId: vi.fn((id: string) => ids.includes(id)),
    recordSearchProviderError: vi.fn((id: string, kind: string, status?: number) => {
      if (kind === "auth") {
        health.set(id, status === 403 || status === 422
          ? { status: "auth", authRetryAt: Date.now() + 5 * 60_000 }
          : { status: "auth" });
      }
      if (kind === "quota") {
        health.set(id, { status: "quota", quotaUntil: Date.now() + 30_000 });
      }
    }),
    parsePrimarySearchConfig,
    parseSearchProviderConfig,
    patchAppSettingJsonField: vi.fn(async (
      key: string,
      field: string,
      patch: Record<string, unknown>,
      deleteFields: string[] = [],
    ) => {
      const current = parseSearchProviderConfig(store.get(key) ?? null);
      const currentField = {
        ...((current[field] as Record<string, unknown> | undefined) ?? {}),
        ...patch,
      };
      for (const name of deleteFields) delete currentField[name];
      current[field] = currentField;
      store.set(key, JSON.stringify(current));
    }),
    setAppSettingJsonField: vi.fn(async (key: string, field: string, value: unknown) => {
      const current = parseSearchProviderConfig(store.get(key) ?? null);
      current[field] = value;
      store.set(key, JSON.stringify(current));
    }),
    setAppSetting: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
});

vi.mock("@qingagent/core", () => mockCore);

const oldDeepseekEnv = process.env.DEEPSEEK_API_KEY;

async function loadApp() {
  const { Hono } = await import("hono");
  const { searchSettingsRoutes } = await import("../routes/searchSettings");
  const app = new Hono();
  app.route("/api/v1", searchSettingsRoutes);
  return app;
}

describe("searchSettingsRoutes", () => {
  beforeEach(() => {
    mockCore.store.clear();
    mockCore.health.clear();
    delete process.env.DEEPSEEK_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (oldDeepseekEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepseekEnv;
  });

  it("PUT/GET 搜索 key 只返回 maskedTail,不回传明文", async () => {
    const app = await loadApp();
    const apiKey = "tvly-secret-123456";

    const put = await app.request("/api/v1/settings/search/tavily", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, apiKey }),
    });

    expect(put.status).toBe(200);
    const putJson = await put.json();
    expect(JSON.stringify(putJson)).not.toContain(apiKey);
    expect(putJson.providers.find((p: { id: string }) => p.id === "tavily")).toMatchObject({
      enabled: true,
      keyConfigured: true,
      maskedTail: "3456",
    });
    expect(mockCore.clearSearchCache).toHaveBeenCalledTimes(1);

    const get = await app.request("/api/v1/settings/search");
    expect(get.status).toBe(200);
    const getJson = await get.json();
    expect(JSON.stringify(getJson)).not.toContain(apiKey);
    expect(getJson.providers.find((p: { id: string }) => p.id === "tavily").maskedTail).toBe(
      "3456",
    );
  });

  it("未知 provider id 返回 404", async () => {
    const app = await loadApp();

    const put = await app.request("/api/v1/settings/search/not-real", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(404);

    const test = await app.request("/api/v1/settings/search/not-real/test", {
      method: "POST",
    });
    expect(test.status).toBe(404);
  });

  it("apiKey 空串删除已保存 key,响应不带旧明文", async () => {
    const app = await loadApp();
    mockCore.store.set(
      mockCore.SETTING_SEARCH_PROVIDER_CONFIG,
      JSON.stringify({ tavily: { enabled: true, apiKey: "tvly-old-secret-9999" } }),
    );

    const res = await app.request("/api/v1/settings/search/tavily", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("tvly-old-secret-9999");
    expect(json.providers.find((p: { id: string }) => p.id === "tavily")).toMatchObject({
      enabled: false,
      keyConfigured: false,
      maskedTail: null,
    });
  });

  it("401 熔断不会被启停开关清除，仅在 API key 实际变更后恢复", async () => {
    const app = await loadApp();
    mockCore.store.set(
      mockCore.SETTING_SEARCH_PROVIDER_CONFIG,
      JSON.stringify({ tavily: { enabled: true, apiKey: "tvly-old-key" } }),
    );
    mockCore.health.set("tavily", { status: "auth" });

    const disable = await app.request("/api/v1/settings/search/tavily", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    expect(mockCore.health.get("tavily")).toEqual({ status: "auth" });
    expect(mockCore.clearManagedSearchProviderHealth).not.toHaveBeenCalled();

    const changeKey = await app.request("/api/v1/settings/search/tavily", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "tvly-new-key" }),
    });
    expect(changeKey.status).toBe(200);
    expect(mockCore.health.has("tavily")).toBe(false);
    expect(mockCore.clearManagedSearchProviderHealth).toHaveBeenCalledOnce();
    expect(mockCore.clearManagedSearchProviderHealth).toHaveBeenCalledWith("tavily");
  });

  it("并发保存不同 provider 时以字段级原子更新保留两份配置", async () => {
    const app = await loadApp();
    let initialReads = 0;
    mockCore.getAppSetting.mockImplementation(async (key: string) => {
      if (key === mockCore.SETTING_SEARCH_PROVIDER_CONFIG && initialReads < 2) {
        initialReads += 1;
        return null;
      }
      return mockCore.store.get(key) ?? null;
    });

    const [tavily, searxng] = await Promise.all([
      app.request("/api/v1/settings/search/tavily", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, apiKey: "tvly-concurrent-1234" }),
      }),
      app.request("/api/v1/settings/search/searxng", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, url: "https://search.example.com" }),
      }),
    ]);

    expect(tavily.status).toBe(200);
    expect(searxng.status).toBe(200);
    expect(mockCore.patchAppSettingJsonField).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockCore.store.get(mockCore.SETTING_SEARCH_PROVIDER_CONFIG)!)).toEqual({
      tavily: { enabled: true, apiKey: "tvly-concurrent-1234" },
      searxng: { enabled: true, url: "https://search.example.com/" },
    });
  });

  it("并发保存同一 provider 的不同属性时合并 patch", async () => {
    const app = await loadApp();

    const [enabled, apiKey] = await Promise.all([
      app.request("/api/v1/settings/search/tavily", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      app.request("/api/v1/settings/search/tavily", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "tvly-concurrent-5678" }),
      }),
    ]);

    expect(enabled.status).toBe(200);
    expect(apiKey.status).toBe(200);
    expect(JSON.parse(mockCore.store.get(mockCore.SETTING_SEARCH_PROVIDER_CONFIG)!)).toEqual({
      tavily: { enabled: true, apiKey: "tvly-concurrent-5678" },
    });
  });

  it("GET primary 只返回脱敏 key 与 db source", async () => {
    const app = await loadApp();
    const apiKey = "ds-secret-123456";
    mockCore.store.set(
      mockCore.SETTING_SEARCH_PRIMARY,
      JSON.stringify({ enabled: true, apiKey }),
    );
    process.env.DEEPSEEK_API_KEY = "env-secret-9999";

    const res = await app.request("/api/v1/settings/search/primary");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain(apiKey);
    expect(json).toEqual({
      enabled: true,
      keyConfigured: true,
      maskedTail: "3456",
      source: "db",
    });
  });

  it("GET primary 无 DB key 时回显 env source 但不回明文", async () => {
    const app = await loadApp();
    process.env.DEEPSEEK_API_KEY = "env-secret-8888";

    const res = await app.request("/api/v1/settings/search/primary");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("env-secret-8888");
    expect(json).toEqual({
      enabled: true,
      keyConfigured: true,
      maskedTail: "8888",
      source: "env",
    });
  });

  it("PUT primary 写入与清除 DB key,并失效 primary cache", async () => {
    const app = await loadApp();
    const apiKey = "ds-secret-5678";

    const put = await app.request("/api/v1/settings/search/primary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, apiKey }),
    });

    expect(put.status).toBe(200);
    const putJson = await put.json();
    expect(JSON.stringify(putJson)).not.toContain(apiKey);
    expect(putJson).toEqual({
      enabled: false,
      keyConfigured: true,
      maskedTail: "5678",
      source: "db",
    });
    expect(JSON.parse(mockCore.store.get(mockCore.SETTING_SEARCH_PRIMARY)!)).toEqual({
      enabled: false,
      apiKey,
    });
    expect(mockCore.invalidatePrimarySearchConfig).toHaveBeenCalledTimes(1);
    expect(mockCore.clearSearchCache).toHaveBeenCalledTimes(1);

    const clear = await app.request("/api/v1/settings/search/primary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });

    expect(clear.status).toBe(200);
    const clearJson = await clear.json();
    expect(JSON.stringify(clearJson)).not.toContain(apiKey);
    expect(clearJson).toEqual({
      enabled: false,
      keyConfigured: false,
      maskedTail: null,
      source: "none",
    });
    expect(JSON.parse(mockCore.store.get(mockCore.SETTING_SEARCH_PRIMARY)!)).toEqual({
      enabled: false,
    });
    expect(mockCore.invalidatePrimarySearchConfig).toHaveBeenCalledTimes(2);
    expect(mockCore.clearSearchCache).toHaveBeenCalledTimes(2);
  });
});
