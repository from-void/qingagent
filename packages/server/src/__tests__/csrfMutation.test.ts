import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadApp() {
  vi.resetModules();
  vi.doMock("../gateway/bridgeHandler", () => ({
    findMaterial: vi.fn(() => null),
    getSession: vi.fn(() => null),
    parseOrigin: vi.fn(() => "manual"),
    sessionManager: {
      destroySession: vi.fn(async () => ({ deleted: true, status: "completed" })),
    },
  }));
  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      deleteSessionThread: vi.fn(async () => undefined),
    };
  });
  const { Hono } = await import("hono");
  const { uploadRoutes } = await import("../routes/upload");
  const { dataAdminRoutes } = await import("../routes/dataAdmin");
  const { skillsRoutes } = await import("../routes/skills");
  const { homeRoutes } = await import("../routes/home");
  const { exportRoutes } = await import("../routes/export");
  const { askMoreRoutes } = await import("../routes/askMore");
  const { modelSettingsRoutes } = await import("../routes/modelSettings");
  const { searchSettingsRoutes } = await import("../routes/searchSettings");
  const { clientLogRoutes } = await import("../routes/clientlog");
  const { csrfMutationGuard } = await import("../lib/trustedOrigin");
  const app = new Hono();
  app.use("/api/*", csrfMutationGuard);
  app.route("/api/v1", uploadRoutes);
  app.route("/api/v1", dataAdminRoutes);
  app.route("/api/v1", skillsRoutes);
  app.route("/api/v1", homeRoutes);
  app.route("/api/v1", exportRoutes);
  app.route("/api/v1", askMoreRoutes);
  app.route("/api/v1", modelSettingsRoutes);
  app.route("/api/v1", searchSettingsRoutes);
  app.route("/api/v1", clientLogRoutes);
  return app;
}

function withOrigin(init: RequestInit, origin: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (origin) headers.set("Origin", origin);
  return { ...init, headers };
}

const protectedWriteEndpoints: Array<{
  name: string;
  path: string;
  init: RequestInit;
  allowedStatus: number;
}> = [
  {
    name: "POST /upload",
    path: "/api/v1/upload",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    allowedStatus: 400,
  },
  {
    name: "DELETE /data/usage",
    path: "/api/v1/data/usage",
    init: { method: "DELETE" },
    allowedStatus: 400,
  },
  {
    name: "POST /skills/install",
    path: "/api/v1/skills/install",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Name", skillMd: "..." }),
    },
    allowedStatus: 400,
  },
  {
    name: "DELETE /skills/:name",
    path: "/api/v1/skills/__csrf_missing_skill__",
    init: { method: "DELETE" },
    allowedStatus: 404,
  },
  {
    name: "POST /skills/:name/:action(enable,原无内联守卫,靠中央守卫)",
    path: "/api/v1/skills/__csrf_missing_skill__/enable",
    init: { method: "POST" },
    allowedStatus: 404,
  },
  {
    name: "DELETE /sessions/:id",
    path: "/api/v1/sessions/__csrf_session__",
    init: { method: "DELETE" },
    allowedStatus: 200,
  },
  {
    name: "POST /ask-more",
    path: "/api/v1/ask-more",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    allowedStatus: 400,
  },
  {
    name: "GET /export/:sessionId",
    path: "/api/v1/export/__csrf_session__?format=pdf",
    init: { method: "GET" },
    allowedStatus: 404,
  },
  {
    name: "PUT /settings/model",
    path: "/api/v1/settings/model",
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    },
    allowedStatus: 400,
  },
  {
    name: "GET /settings/model/balance",
    path: "/api/v1/settings/model/balance",
    init: { method: "GET" },
    allowedStatus: 400,
  },
  {
    name: "POST /settings/model/test-custom",
    path: "/api/v1/settings/model/test-custom",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    allowedStatus: 200,
  },
  {
    name: "POST /settings/vision/test",
    path: "/api/v1/settings/vision/test",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    allowedStatus: 400,
  },
  {
    name: "PUT /settings/search/primary",
    path: "/api/v1/settings/search/primary",
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    },
    allowedStatus: 400,
  },
  {
    name: "PUT /settings/search/:id",
    path: "/api/v1/settings/search/tavily",
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    },
    allowedStatus: 400,
  },
  {
    name: "POST /settings/search/:id/test",
    path: "/api/v1/settings/search/tavily/test",
    init: { method: "POST" },
    allowedStatus: 400,
  },
  {
    name: "POST /clientlog",
    path: "/api/v1/clientlog",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    allowedStatus: 400,
  },
];

describe("敏感写/耗资源/读内容路由 CSRF Origin 守卫", () => {
  beforeEach(() => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    process.env.QINGAGENT_ENABLE_DEBUG = "1";
    delete process.env.QINGAGENT_TRUSTED_ORIGINS;
    delete process.env.QINGAGENT_WEB_PORT;
  });

  afterEach(() => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    delete process.env.QINGAGENT_ENABLE_DEBUG;
    delete process.env.QINGAGENT_TRUSTED_ORIGINS;
    delete process.env.QINGAGENT_WEB_PORT;
    vi.doUnmock("../gateway/bridgeHandler");
    vi.doUnmock("@qingagent/core");
    vi.resetModules();
  });

  describe("精确 Origin 白名单", () => {
    const path = "/api/v1/clientlog";
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    };

    it("拒绝非白名单 localhost 端口", async () => {
      const app = await loadApp();
      const res = await app.request(path, withOrigin(init, "http://localhost:62001"));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
    });

    it("Origin 与 Host 同值的外部 rebinding 域名仍拒绝", async () => {
      const app = await loadApp();
      const requestInit = withOrigin(init, "http://rebind.example:8080");
      const headers = new Headers(requestInit.headers);
      headers.set("Host", "rebind.example:8080");
      const res = await app.request(path, { ...requestInit, headers });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
    });

    it("内置本机 Web 端口与无 Origin 请求放行", async () => {
      const app = await loadApp();

      expect((await app.request(path, withOrigin(init, "http://localhost:6173"))).status).toBe(200);
      expect((await app.request(path, withOrigin(init, "http://127.0.0.1:5173"))).status).toBe(200);
      expect((await app.request(path, withOrigin(init, "http://[::1]:8091"))).status).toBe(200);
      expect((await app.request(path, init)).status).toBe(200);
    });

    it("运行时 Web 端口与显式配置的完整 Origin 放行", async () => {
      process.env.QINGAGENT_WEB_PORT = "62002";
      process.env.QINGAGENT_TRUSTED_ORIGINS = "https://app.example";
      const app = await loadApp();

      expect((await app.request(path, withOrigin(init, "http://localhost:62002"))).status).toBe(200);
      expect((await app.request(path, withOrigin(init, "https://app.example"))).status).toBe(200);
      expect((await app.request(path, withOrigin(init, "http://app.example"))).status).toBe(403);
    });
  });

  for (const endpoint of protectedWriteEndpoints) {
    describe(endpoint.name, () => {
      it("拒绝不受信 Origin", async () => {
        const app = await loadApp();
        const res = await app.request(
          endpoint.path,
          withOrigin(endpoint.init, "https://evil.test"),
        );

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
      });

      it("无 Origin 时放行到路由处理", async () => {
        const app = await loadApp();
        const res = await app.request(endpoint.path, endpoint.init);

        expect(res.status).toBe(endpoint.allowedStatus);
      });

      it("localhost Origin 时放行到路由处理", async () => {
        const app = await loadApp();
        const res = await app.request(
          endpoint.path,
          withOrigin(endpoint.init, "http://localhost:6173"),
        );

        expect(res.status).toBe(endpoint.allowedStatus);
      });
    });
  }
});
