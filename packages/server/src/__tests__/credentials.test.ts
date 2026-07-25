import { describe, expect, it, vi } from "vitest";

// 凭据路由:平台 key 校验 / CSRF Origin 守卫 / 不回传明文。
// mock @qingagent/core 的凭据 API,只测路由逻辑。

const mockCore = vi.hoisted(() => {
  const disconnectConnector = vi.fn(async () => ({}));
  return ({
  saved: [] as Array<{ platform: string; key: string; value: string }>,
  saveCredentialRecord: vi.fn(async (rec: { platform: string; key: string; value: string }) => {
    mockCore.saved.push(rec);
  }),
  listCredentialMeta: vi.fn(async () => []),
  deleteCredential: vi.fn(async () => {}),
  disconnectConnector,
  getConnectorService: vi.fn(() => ({ disconnect: disconnectConnector })),
  invalidateSessionWorkspace: vi.fn(),
  PLATFORM_CREDENTIAL_SPECS: [
    {
      platform: "test-platform",
      label: "测试平台",
      helpUrl: "https://example.test/credentials",
      fields: [
        { key: "PLATFORM_API_KEY", label: "API Key", secret: false },
        { key: "PLATFORM_API_SECRET", label: "API Secret", secret: true },
      ],
    },
    {
      platform: "connector:wechat-mp", label: "微信公众号", helpUrl: "https://mp.weixin.qq.com/",
      fields: [{ key: "bundle", label: "扫码会话凭据", secret: true }],
    },
  ],
  });
});

vi.mock("@qingagent/core", () => mockCore);

async function loadApp() {
  const { Hono } = await import("hono");
  const { credentialsRoutes } = await import("../routes/credentials");
  const app = new Hono();
  app.route("/api/v1", credentialsRoutes);
  return app;
}

describe("credentials 路由", () => {
  it("GET 返回规格+configured 状态,不含明文", async () => {
    mockCore.listCredentialMeta.mockResolvedValueOnce([
      { platform: "test-platform", key: "PLATFORM_API_SECRET", updatedAt: "t", status: "ok" },
    ] as never);
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.specs).toHaveLength(2);
    expect(body.specs[0].platform).toBe("test-platform");
    const secretField = body.specs[0].fields.find((field: { key: string }) => field.key === "PLATFORM_API_SECRET");
    expect(secretField).toMatchObject({ configured: true });
    // 不回传实际凭据明文值(字段 label 含 "Secret" 是字段名,不算泄露)
    expect(JSON.stringify(body)).not.toContain("tok-secret-value");
  });

  it("微信 connector namespace 可见可删但不可通过表单写入，响应永不回显值", async () => {
    mockCore.listCredentialMeta.mockResolvedValueOnce([{ platform: "connector:wechat-mp", key: "bundle", updatedAt: "t", status: "ok" }] as never);
    const app = await loadApp();
    const get = await app.request("/api/v1/credentials");
    const body = await get.json();
    const wechat = body.specs.find((spec: { platform: string }) => spec.platform === "connector:wechat-mp");
    expect(wechat.fields[0]).toMatchObject({ key: "bundle", secret: true, configured: true });
    expect(JSON.stringify(body)).not.toContain("secret-cookie");

    const post = await app.request("/api/v1/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: "connector:wechat-mp", values: { bundle: "secret-cookie" } }) });
    expect(post.status).toBe(405);
    const del = await app.request("/api/v1/credentials/connector%3Awechat-mp", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(mockCore.disconnectConnector).toHaveBeenCalledWith("wechat-mp");
  });

  it("POST 保存合法字段", async () => {
    mockCore.saved.length = 0;
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "test-platform", values: { PLATFORM_API_SECRET: "tok" } }),
    });
    expect(res.status).toBe(200);
    expect(mockCore.saved).toEqual([{ platform: "test-platform", key: "PLATFORM_API_SECRET", value: "tok" }]);
  });

  it("POST 拒绝跨平台字段", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "test-platform", values: { FEISHU_APP_SECRET: "x" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("不支持该字段");
  });

  it("POST 拒绝未知平台", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "evil", values: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("POST 拒绝 legacy feishu 平台", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "feishu", values: { FEISHU_APP_SECRET: "x" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("未知平台");
  });

  it("CSRF:带恶意 Origin 的 POST 被拒", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.com" },
      body: JSON.stringify({ platform: "test-platform", values: { PLATFORM_API_SECRET: "t" } }),
    });
    expect(res.status).toBe(403);
  });

  it("CSRF:本机 Origin 放行", async () => {
    mockCore.saved.length = 0;
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:6173" },
      body: JSON.stringify({ platform: "test-platform", values: { PLATFORM_API_SECRET: "t" } }),
    });
    expect(res.status).toBe(200);
  });

  it("GET 不受 Origin 守卫影响(只读)", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(200);
  });
});
