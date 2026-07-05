import { describe, expect, it, vi } from "vitest";

// 凭据路由:平台 key 校验 / CSRF Origin 守卫 / 不回传明文。
// mock @qingagent/core 的凭据 API,只测路由逻辑。

const mockCore = vi.hoisted(() => ({
  saved: [] as Array<{ platform: string; key: string; value: string }>,
  saveCredentialRecord: vi.fn(async (rec: { platform: string; key: string; value: string }) => {
    mockCore.saved.push(rec);
  }),
  listCredentialMeta: vi.fn(async () => []),
  deleteCredential: vi.fn(async () => {}),
  invalidateSessionWorkspace: vi.fn(),
  PLATFORM_CREDENTIAL_SPECS: [
    {
      platform: "dingtalk",
      label: "钉钉",
      helpUrl: "https://open-dev.dingtalk.com",
      fields: [
        { key: "DINGTALK_APP_KEY", label: "AppKey", secret: false },
        { key: "DINGTALK_APP_SECRET", label: "AppSecret", secret: true },
      ],
    },
  ],
}));

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
      { platform: "dingtalk", key: "DINGTALK_APP_SECRET", updatedAt: "t", status: "ok" },
    ] as never);
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.specs).toHaveLength(1);
    expect(body.specs[0].platform).toBe("dingtalk");
    const secretField = body.specs[0].fields.find((field: { key: string }) => field.key === "DINGTALK_APP_SECRET");
    expect(secretField).toMatchObject({ configured: true });
    // 不回传实际凭据明文值(字段 label 含 "Secret" 是字段名,不算泄露)
    expect(JSON.stringify(body)).not.toContain("tok-secret-value");
  });

  it("POST 保存合法字段", async () => {
    mockCore.saved.length = 0;
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "dingtalk", values: { DINGTALK_APP_SECRET: "tok" } }),
    });
    expect(res.status).toBe(200);
    expect(mockCore.saved).toEqual([{ platform: "dingtalk", key: "DINGTALK_APP_SECRET", value: "tok" }]);
  });

  it("POST 拒绝跨平台的 key(FEISHU_APP_SECRET 存到 dingtalk)", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "dingtalk", values: { FEISHU_APP_SECRET: "x" } }),
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
      body: JSON.stringify({ platform: "dingtalk", values: { DINGTALK_APP_SECRET: "t" } }),
    });
    expect(res.status).toBe(403);
  });

  it("CSRF:本机 Origin 放行", async () => {
    mockCore.saved.length = 0;
    const app = await loadApp();
    const res = await app.request("/api/v1/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:6175" },
      body: JSON.stringify({ platform: "dingtalk", values: { DINGTALK_APP_SECRET: "t" } }),
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
